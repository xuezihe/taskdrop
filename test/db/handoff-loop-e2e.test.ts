import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type ProductionConfig } from "../../src/production/config.js";
import { createPool, type Pool } from "../../src/production/db.js";
import { REDACTED_SPACE_KEY_PLACEHOLDER } from "../../src/production/redaction.js";
import { startProduction, type RunningServer } from "../../src/production/runtime.js";
import {
  deriveSpaceId,
  formatSpaceKey,
  parseSpaceKey,
} from "../../src/production/space-identity.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const skip = !DATABASE_URL;
const RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type PersistedRevision = {
  markdown: string;
  redaction_count: number;
  revision: number;
};

type PersistedHandoffState = {
  expires_at: Date;
  latest_revision: number;
  revision_count: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a structured MCP result");
  }
  return value as Record<string, unknown>;
}

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

describe.skipIf(skip)("Production handoff-loop endpoint", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("repeats the create/get/append loop through MCP and rejects a stale append atomically", async () => {
    const port = await reservePort();
    const restartedPort = await reservePort();
    const spaceKey = formatSpaceKey(randomBytes(32));
    const otherSpaceKey = formatSpaceKey(randomBytes(32));
    const spaceId = Buffer.from(await deriveSpaceId(parseSpaceKey(spaceKey)));
    const config: ProductionConfig = {
      port,
      databaseUrl: DATABASE_URL!,
      retentionWindowMs: RETENTION_WINDOW_MS,
      logLevel: "silent",
    };
    const markdown = [
      "# First production handoff",
      "",
      `Authenticating Key: ${spaceKey}`,
      `Another Key: ${otherSpaceKey}`,
    ].join("\n");
    const sanitizedMarkdown = [
      "# First production handoff",
      "",
      `Authenticating Key: ${REDACTED_SPACE_KEY_PLACEHOLDER}`,
      `Another Key: ${REDACTED_SPACE_KEY_PLACEHOLDER}`,
    ].join("\n");
    const appendedMarkdown = [
      "# Second production revision",
      "",
      `Authenticating Key: ${spaceKey}`,
      `Another Key: ${otherSpaceKey}`,
    ].join("\n");
    const sanitizedAppendedMarkdown = [
      "# Second production revision",
      "",
      `Authenticating Key: ${REDACTED_SPACE_KEY_PLACEHOLDER}`,
      `Another Key: ${REDACTED_SPACE_KEY_PLACEHOLDER}`,
    ].join("\n");
    const thirdRevisionMarkdown = "# Third production revision\n\nready for another client";

    let running: RunningServer | undefined;
    let restarted: RunningServer | undefined;
    let client: Client | undefined;
    let code: string | undefined;
    let createdSnapshot: Record<string, unknown> | undefined;

    try {
      running = await startProduction(config);
      client = new Client({ name: "taskdrop-create-e2e", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        { authProvider: { token: async () => spaceKey } },
      );
      await client.connect(transport);

      const result = await client.callTool({
        name: "create_handoff",
        arguments: { markdown },
      });
      const snapshot = asRecord(result.structuredContent);
      createdSnapshot = snapshot;
      code = String(snapshot.code);

      expect(snapshot).toMatchObject({
        ok: true,
        code: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{6}$/),
        revision: 1,
        latestRevision: 1,
        isLatest: true,
        markdown: sanitizedMarkdown,
        contentSanitized: true,
        redactionCount: 2,
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
      });
      expect(Number.isNaN(Date.parse(String(snapshot.createdAt)))).toBe(false);
      expect(Number.isNaN(Date.parse(String(snapshot.expiresAt)))).toBe(false);
      expect(JSON.stringify(result)).not.toContain(spaceKey);
      expect(JSON.stringify(result)).not.toContain(otherSpaceKey);

      await client.close();
      client = undefined;
      await running.shutdown();
      running = undefined;

      restarted = await startProduction({ ...config, port: restartedPort });
      if (!createdSnapshot || !code) {
        throw new Error("Expected create_handoff to return a snapshot and Code");
      }

      client = new Client({ name: "taskdrop-get-e2e", version: "0.0.0" });
      const queryTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${restartedPort}/mcp?taskdropKey=${spaceKey}`),
      );
      await client.connect(queryTransport);

      const read = await client.callTool({
        name: "get_handoff",
        arguments: { code },
      });

      expect(read.structuredContent).toEqual(createdSnapshot);

      const appended = await client.callTool({
        name: "append_revision",
        arguments: {
          code,
          baseRevision: 1,
          markdown: appendedMarkdown,
        },
      });
      const appendedSnapshot = asRecord(appended.structuredContent);
      expect(appendedSnapshot).toMatchObject({
        ok: true,
        code,
        revision: 2,
        latestRevision: 2,
        isLatest: true,
        markdown: sanitizedAppendedMarkdown,
        contentSanitized: true,
        redactionCount: 2,
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
      });
      expect(
        Date.parse(String(appendedSnapshot.expiresAt)) -
          Date.parse(String(appendedSnapshot.createdAt)),
      ).toBe(RETENTION_WINDOW_MS);
      expect(JSON.stringify(appended)).not.toContain(spaceKey);
      expect(JSON.stringify(appended)).not.toContain(otherSpaceKey);

      const latestAfterAppend = await client.callTool({
        name: "get_handoff",
        arguments: { code },
      });
      expect(latestAfterAppend.structuredContent).toEqual(appendedSnapshot);

      const appendedAgain = await client.callTool({
        name: "append_revision",
        arguments: {
          code,
          baseRevision: 2,
          markdown: thirdRevisionMarkdown,
        },
      });
      const thirdRevisionSnapshot = asRecord(appendedAgain.structuredContent);
      expect(thirdRevisionSnapshot).toMatchObject({
        ok: true,
        code,
        revision: 3,
        latestRevision: 3,
        isLatest: true,
        markdown: thirdRevisionMarkdown,
        contentSanitized: false,
        redactionCount: 0,
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
      });
      expect(
        Date.parse(String(thirdRevisionSnapshot.expiresAt)) -
          Date.parse(String(thirdRevisionSnapshot.createdAt)),
      ).toBe(RETENTION_WINDOW_MS);

      const latestAfterSecondAppend = await client.callTool({
        name: "get_handoff",
        arguments: { code },
      });
      expect(latestAfterSecondAppend.structuredContent).toEqual(thirdRevisionSnapshot);

      const persistedAppend = await pool.query<PersistedRevision>(
        `SELECT revision, markdown, redaction_count
         FROM revisions
         WHERE space_id = $1 AND handoff_code = $2 AND revision = 2`,
        [spaceId, code],
      );

      expect(persistedAppend.rows).toEqual([
        {
          revision: 2,
          markdown: sanitizedAppendedMarkdown,
          redaction_count: 2,
        },
      ]);
      expect(JSON.stringify(persistedAppend.rows)).not.toContain(spaceKey);
      expect(JSON.stringify(persistedAppend.rows)).not.toContain(otherSpaceKey);

      const stateBeforeConflict = await pool.query<PersistedHandoffState>(
        `SELECT h.latest_revision, h.expires_at, count(r.revision)::int AS revision_count
         FROM handoffs h
         JOIN revisions r ON r.space_id = h.space_id AND r.handoff_code = h.code
         WHERE h.space_id = $1 AND h.code = $2
         GROUP BY h.latest_revision, h.expires_at`,
        [spaceId, code],
      );
      expect(stateBeforeConflict.rows).toHaveLength(1);

      const stale = await client.callTool({
        name: "append_revision",
        arguments: {
          code,
          baseRevision: 2,
          markdown: "# Stale revision\n\nthis must not be stored",
        },
      });
      expect(stale.isError).toBe(true);
      expect(stale.structuredContent).toEqual({
        ok: false,
        error: {
          code: "REVISION_CONFLICT",
          expectedRevision: 3,
          receivedBaseRevision: 2,
        },
      });

      const stateAfterConflict = await pool.query<PersistedHandoffState>(
        `SELECT h.latest_revision, h.expires_at, count(r.revision)::int AS revision_count
         FROM handoffs h
         JOIN revisions r ON r.space_id = h.space_id AND r.handoff_code = h.code
         WHERE h.space_id = $1 AND h.code = $2
         GROUP BY h.latest_revision, h.expires_at`,
        [spaceId, code],
      );
      expect(stateAfterConflict.rows).toEqual(stateBeforeConflict.rows);

      const latestAfterConflict = await client.callTool({
        name: "get_handoff",
        arguments: { code },
      });
      expect(latestAfterConflict.structuredContent).toEqual(thirdRevisionSnapshot);
    } finally {
      await client?.close().catch(() => undefined);
      await running?.shutdown().catch(() => undefined);
      await restarted?.shutdown().catch(() => undefined);
      if (code) {
        await pool.query("DELETE FROM handoffs WHERE space_id = $1 AND code = $2", [
          spaceId,
          code,
        ]);
      }
    }
  }, 25_000);
});
