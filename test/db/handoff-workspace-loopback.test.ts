import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProductionConfig } from "../../src/production/config.js";
import { createPool, type Pool } from "../../src/production/db.js";
import { createHandoffStore } from "../../src/production/handoff-store.js";
import { startProduction, type RunningServer } from "../../src/production/runtime.js";
import {
  deriveSpaceId,
  formatSpaceKey,
  parseSpaceKey,
} from "../../src/production/space-identity.js";
import { createBrowserApiClient } from "../../web/browser-api-client.js";
import { createSessionWorkingDraftStorage } from "../../web/handoff-session-storage.js";
import { createHandoffWorkspaceController } from "../../web/handoff-workspace-controller.js";
import { createHandoffWebMcpTools, type HandoffWebMcpTool } from "../../web/webmcp-tools.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const skip = !DATABASE_URL;
const RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
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

function webMcpTool(tools: readonly HandoffWebMcpTool[], name: string): HandoffWebMcpTool {
  const selected = tools.find((tool) => tool.name === name);
  if (!selected) throw new Error(`Expected ${name} to be registered`);
  return selected;
}

function executeWebMcpTool(tool: HandoffWebMcpTool, input: unknown): Promise<unknown> {
  return tool.execute(input, { signal: new AbortController().signal });
}

