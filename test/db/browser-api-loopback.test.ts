import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProductionConfig } from "../../src/production/config.js";
import { createPool, type Pool } from "../../src/production/db.js";
import { createHandoffStore } from "../../src/production/handoff-store.js";
import { MAX_MARKDOWN_BYTES } from "../../src/production/handoff-limits.js";
import { startProduction, type RunningServer } from "../../src/production/runtime.js";
import {
  deriveSpaceId,
  formatSpaceKey,
  parseSpaceKey,
} from "../../src/production/space-identity.js";

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
    await closeServer(server);
    throw new Error("Could not reserve a local test port");
  }
  await closeServer(server);
  return address.port;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe.skipIf(skip)("Production Browser API loopback", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("serves committed reads and append through the authenticated runtime", async () => {
    const port = await reservePort();
    const spaceKey = formatSpaceKey(randomBytes(32));
    const otherSpaceKey = formatSpaceKey(randomBytes(32));
    const spaceId = await deriveSpaceId(parseSpaceKey(spaceKey));
    const otherSpaceId = await deriveSpaceId(parseSpaceKey(otherSpaceKey));
    const store = createHandoffStore(pool, RETENTION_WINDOW_MS);
    const created = await store.createHandoff({
      spaceId,
      markdown: "# Initial Revision",
      redactionCount: 0,
      origin: "mcp",
    });
    if (!created.ok) throw new Error("Expected the fixture Handoff to be created");

    const config: ProductionConfig = {
      port,
      databaseUrl: DATABASE_URL!,
      retentionWindowMs: RETENTION_WINDOW_MS,
      logLevel: "silent",
    };
    let running: RunningServer | undefined;

    try {
      running = await startProduction(config);
      const endpoint = `http://${running.host}:${running.port}`;
      const headers = { authorization: `Bearer ${spaceKey}` };

      const health = await fetch(`${endpoint}/health`);
      expect(health.status).toBe(200);
      await expect(readJson(health)).resolves.toEqual({ status: "ok" });

      const current = await fetch(`${endpoint}/api/handoffs/${created.code}`, { headers });
      expect(current.status).toBe(200);
      await expect(readJson(current)).resolves.toMatchObject({
        ok: true,
        code: created.code,
        revision: 1,
        latestRevision: 1,
        markdown: "# Initial Revision",
        origin: "mcp",
      });

      const revisionHistory = await fetch(`${endpoint}/api/handoffs/${created.code}/revisions`, {
        headers,
      });
      expect(revisionHistory.status).toBe(200);
      await expect(readJson(revisionHistory)).resolves.toMatchObject({
        ok: true,
        code: created.code,
        latestRevision: 1,
        revisions: [{ revision: 1, origin: "mcp" }],
      });

      const historical = await fetch(`${endpoint}/api/handoffs/${created.code}/revisions/1`, {
        headers,
      });
      expect(historical.status).toBe(200);
      await expect(readJson(historical)).resolves.toMatchObject({
        ok: true,
        revision: 1,
        isLatest: true,
        origin: "mcp",
      });

      const append = await fetch(`${endpoint}/api/handoffs/${created.code}/revisions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 1,
          markdown: "# WebMCP Revision",
          origin: "webmcp",
        }),
      });
      expect(append.status).toBe(200);
      await expect(readJson(append)).resolves.toMatchObject({
        ok: true,
        revision: 2,
        latestRevision: 2,
        markdown: "# WebMCP Revision",
        origin: "webmcp",
      });

      const expiryBeforeConflict = await pool.query<{ expires_at: Date }>(
        "SELECT expires_at FROM handoffs WHERE space_id = $1 AND code = $2",
        [spaceId, created.code],
      );
      const conflict = await fetch(`${endpoint}/api/handoffs/${created.code}/revisions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 1,
          markdown: "# Stale Revision",
          origin: "human",
        }),
      });
      expect(conflict.status).toBe(409);
      await expect(readJson(conflict)).resolves.toEqual({
        ok: false,
        error: { code: "REVISION_CONFLICT", expectedRevision: 2, receivedBaseRevision: 1 },
      });

      const latestAfterConflict = await store.getHandoff({
        spaceId,
        code: created.code,
        revision: "latest",
      });
      expect(latestAfterConflict).toMatchObject({
        ok: true,
        revision: 2,
        markdown: "# WebMCP Revision",
      });
      const expiryAfterConflict = await pool.query<{ expires_at: Date }>(
        "SELECT expires_at FROM handoffs WHERE space_id = $1 AND code = $2",
        [spaceId, created.code],
      );
      expect(expiryAfterConflict.rows[0]!.expires_at.getTime()).toBe(
        expiryBeforeConflict.rows[0]!.expires_at.getTime(),
      );

      const isolated = await fetch(`${endpoint}/api/handoffs/${created.code}`, {
        headers: { authorization: `Bearer ${otherSpaceKey}` },
      });
      expect(isolated.status).toBe(404);
      await expect(readJson(isolated)).resolves.toEqual({
        ok: false,
        error: { code: "HANDOFF_NOT_FOUND", handoffCode: created.code },
      });

      const queryCredential = await fetch(
        `${endpoint}/api/handoffs/${created.code}?taskdropKey=${spaceKey}`,
      );
      expect(queryCredential.status).toBe(401);
      await expect(readJson(queryCredential)).resolves.toEqual({
        ok: false,
        error: { code: "UNAUTHORIZED" },
      });

      const oversized = await fetch(`${endpoint}/api/handoffs/${created.code}/revisions`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          baseRevision: 2,
          markdown: "x".repeat(MAX_MARKDOWN_BYTES + 1),
          origin: "human",
        }),
      });
      expect(oversized.status).toBe(413);
      await expect(readJson(oversized)).resolves.toEqual({
        ok: false,
        error: { code: "CONTENT_TOO_LARGE", limitBytes: MAX_MARKDOWN_BYTES },
      });

      const unmatched = await fetch(`${endpoint}/unmatched`);
      expect(unmatched.status).toBe(404);
      await expect(unmatched.text()).resolves.toBe('{"error":"not_found"}');

      await pool.query(
        "UPDATE handoffs SET expires_at = now() - interval '1 second' WHERE space_id = $1 AND code = $2",
        [spaceId, created.code],
      );
      const expired = await fetch(`${endpoint}/api/handoffs/${created.code}/revisions`, {
        headers,
      });
      expect(expired.status).toBe(404);
      await expect(readJson(expired)).resolves.toEqual({
        ok: false,
        error: { code: "HANDOFF_NOT_FOUND", handoffCode: created.code },
      });
    } finally {
      await running?.shutdown().catch(() => undefined);
      await pool.query("DELETE FROM handoffs WHERE space_id = $1 OR space_id = $2", [
        spaceId,
        otherSpaceId,
      ]);
    }
  });
});
