import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPool, type Pool } from "../../src/production/db.js";
import {
  createHandoffStore,
  type HandoffStore,
  type RevisionSnapshot,
} from "../../src/production/handoff-store.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const skip = !DATABASE_URL;
const RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function assertSnapshot(value: unknown): asserts value is RevisionSnapshot {
  expect(value).toMatchObject({ ok: true });
}

async function insertExpiredHandoffs(
  pool: Pool,
  spaceId: Uint8Array,
  count: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO handoffs (space_id, code, latest_revision, expires_at)
     SELECT $1, lpad(n::text, 6, '0'), 1, now() - interval '1 hour'
     FROM generate_series(1, $2::int) AS fixture(n)`,
    [spaceId, count],
  );
  await pool.query(
    `INSERT INTO revisions
       (space_id, handoff_code, revision, markdown, created_at, redaction_count, origin)
     SELECT $1, lpad(n::text, 6, '0'), 1, 'expired fixture', now() - interval '2 hours', 0, 'mcp'
     FROM generate_series(1, $2::int) AS fixture(n)`,
    [spaceId, count],
  );
}

describe.skipIf(skip)("expired Handoff cleanup", () => {
  let pool: Pool;
  let store: HandoffStore;

  beforeAll(() => {
    pool = createPool(DATABASE_URL!);
    store = createHandoffStore(pool, RETENTION_WINDOW_MS);
  });

  beforeEach(async () => {
    while ((await store.cleanupExpiredHandoffs()) > 0) {
      // Cleanup is global, so start each tracer after draining historical fixtures.
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  it("deletes expired Handoffs and their Revisions while leaving a live Handoff unchanged", async () => {
    const liveSpaceId = randomBytes(32);
    const expiredSpaceId = randomBytes(32);

    const live = await store.createHandoff({
      spaceId: liveSpaceId,
      markdown: "# Live r1",
      redactionCount: 0,
      origin: "mcp",
    });
    assertSnapshot(live);
    const liveR2 = await store.appendRevision({
      spaceId: liveSpaceId,
      code: live.code,
      baseRevision: 1,
      markdown: "# Live r2",
      redactionCount: 0,
      origin: "mcp",
    });
    assertSnapshot(liveR2);
    await pool.query(
      "UPDATE handoffs SET expires_at = now() + interval '1 minute' WHERE space_id = $1 AND code = $2",
      [liveSpaceId, live.code],
    );

    const expired = await store.createHandoff({
      spaceId: expiredSpaceId,
      markdown: "# Expired r1",
      redactionCount: 0,
      origin: "mcp",
    });
    assertSnapshot(expired);
    const expiredR2 = await store.appendRevision({
      spaceId: expiredSpaceId,
      code: expired.code,
      baseRevision: 1,
      markdown: "# Expired r2",
      redactionCount: 0,
      origin: "mcp",
    });
    assertSnapshot(expiredR2);
    await pool.query(
      "UPDATE handoffs SET expires_at = now() - interval '1 minute' WHERE space_id = $1 AND code = $2",
      [expiredSpaceId, expired.code],
    );

    const liveBeforeCleanup = await store.getHandoff({
      spaceId: liveSpaceId,
      code: live.code,
      revision: "latest",
    });
    assertSnapshot(liveBeforeCleanup);
    const expiredBeforeCleanup = await store.getHandoff({
      spaceId: expiredSpaceId,
      code: expired.code,
      revision: "latest",
    });
    expect(expiredBeforeCleanup).toEqual({
      ok: false,
      error: { code: "HANDOFF_NOT_FOUND", handoffCode: expired.code },
    });

    await expect(store.cleanupExpiredHandoffs()).resolves.toBe(1);

    await expect(
      store.getHandoff({ spaceId: liveSpaceId, code: live.code, revision: "latest" }),
    ).resolves.toEqual(liveBeforeCleanup);
    await expect(
      store.getHandoff({ spaceId: expiredSpaceId, code: expired.code, revision: "latest" }),
    ).resolves.toEqual(expiredBeforeCleanup);

    const physicalRows = await pool.query<{ handoffs: number; revisions: number }>(
      `SELECT
         (SELECT count(*)::int FROM handoffs WHERE space_id = $1) AS handoffs,
         (SELECT count(*)::int FROM revisions WHERE space_id = $1) AS revisions`,
      [expiredSpaceId],
    );
    expect(physicalRows.rows[0]).toEqual({ handoffs: 0, revisions: 0 });
    await expect(store.cleanupExpiredHandoffs()).resolves.toBe(0);
  });

  it("deletes at most 100 expired Handoffs per pass and continues on later passes", async () => {
    const spaceId = randomBytes(32);
    await insertExpiredHandoffs(pool, spaceId, 101);

    await expect(store.cleanupExpiredHandoffs()).resolves.toBe(100);

    const afterFirstPass = await pool.query<{ handoffs: number; revisions: number }>(
      `SELECT
         (SELECT count(*)::int FROM handoffs WHERE space_id = $1) AS handoffs,
         (SELECT count(*)::int FROM revisions WHERE space_id = $1) AS revisions`,
      [spaceId],
    );
    expect(afterFirstPass.rows[0]).toEqual({ handoffs: 1, revisions: 1 });

    await expect(store.cleanupExpiredHandoffs()).resolves.toBe(1);
    await expect(store.cleanupExpiredHandoffs()).resolves.toBe(0);

    const afterFinalPass = await pool.query<{ handoffs: number; revisions: number }>(
      `SELECT
         (SELECT count(*)::int FROM handoffs WHERE space_id = $1) AS handoffs,
         (SELECT count(*)::int FROM revisions WHERE space_id = $1) AS revisions`,
      [spaceId],
    );
    expect(afterFinalPass.rows[0]).toEqual({ handoffs: 0, revisions: 0 });
  });

  it("does not double-count Handoffs across concurrent cleanup passes", async () => {
    const spaceId = randomBytes(32);
    await insertExpiredHandoffs(pool, spaceId, 150);
    const otherPool = createPool(DATABASE_URL!);
    const otherStore = createHandoffStore(otherPool, RETENTION_WINDOW_MS);

    try {
      const counts = await Promise.all([
        store.cleanupExpiredHandoffs(),
        otherStore.cleanupExpiredHandoffs(),
      ]);

      expect(counts[0]! + counts[1]!).toBe(150);
      expect(counts.every((count) => count <= 100)).toBe(true);
      const remaining = await pool.query<{ handoffs: number; revisions: number }>(
        `SELECT
           (SELECT count(*)::int FROM handoffs WHERE space_id = $1) AS handoffs,
           (SELECT count(*)::int FROM revisions WHERE space_id = $1) AS revisions`,
        [spaceId],
      );
      expect(remaining.rows[0]).toEqual({ handoffs: 0, revisions: 0 });
    } finally {
      await otherPool.end();
    }
  });
});