describe.skipIf(skip)("Human Workspace Browser API loopback", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("commits a Human Draft for Remote MCP and preserves it through conflict and expiry", async () => {
    const port = await reservePort();
    const spaceKey = formatSpaceKey(randomBytes(32));
    const spaceId = await deriveSpaceId(parseSpaceKey(spaceKey));
    const store = createHandoffStore(pool, RETENTION_WINDOW_MS);
    const created = await store.createHandoff({
      spaceId,
      markdown: "# Initial",
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
    let client: Client | undefined;
    const storage = new MemoryStorage();

    try {
      running = await startProduction(config);
      const endpoint = `http://${running.host}:${running.port}`;
      const request = (path: string, init?: RequestInit): Promise<Response> =>
        fetch(`${endpoint}${path}`, init);
      const controller = createHandoffWorkspaceController({
        code: created.code,
        sessionStorage: storage,
        workingDraftStorage: createSessionWorkingDraftStorage(storage),
        createClient: (key) => createBrowserApiClient(key, request),
      });

      await controller.submitSpaceKey(spaceKey);
      expect(controller.getState()).toMatchObject({
        kind: "ready",
        committed: { revision: 1, markdown: "# Initial", origin: "mcp" },
        workingDraft: null,
      });
      controller.updateMarkdown("# Human Revision");

      await expect(controller.commit()).resolves.toMatchObject({
        ok: true,
        value: { revision: 2, origin: "human", markdown: "# Human Revision" },
      });
      expect(controller.getState()).toMatchObject({ kind: "ready", workingDraft: null });

      client = new Client({ name: "taskdrop-human-workspace-loopback", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
        authProvider: { token: async () => spaceKey },
      });
      await client.connect(transport);
      const latest = await client.callTool({
        name: "get_handoff",
        arguments: { code: created.code },
      });
      expect(latest.structuredContent).toMatchObject({
        ok: true,
        revision: 2,
        latestRevision: 2,
        markdown: "# Human Revision",
        origin: "human",
      });
      await client.close();
      client = undefined;

      controller.updateMarkdown("# Preserve after conflict");
      const external = await store.appendRevision({
        spaceId,
        code: created.code,
        baseRevision: 2,
        markdown: "# Remote Revision",
        redactionCount: 0,
        origin: "mcp",
      });
      expect(external).toMatchObject({ ok: true, revision: 3, origin: "mcp" });

      await expect(controller.commit()).resolves.toEqual({
        ok: false,
        error: { code: "REVISION_CONFLICT", expectedRevision: 3, receivedBaseRevision: 2 },
      });
      const draftAfterConflict = controller.getState();
      expect(draftAfterConflict).toMatchObject({
        kind: "ready",
        workingDraft: { markdown: "# Preserve after conflict", baseRevision: 2 },
      });

      await pool.query(
        "UPDATE handoffs SET expires_at = now() - interval '1 second' WHERE space_id = $1 AND code = $2",
        [spaceId, created.code],
      );
      await expect(controller.commit()).resolves.toEqual({
        ok: false,
        error: { code: "HANDOFF_NOT_FOUND", handoffCode: created.code },
      });
      expect(controller.getState()).toMatchObject({
        kind: "ready",
        workingDraft: { markdown: "# Preserve after conflict", baseRevision: 2 },
      });
    } finally {
      await client?.close().catch(() => undefined);
      await running?.shutdown().catch(() => undefined);
      await pool.query("DELETE FROM handoffs WHERE space_id = $1", [spaceId]);
    }
  }, 25_000);

  it("round-trips a Remote MCP Handoff through the shared WebMCP Draft and Commit", async () => {
    const port = await reservePort();
    const spaceKey = formatSpaceKey(randomBytes(32));
    const spaceId = await deriveSpaceId(parseSpaceKey(spaceKey));
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
      const endpoint = `http://${running.host}:${running.port}`;
      client = new Client({ name: "taskdrop-webmcp-workspace-loopback", version: "0.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
        authProvider: { token: async () => spaceKey },
      });
      await client.connect(transport);

      const created = await client.callTool({
        name: "create_handoff",
        arguments: { markdown: "# Remote MCP Revision" },
      });
      const createdResult = created.structuredContent;
      if (
        typeof createdResult !== "object" ||
        createdResult === null ||
        !("ok" in createdResult) ||
        createdResult.ok !== true ||
        !("code" in createdResult) ||
        typeof createdResult.code !== "string"
      ) {
        throw new Error("Expected Remote MCP to create the fixture Handoff");
      }
      const handoffCode = createdResult.code;

      const storage = new MemoryStorage();
      const request = (path: string, init?: RequestInit): Promise<Response> =>
        fetch(`${endpoint}${path}`, init);
      const controller = createHandoffWorkspaceController({
        code: handoffCode,
        sessionStorage: storage,
        workingDraftStorage: createSessionWorkingDraftStorage(storage),
        createClient: (key) => createBrowserApiClient(key, request),
      });
      await controller.submitSpaceKey(spaceKey);
      const tools = createHandoffWebMcpTools(controller);

      await expect(
        executeWebMcpTool(webMcpTool(tools, "update_working_draft"), {
          markdown: "# WebMCP Revision",
        }),
      ).resolves.toMatchObject({
        code: handoffCode,
        workingDraft: {
          baseRevision: 1,
          markdown: "# WebMCP Revision",
          lastModifiedVia: "webmcp",
        },
      });
      expect(controller.getState()).toMatchObject({
        kind: "ready",
        workingDraft: { markdown: "# WebMCP Revision", lastModifiedVia: "webmcp" },
      });

      await expect(
        executeWebMcpTool(webMcpTool(tools, "commit_working_draft"), {}),
      ).resolves.toMatchObject({
        ok: true,
        revision: 2,
        markdown: "# WebMCP Revision",
        origin: "webmcp",
      });

      const latest = await client.callTool({
        name: "get_handoff",
        arguments: { code: handoffCode },
      });
      expect(latest.structuredContent).toMatchObject({
        ok: true,
        revision: 2,
        latestRevision: 2,
        markdown: "# WebMCP Revision",
        origin: "webmcp",
      });
      expect(controller.getState()).toMatchObject({ kind: "ready", workingDraft: null });
    } finally {
      await client?.close().catch(() => undefined);
      await running?.shutdown().catch(() => undefined);
      await pool.query("DELETE FROM handoffs WHERE space_id = $1", [spaceId]);
    }
  }, 25_000);
});
