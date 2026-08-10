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

type PersistedMarkdown = {
  markdown: string;
  markdown_bytes: number;
};

type SpaceWriteCounts = {
  handoff_count: number;
  revision_count: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a structured MCP result");
  }
  return value as Record<string, unknown>;
}

function expectFullRetentionWindow(snapshot: Record<string, unknown>): void {
  expect(Date.parse(String(snapshot.expiresAt)) - Date.parse(String(snapshot.createdAt))).toBe(
    RETENTION_WINDOW_MS,
  );
}

function expectNoRawSpaceKeys(value: unknown, spaceKeys: string[]): void {
  const serialized = JSON.stringify(value);
  for (const spaceKey of spaceKeys) {
    expect(serialized).not.toContain(spaceKey);
  }
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
      expectNoRawSpaceKeys(result, [spaceKey, otherSpaceKey]);

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
      expectFullRetentionWindow(appendedSnapshot);
      expectNoRawSpaceKeys(appended, [spaceKey, otherSpaceKey]);

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
      expectFullRetentionWindow(thirdRevisionSnapshot);

      const latestAfterSecondAppend = await client.callTool({
        name: "get_handoff",
        arguments: { code },
      });
      expect(latestAfterSecondAppend.structuredContent).toEqual(thirdRevisionSnapshot);

      const persistedRedactedRevisions = await pool.query<PersistedRevision>(
        `SELECT revision, markdown, redaction_count
         FROM revisions
         WHERE space_id = $1 AND handoff_code = $2 AND revision IN (1, 2)
         ORDER BY revision`,
        [spaceId, code],
      );

      expect(persistedRedactedRevisions.rows).toEqual([
        {
          revision: 1,
          markdown: sanitizedMarkdown,
          redaction_count: 2,
        },
        {
          revision: 2,
          markdown: sanitizedAppendedMarkdown,
          redaction_count: 2,
        },
      ]);
      expectNoRawSpaceKeys(persistedRedactedRevisions.rows, [spaceKey, otherSpaceKey]);

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

  it("enforces the raw UTF-8 Markdown byte boundary without partial writes", async () => {
    const port = await reservePort();
    const spaceKey = formatSpaceKey(randomBytes(32));
    const spaceId = Buffer.from(await deriveSpaceId(parseSpaceKey(spaceKey)));
    const oversizedCreateMarkdown = `${"A".repeat(262_097)}\n${spaceKey}`;
    const exactLimitMarkdown = `${"界".repeat(87_381)}a`;
    const oversizedAppendMarkdown = `${"界".repeat(87_365)}\n# ${spaceKey}`;
    const config: ProductionConfig = {
      port,
      databaseUrl: DATABASE_URL!,
      retentionWindowMs: RETENTION_WINDOW_MS,
      logLevel: "silent",
    };

    let running: RunningServer | undefined;
    let client: Client | undefined;

    try {
      running = await startProduction(config);
      client = new Client({ name: "taskdrop-size-boundary-e2e", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        { authProvider: { token: async () => spaceKey } },
      );
      await client.connect(transport);

      const oversizedCreate = await client.callTool({
        name: "create_handoff",
        arguments: { markdown: oversizedCreateMarkdown },
      });
      expect(oversizedCreate.isError).toBe(true);
      expect(oversizedCreate.structuredContent).toEqual({
        ok: false,
        error: { code: "CONTENT_TOO_LARGE", limitBytes: 262_144 },
      });

      const countsAfterRejectedCreate = await pool.query<SpaceWriteCounts>(
        `SELECT
           (SELECT count(*)::int FROM handoffs WHERE space_id = $1) AS handoff_count,
           (SELECT count(*)::int FROM revisions WHERE space_id = $1) AS revision_count`,
        [spaceId],
      );
      expect(countsAfterRejectedCreate.rows).toEqual([
        { handoff_count: 0, revision_count: 0 },
      ]);

      const exactLimitCreate = await client.callTool({
        name: "create_handoff",
        arguments: { markdown: exactLimitMarkdown },
      });
      const exactLimitSnapshot = asRecord(exactLimitCreate.structuredContent);
      const code = String(exactLimitSnapshot.code);
      expect(exactLimitSnapshot).toMatchObject({
        ok: true,
        revision: 1,
        latestRevision: 1,
        markdown: exactLimitMarkdown,
      });

      const persistedExactLimit = await pool.query<PersistedMarkdown>(
        `SELECT markdown, octet_length(markdown)::int AS markdown_bytes
         FROM revisions
         WHERE space_id = $1 AND handoff_code = $2 AND revision = 1`,
        [spaceId, code],
      );
      expect(persistedExactLimit.rows).toEqual([
        { markdown: exactLimitMarkdown, markdown_bytes: 262_144 },
      ]);

      const stateBeforeRejectedAppend = await pool.query<PersistedHandoffState>(
        `SELECT h.latest_revision, h.expires_at, count(r.revision)::int AS revision_count
         FROM handoffs h
         JOIN revisions r ON r.space_id = h.space_id AND r.handoff_code = h.code
         WHERE h.space_id = $1 AND h.code = $2
         GROUP BY h.latest_revision, h.expires_at`,
        [spaceId, code],
      );

      const oversizedAppend = await client.callTool({
        name: "append_revision",
        arguments: {
          code,
          baseRevision: 1,
          markdown: oversizedAppendMarkdown,
        },
      });
      expect(oversizedAppend.isError).toBe(true);
      expect(oversizedAppend.structuredContent).toEqual({
        ok: false,
        error: { code: "CONTENT_TOO_LARGE", limitBytes: 262_144 },
      });

      const stateAfterRejectedAppend = await pool.query<PersistedHandoffState>(
        `SELECT h.latest_revision, h.expires_at, count(r.revision)::int AS revision_count
         FROM handoffs h
         JOIN revisions r ON r.space_id = h.space_id AND r.handoff_code = h.code
         WHERE h.space_id = $1 AND h.code = $2
         GROUP BY h.latest_revision, h.expires_at`,
        [spaceId, code],
      );
      expect(stateAfterRejectedAppend.rows).toEqual(stateBeforeRejectedAppend.rows);
    } finally {
      await client?.close().catch(() => undefined);
      await running?.shutdown().catch(() => undefined);
      await pool.query("DELETE FROM handoffs WHERE space_id = $1", [spaceId]);
    }
  }, 25_000);

  it("rejects Revision 26 through MCP without changing the Handoff", async () => {
    const port = await reservePort();
    const spaceKey = formatSpaceKey(randomBytes(32));
    const spaceId = Buffer.from(await deriveSpaceId(parseSpaceKey(spaceKey)));
    const config: ProductionConfig = {
      port,
      databaseUrl: DATABASE_URL!,
      retentionWindowMs: RETENTION_WINDOW_MS,
      logLevel: "silent",
    };

    let running: RunningServer | undefined;
    let client: Client | undefined;

    try {
      running = await startProduction(config);
      client = new Client({ name: "taskdrop-revision-limit-e2e", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        { authProvider: { token: async () => spaceKey } },
      );
      await client.connect(transport);

      const created = await client.callTool({
        name: "create_handoff",
        arguments: { markdown: "# Revision 1" },
      });
      const code = String(asRecord(created.structuredContent).code);

      await pool.query(
        `WITH inserted AS (
           INSERT INTO revisions
             (space_id, handoff_code, revision, markdown, created_at, redaction_count)
           SELECT $1, $2, revision, '# Revision ' || revision, now(), 0
           FROM generate_series(2, 25) AS revision
           RETURNING revision
         )
         UPDATE handoffs
         SET latest_revision = 25
         WHERE space_id = $1 AND code = $2
           AND (SELECT count(*) FROM inserted) = 24`,
        [spaceId, code],
      );

      const stateBeforeLimit = await pool.query<PersistedHandoffState>(
        `SELECT h.latest_revision, h.expires_at, count(r.revision)::int AS revision_count
         FROM handoffs h
         JOIN revisions r ON r.space_id = h.space_id AND r.handoff_code = h.code
         WHERE h.space_id = $1 AND h.code = $2
         GROUP BY h.latest_revision, h.expires_at`,
        [spaceId, code],
      );
      expect(stateBeforeLimit.rows).toMatchObject([
        { latest_revision: 25, revision_count: 25 },
      ]);

      const rejected = await client.callTool({
        name: "append_revision",
        arguments: {
          code,
          baseRevision: 25,
          markdown: "# Revision 26 must be rejected",
        },
      });
      expect(rejected.isError).toBe(true);
      expect(rejected.structuredContent).toEqual({
        ok: false,
        error: { code: "REVISION_LIMIT_REACHED", limit: 25 },
      });

      const stateAfterLimit = await pool.query<PersistedHandoffState>(
        `SELECT h.latest_revision, h.expires_at, count(r.revision)::int AS revision_count
         FROM handoffs h
         JOIN revisions r ON r.space_id = h.space_id AND r.handoff_code = h.code
         WHERE h.space_id = $1 AND h.code = $2
         GROUP BY h.latest_revision, h.expires_at`,
        [spaceId, code],
      );
      expect(stateAfterLimit.rows).toEqual(stateBeforeLimit.rows);
    } finally {
      await client?.close().catch(() => undefined);
      await running?.shutdown().catch(() => undefined);
      await pool.query("DELETE FROM handoffs WHERE space_id = $1", [spaceId]);
    }
  }, 25_000);
});
