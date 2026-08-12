import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProductionConfig } from "../../src/production/config.js";
import { createPool, type Pool, withTransaction } from "../../src/production/db.js";
import { createHandoffStore } from "../../src/production/handoff-store.js";
import { startProduction, type RunningServer } from "../../src/production/runtime.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const skip = !DATABASE_URL;
const RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

describe.skipIf(skip)("Production expired Handoff cleanup wiring", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("starts cleanup after listener readiness without affecting health or live Handoffs", async () => {
    const port = await reservePort();
    const liveSpaceId = randomBytes(32);
    const expiredSpaceId = randomBytes(32);
    const liveCode = "LIVE19";
    const expiredCode = "DEAD19";
    const config: ProductionConfig = {
      port,
      databaseUrl: DATABASE_URL!,
      retentionWindowMs: RETENTION_WINDOW_MS,
      logLevel: "silent",
    };
    let running: RunningServer | undefined;

    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO handoffs (space_id, code, latest_revision, expires_at)
         VALUES ($1, $2, 1, now() + interval '1 hour'),
                ($3, $4, 1, now() - interval '1 hour')`,
        [liveSpaceId, liveCode, expiredSpaceId, expiredCode],
      );
      await client.query(
        `INSERT INTO revisions
           (space_id, handoff_code, revision, markdown, created_at, redaction_count)
         VALUES ($1, $2, 1, '# Live', now(), 0),
                ($3, $4, 1, '# Expired', now() - interval '2 hours', 0)`,
        [liveSpaceId, liveCode, expiredSpaceId, expiredCode],
      );
    });

    try {
      running = await startProduction(config);

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ status: "ok" });

      await expect
        .poll(
          async () => {
            const result = await pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM handoffs WHERE space_id = $1 AND code = $2",
              [expiredSpaceId, expiredCode],
            );
            return result.rows[0]!.count;
          },
          { timeout: 2_000, interval: 10 },
        )
        .toBe(0);

      const store = createHandoffStore(pool, RETENTION_WINDOW_MS);
      await expect(
        store.getHandoff({ spaceId: liveSpaceId, code: liveCode, revision: "latest" }),
      ).resolves.toMatchObject({ ok: true, code: liveCode, markdown: "# Live" });
    } finally {
      await running?.shutdown().catch(() => undefined);
      await pool.query("DELETE FROM handoffs WHERE space_id = $1 OR space_id = $2", [
        liveSpaceId,
        expiredSpaceId,
      ]);
    }
  });
});
