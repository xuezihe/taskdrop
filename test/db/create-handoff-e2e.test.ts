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

describe.skipIf(skip)("Production create_handoff endpoint", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates sanitized Revision 1 over HTTP and retains it across an Application restart", async () => {
    const port = await reservePort();
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

    let running: RunningServer | undefined;
    let restarted: RunningServer | undefined;
    let client: Client | undefined;
    let code: string | undefined;

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

      restarted = await startProduction(config);
      const persisted = await pool.query<PersistedRevision>(
        `SELECT revision, markdown, redaction_count
         FROM revisions
         WHERE space_id = $1 AND handoff_code = $2 AND revision = 1`,
        [spaceId, code],
      );

      expect(persisted.rows).toEqual([
        {
          revision: 1,
          markdown: sanitizedMarkdown,
          redaction_count: 2,
        },
      ]);
      expect(JSON.stringify(persisted.rows)).not.toContain(spaceKey);
      expect(JSON.stringify(persisted.rows)).not.toContain(otherSpaceKey);
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
  }, 20_000);
});
