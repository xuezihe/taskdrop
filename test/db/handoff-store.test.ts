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

const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{6}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

async function getBackendPid(pool: Pool): Promise<number> {
  const result = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return result.rows[0]!.pid;
}

async function waitForBackendsWaitingOnLocks(
  observer: Pool,
  backendPids: readonly number[],
  blockerPid: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ waiting: number }>(
      `WITH RECURSIVE blocking_chain(writer_pid, blocker_pid) AS (
         SELECT writer_pid, unnest(pg_blocking_pids(writer_pid))
         FROM unnest($1::int[]) AS writer(writer_pid)
         UNION
         SELECT chain.writer_pid, unnest(pg_blocking_pids(chain.blocker_pid))
         FROM blocking_chain chain
       )
       SELECT count(DISTINCT writer_pid)::int AS waiting
       FROM blocking_chain
       WHERE blocker_pid = $2`,
      [backendPids, blockerPid],
    );
    if (result.rows[0]!.waiting === backendPids.length) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("concurrent append writers were not both blocked by the test row lock");
}

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

  it("allows exactly one of two same-base concurrent appends to commit", async () => {
    const writerPoolA = createPool(DATABASE_URL!);
    const writerPoolB = createPool(DATABASE_URL!);
    const writerA = createHandoffStore(writerPoolA, RETENTION_WINDOW_MS);
    const writerB = createHandoffStore(writerPoolB, RETENTION_WINDOW_MS);
    const blocker = await pool.connect();
    let blockerTransactionOpen = false;
    let attempts: Array<Promise<Awaited<ReturnType<HandoffStore["appendRevision"]>>>> = [];

    try {
      const spaceId = randomBytes(32);
      const originalMarkdown = "same-base original revision";
      const markdownA = "writer A complete snapshot";
      const markdownB = "writer B complete snapshot";
      const created = await store.createHandoff({
        spaceId,
        markdown: originalMarkdown,
        redactionCount: 0,
      });
      assertSnapshot(created);

      const [backendPidA, backendPidB] = await Promise.all([
        getBackendPid(writerPoolA),
        getBackendPid(writerPoolB),
      ]);
      const blockerPid = await blocker.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );

      const initialState = await pool.query<{ revision_count: number }>(
        `SELECT count(*)::int AS revision_count
         FROM revisions
         WHERE space_id = $1 AND handoff_code = $2`,
        [spaceId, created.code],
      );
      expect(initialState.rows[0]!.revision_count).toBe(1);

      await blocker.query("BEGIN");
      blockerTransactionOpen = true;
      await blocker.query(
        `SELECT code
         FROM handoffs
         WHERE space_id = $1 AND code = $2
         FOR UPDATE`,
        [spaceId, created.code],
      );

      attempts = [
        writerA.appendRevision({
          spaceId,
          code: created.code,
          baseRevision: 1,
          markdown: markdownA,
          redactionCount: 0,
        }),
        writerB.appendRevision({
          spaceId,
          code: created.code,
          baseRevision: 1,
          markdown: markdownB,
          redactionCount: 0,
        }),
      ];

      await waitForBackendsWaitingOnLocks(
        pool,
        [backendPidA, backendPidB],
        blockerPid.rows[0]!.pid,
      );
      await blocker.query("COMMIT");
      blockerTransactionOpen = false;

      const results = await Promise.all(attempts);
      const successes = results.filter(isSnapshot);
      const failures = results.filter((result) => !isSnapshot(result));
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      const success = successes[0]!;
      const loserMarkdown = success.markdown === markdownA ? markdownB : markdownA;
      expect([markdownA, markdownB]).toContain(success.markdown);
      expect(failures[0]).toEqual({
        ok: false,
        error: {
          code: "REVISION_CONFLICT",
          expectedRevision: 2,
          receivedBaseRevision: 1,
        },
      });

      const [revision1, revision2, revision3, latest] = await Promise.all([
        store.getHandoff({ spaceId, code: created.code, revision: 1 }),
        store.getHandoff({ spaceId, code: created.code, revision: 2 }),
        store.getHandoff({ spaceId, code: created.code, revision: 3 }),
        store.getHandoff({ spaceId, code: created.code, revision: "latest" }),
      ]);
      assertSnapshot(revision1);
      assertSnapshot(revision2);
      assertSnapshot(latest);

      expect(revision1.markdown).toBe(originalMarkdown);
      expect(revision2.markdown).toBe(success.markdown);
      expect(revision2.markdown).not.toBe(loserMarkdown);
      expect(revision3).toEqual({
        ok: false,
        error: { code: "HANDOFF_NOT_FOUND", handoffCode: created.code },
      });
      expect(latest.revision).toBe(2);
      expect(latest.latestRevision).toBe(2);
      expect(latest.markdown).toBe(success.markdown);
      expect(latest.expiresAt).toBe(success.expiresAt);
      expect(Date.parse(latest.expiresAt)).toBeGreaterThan(Date.parse(created.expiresAt));

      const committedRevisions = await pool.query<{
        revision_count: number;
        loser_markdown_count: number;
      }>(
        `SELECT count(*)::int AS revision_count,
                count(*) FILTER (WHERE markdown = $3)::int AS loser_markdown_count
         FROM revisions
         WHERE space_id = $1 AND handoff_code = $2`,
        [spaceId, created.code, loserMarkdown],
      );
      expect(committedRevisions.rows[0]).toEqual({
        revision_count: 2,
        loser_markdown_count: 0,
      });

      const committedWriter = await pool.query<{
        handoff_xmin: string;
        revision_xmin: string;
      }>(
        `SELECT h.xmin::text AS handoff_xmin, r.xmin::text AS revision_xmin
         FROM handoffs h
         JOIN revisions r
           ON r.space_id = h.space_id
          AND r.handoff_code = h.code
          AND r.revision = 2
         WHERE h.space_id = $1 AND h.code = $2`,
        [spaceId, created.code],
      );
      expect(committedWriter.rows[0]!.handoff_xmin).toBe(
        committedWriter.rows[0]!.revision_xmin,
      );
    } finally {
      try {
        if (blockerTransactionOpen) await blocker.query("ROLLBACK");
      } finally {
        blocker.release();
        await Promise.allSettled(attempts);
        await Promise.all([writerPoolA.end(), writerPoolB.end()]);
      }
    }
  }, 15_000);
});
