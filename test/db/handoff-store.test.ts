import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, type Pool } from "../../src/production/db.js";
import {
  createHandoffStore,
  type HandoffStore,
  type RevisionSnapshot,
} from "../../src/production/handoff-store.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const skip = !DATABASE_URL;
const RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function isSnapshot(r: unknown): r is RevisionSnapshot {
  return typeof r === "object" && r !== null && (r as { ok?: boolean }).ok === true;
}

function assertSnapshot(r: unknown): asserts r is RevisionSnapshot {
  expect(isSnapshot(r)).toBe(true);
}

const CODE_PATTERN = /^[A-Z0-9]{6}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

describe.skipIf(skip)("HandoffStore revision loop", () => {
  let pool: Pool;
  let store: HandoffStore;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    store = createHandoffStore(pool, RETENTION_WINDOW_MS);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("completes create → get latest → get r1 → append r2 → get latest → get r1 immutable → get r2", async () => {
    const spaceId = randomBytes(32);
    const md1 = "# Revision one\n\nfirst checkpoint";
    const md2 = "# Revision two\n\nupdated checkpoint";

    const created = await store.createHandoff({
      spaceId,
      markdown: md1,
      redactionCount: 0,
    });
    assertSnapshot(created);
    expect(created.ok).toBe(true);
    expect(created.code).toMatch(CODE_PATTERN);
    expect(created.revision).toBe(1);
    expect(created.latestRevision).toBe(1);
    expect(created.isLatest).toBe(true);
    expect(created.markdown).toBe(md1);
    expect(created.redactionCount).toBe(0);
    expect(created.contentSanitized).toBe(false);
    expect(created.createdAt).toMatch(RFC3339);
    expect(created.expiresAt).toMatch(RFC3339);

    const latestAfterCreate = await store.getHandoff({
      spaceId,
      code: created.code,
      revision: "latest",
    });
    assertSnapshot(latestAfterCreate);
    expect(latestAfterCreate.revision).toBe(1);
    expect(latestAfterCreate.isLatest).toBe(true);
    expect(latestAfterCreate.markdown).toBe(md1);
    expect(latestAfterCreate.code).toBe(created.code);
    expect(latestAfterCreate.createdAt).toBe(created.createdAt);
    expect(latestAfterCreate.expiresAt).toBe(created.expiresAt);

    const r1 = await store.getHandoff({
      spaceId,
      code: created.code,
      revision: 1,
    });
    assertSnapshot(r1);
    expect(r1.revision).toBe(1);
    expect(r1.isLatest).toBe(true);
    expect(r1.markdown).toBe(md1);

    const appended = await store.appendRevision({
      spaceId,
      code: created.code,
      baseRevision: 1,
      markdown: md2,
      redactionCount: 0,
    });
    assertSnapshot(appended);
    expect(appended.code).toBe(created.code);
    expect(appended.revision).toBe(2);
    expect(appended.latestRevision).toBe(2);
    expect(appended.isLatest).toBe(true);
    expect(appended.markdown).toBe(md2);

    const latestAfterAppend = await store.getHandoff({
      spaceId,
      code: created.code,
      revision: "latest",
    });
    assertSnapshot(latestAfterAppend);
    expect(latestAfterAppend.revision).toBe(2);
    expect(latestAfterAppend.latestRevision).toBe(2);
    expect(latestAfterAppend.isLatest).toBe(true);
    expect(latestAfterAppend.markdown).toBe(md2);

    const r1AfterAppend = await store.getHandoff({
      spaceId,
      code: created.code,
      revision: 1,
    });
    assertSnapshot(r1AfterAppend);
    expect(r1AfterAppend.revision).toBe(1);
    expect(r1AfterAppend.latestRevision).toBe(2);
    expect(r1AfterAppend.isLatest).toBe(false);
    expect(r1AfterAppend.markdown).toBe(md1);
    expect(r1AfterAppend.createdAt).toBe(created.createdAt);

    const r2 = await store.getHandoff({
      spaceId,
      code: created.code,
      revision: 2,
    });
    assertSnapshot(r2);
    expect(r2.revision).toBe(2);
    expect(r2.isLatest).toBe(true);
    expect(r2.markdown).toBe(md2);
    expect(r2.createdAt).toBe(appended.createdAt);
  });

  it("stale append returns REVISION_CONFLICT with no mutation and no expiry refresh", async () => {
    const spaceId = randomBytes(32);
    const created = await store.createHandoff({
      spaceId,
      markdown: "stale-base r1",
      redactionCount: 0,
    });
    assertSnapshot(created);

    const appended = await store.appendRevision({
      spaceId,
      code: created.code,
      baseRevision: 1,
      markdown: "stale-base r2",
      redactionCount: 0,
    });
    assertSnapshot(appended);
    expect(appended.revision).toBe(2);

    const expiryRow = await pool.query(
      "SELECT expires_at FROM handoffs WHERE space_id = $1 AND code = $2",
      [spaceId, created.code],
    );
    const expiresAtBefore = expiryRow.rows[0]!.expires_at as Date;

    const stale = await store.appendRevision({
      spaceId,
      code: created.code,
      baseRevision: 1,
      markdown: "stale-base r3 should not exist",
      redactionCount: 0,
    });
    expect(isSnapshot(stale)).toBe(false);
    expect(stale).toEqual({
      ok: false,
      error: {
        code: "REVISION_CONFLICT",
        expectedRevision: 2,
        receivedBaseRevision: 1,
      },
    });

    const revisions = await pool.query(
      "SELECT revision FROM revisions WHERE space_id = $1 AND handoff_code = $2 ORDER BY revision",
      [spaceId, created.code],
    );
    expect(revisions.rows.map((r: { revision: number }) => r.revision)).toEqual([1, 2]);

    const latestRow = await pool.query(
      "SELECT latest_revision FROM handoffs WHERE space_id = $1 AND code = $2",
      [spaceId, created.code],
    );
    expect(latestRow.rows[0]!.latest_revision).toBe(2);

    const expiryRowAfter = await pool.query(
      "SELECT expires_at FROM handoffs WHERE space_id = $1 AND code = $2",
      [spaceId, created.code],
    );
    expect(expiryRowAfter.rows[0]!.expires_at).toEqual(expiresAtBefore);
  });

  it("returns HANDOFF_NOT_FOUND indistinguishably for unknown, cross-Space, expired, and append to expired/unknown", async () => {
    const spaceId = randomBytes(32);
    const otherSpaceId = randomBytes(32);
    const created = await store.createHandoff({
      spaceId,
      markdown: "not-found r1",
      redactionCount: 0,
    });
    assertSnapshot(created);

    const unknown = await store.getHandoff({
      spaceId,
      code: "ZZZZZZ",
      revision: "latest",
    });
    expect(unknown).toEqual({
      ok: false,
      error: { code: "HANDOFF_NOT_FOUND", handoffCode: "ZZZZZZ" },
    });

    const crossSpace = await store.getHandoff({
      spaceId: otherSpaceId,
      code: created.code,
      revision: "latest",
    });
    expect(crossSpace).toEqual({
      ok: false,
      error: { code: "HANDOFF_NOT_FOUND", handoffCode: created.code },
    });

    await pool.query(
      "UPDATE handoffs SET expires_at = now() - interval '1 second' WHERE space_id = $1 AND code = $2",
      [spaceId, created.code],
    );

    const expiredRead = await store.getHandoff({
      spaceId,
      code: created.code,
      revision: "latest",
    });
    expect(expiredRead).toEqual({
      ok: false,
      error: { code: "HANDOFF_NOT_FOUND", handoffCode: created.code },
    });

    const expiredAppend = await store.appendRevision({
      spaceId,
      code: created.code,
      baseRevision: 1,
      markdown: "should not append to expired",
      redactionCount: 0,
    });
    expect(expiredAppend).toEqual({
      ok: false,
      error: { code: "HANDOFF_NOT_FOUND", handoffCode: created.code },
    });

    const appendUnknown = await store.appendRevision({
      spaceId,
      code: "ZZZZZZ",
      baseRevision: 1,
      markdown: "should not append to unknown",
      redactionCount: 0,
    });
    expect(appendUnknown).toEqual({
      ok: false,
      error: { code: "HANDOFF_NOT_FOUND", handoffCode: "ZZZZZZ" },
    });
  });

  it("uses PostgreSQL time and refreshes expiry only on successful append, not on read or failed append", async () => {
    const spaceId = randomBytes(32);
    const created = await store.createHandoff({
      spaceId,
      markdown: "expiry r1",
      redactionCount: 0,
    });
    assertSnapshot(created);

    const createdTs = Date.parse(created.createdAt);
    const expiresTs = Date.parse(created.expiresAt);
    expect(expiresTs - createdTs).toBe(RETENTION_WINDOW_MS);
    expect(Math.abs(createdTs - Date.now())).toBeLessThan(10_000);

    const expiresRow1 = await pool.query(
      "SELECT expires_at FROM handoffs WHERE space_id = $1 AND code = $2",
      [spaceId, created.code],
    );
    const expiresAtBeforeReads = expiresRow1.rows[0]!.expires_at as Date;

    for (let i = 0; i < 3; i++) {
      await store.getHandoff({ spaceId, code: created.code, revision: "latest" });
      await store.getHandoff({ spaceId, code: created.code, revision: 1 });
    }
    const expiresRow2 = await pool.query(
      "SELECT expires_at FROM handoffs WHERE space_id = $1 AND code = $2",
      [spaceId, created.code],
    );
    expect(expiresRow2.rows[0]!.expires_at).toEqual(expiresAtBeforeReads);

    const appended = await store.appendRevision({
      spaceId,
      code: created.code,
      baseRevision: 1,
      markdown: "expiry r2",
      redactionCount: 0,
    });
    assertSnapshot(appended);

    const appendedExpiresTs = Date.parse(appended.expiresAt);
    const appendedCreatedTs = Date.parse(appended.createdAt);
    expect(appendedExpiresTs - appendedCreatedTs).toBe(RETENTION_WINDOW_MS);
    expect(appendedCreatedTs).toBeGreaterThan(createdTs);
    expect(appendedExpiresTs).toBeGreaterThan(expiresTs);

    const expiresRow3 = await pool.query(
      "SELECT expires_at FROM handoffs WHERE space_id = $1 AND code = $2",
      [spaceId, created.code],
    );
    const expiresAtAfterAppend = expiresRow3.rows[0]!.expires_at as Date;
    expect(expiresAtAfterAppend.getTime()).toBeGreaterThan(expiresAtBeforeReads.getTime());

    const expiresAtBeforeConflict = expiresAtAfterAppend;
    const stale = await store.appendRevision({
      spaceId,
      code: created.code,
      baseRevision: 1,
      markdown: "expiry stale",
      redactionCount: 0,
    });
    expect(isSnapshot(stale)).toBe(false);

    const expiresRow4 = await pool.query(
      "SELECT expires_at FROM handoffs WHERE space_id = $1 AND code = $2",
      [spaceId, created.code],
    );
    expect(expiresRow4.rows[0]!.expires_at).toEqual(expiresAtBeforeConflict);
  });
});
