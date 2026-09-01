import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
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
import {
  LARGE_RICH_MARKDOWN_END_SENTINEL,
  LARGE_RICH_MARKDOWN_START_SENTINEL,
  largeRichMarkdown,
} from "../fixtures/large-rich-markdown.js";

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

function boundaryMarkdown(totalBytes: number): string {
  const heading = "# Boundary capacity fixture\n\n";
  const filler = "A".repeat(totalBytes - Buffer.byteLength(heading, "utf8"));
  return heading + filler;
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

  it("resolves a real Browser-writer conflict by appending the preserved Draft", async () => {
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
      const secondWriter = createBrowserApiClient(spaceKey, request);

      await controller.submitSpaceKey(spaceKey);
      controller.updateMarkdown("# Preserved local Draft", "human");

      await expect(
        secondWriter.appendRevision({
          code: created.code,
          baseRevision: 1,
          markdown: "# Server Revision",
          origin: "webmcp",
        }),
      ).resolves.toMatchObject({
        ok: true,
        revision: 2,
        origin: "webmcp",
        markdown: "# Server Revision",
      });

      await expect(controller.commit()).resolves.toEqual({
        ok: false,
        error: { code: "REVISION_CONFLICT", expectedRevision: 2, receivedBaseRevision: 1 },
      });
      expect(controller.getState()).toMatchObject({
        kind: "ready",
        committed: { revision: 1, markdown: "# Initial" },
        workingDraft: {
          markdown: "# Preserved local Draft",
          baseRevision: 1,
          lastModifiedVia: "human",
        },
      });

      await expect(controller.resolveRevisionConflict("keep-working-draft")).resolves.toMatchObject(
        {
          ok: true,
          value: { revision: 3, origin: "human", markdown: "# Preserved local Draft" },
        },
      );
      expect(controller.getState()).toMatchObject({
        kind: "ready",
        committed: { revision: 3, latestRevision: 3, origin: "human" },
        workingDraft: null,
      });

      await expect(secondWriter.readRevision(created.code, 2)).resolves.toMatchObject({
        ok: true,
        revision: 2,
        markdown: "# Server Revision",
        origin: "webmcp",
      });
      await expect(secondWriter.readRevision(created.code, 3)).resolves.toMatchObject({
        ok: true,
        revision: 3,
        markdown: "# Preserved local Draft",
        origin: "human",
      });
    } finally {
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

  it("commits exactly 262144 UTF-8 bytes and reads the complete Revision back", async () => {
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

      const markdown = boundaryMarkdown(262_144);
      expect(Buffer.byteLength(markdown, "utf8")).toBe(262_144);
      controller.updateMarkdown(markdown, "human");

      await expect(controller.commit()).resolves.toMatchObject({
        ok: true,
        value: { revision: 2, origin: "human" },
      });
      expect(controller.getState()).toMatchObject({ kind: "ready", workingDraft: null });

      const readBack = await controller.readRevision(2);
      expect(readBack).toMatchObject({ ok: true, value: { revision: 2, origin: "human" } });
      if (!readBack.ok) throw new Error("Expected the committed Revision to be readable");
      expect(readBack.value.markdown).toBe(markdown);
      expect(Buffer.byteLength(readBack.value.markdown, "utf8")).toBe(262_144);
    } finally {
      await running?.shutdown().catch(() => undefined);
      await pool.query("DELETE FROM handoffs WHERE space_id = $1", [spaceId]);
    }
  }, 60_000);

  it("rejects a 262145-byte Commit atomically and preserves the local Draft", async () => {
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

      const before = await pool.query<{ latest_revision: number; expires_at: Date }>(
        "SELECT latest_revision, expires_at FROM handoffs WHERE space_id = $1 AND code = $2",
        [spaceId, created.code],
      );
      const revisionsBefore = await pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM revisions WHERE space_id = $1 AND handoff_code = $2",
        [spaceId, created.code],
      );

      const markdown = boundaryMarkdown(262_145);
      expect(Buffer.byteLength(markdown, "utf8")).toBe(262_145);
      controller.updateMarkdown(markdown, "human");

      await expect(controller.commit()).resolves.toEqual({
        ok: false,
        error: { code: "CONTENT_TOO_LARGE", limitBytes: 262_144 },
      });

      const after = await pool.query<{ latest_revision: number; expires_at: Date }>(
        "SELECT latest_revision, expires_at FROM handoffs WHERE space_id = $1 AND code = $2",
        [spaceId, created.code],
      );
      const revisionsAfter = await pool.query<{ count: string }>(
        "SELECT count(*) AS count FROM revisions WHERE space_id = $1 AND handoff_code = $2",
        [spaceId, created.code],
      );
      expect(after.rows[0]!.latest_revision).toBe(before.rows[0]!.latest_revision);
      expect(after.rows[0]!.expires_at.getTime()).toBe(before.rows[0]!.expires_at.getTime());
      expect(revisionsAfter.rows[0]!.count).toBe(revisionsBefore.rows[0]!.count);

      expect(controller.getState()).toMatchObject({
        kind: "ready",
        workingDraft: { markdown, baseRevision: 1, lastModifiedVia: "human" },
      });

      const recovered = createHandoffWorkspaceController({
        code: created.code,
        sessionStorage: storage,
        workingDraftStorage: createSessionWorkingDraftStorage(storage),
        createClient: (key) => createBrowserApiClient(key, request),
      });
      await recovered.submitSpaceKey(spaceKey);
      expect(recovered.getState()).toMatchObject({
        kind: "ready",
        workingDraft: { markdown },
      });
    } finally {
      await running?.shutdown().catch(() => undefined);
      await pool.query("DELETE FROM handoffs WHERE space_id = $1", [spaceId]);
    }
  }, 60_000);

  it("round-trips the representative large Draft through Human edit, WebMCP read, Commit, and Revision read", async () => {
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
      const tools = createHandoffWebMcpTools(controller);

      await expect(
        executeWebMcpTool(webMcpTool(tools, "update_working_draft"), {
          markdown: largeRichMarkdown,
        }),
      ).resolves.toMatchObject({
        workingDraft: { markdown: largeRichMarkdown, lastModifiedVia: "webmcp" },
      });

      const humanMarker = "Human review completed for the large Working Draft.";
      const humanEdited = `${largeRichMarkdown}\n${humanMarker}\n`;
      controller.updateMarkdown(humanEdited, "human");
      expect(controller.getState()).toMatchObject({
        kind: "ready",
        workingDraft: { markdown: humanEdited, lastModifiedVia: "human" },
      });

      await expect(
        executeWebMcpTool(webMcpTool(tools, "get_handoff_context"), {}),
      ).resolves.toMatchObject({
        workingDraft: {
          markdown: humanEdited,
          lastModifiedVia: "human",
          contributors: ["webmcp", "human"],
        },
      });

      await expect(
        executeWebMcpTool(webMcpTool(tools, "commit_working_draft"), {}),
      ).resolves.toMatchObject({
        ok: true,
        revision: 2,
        origin: "human",
      });
      expect(controller.getState()).toMatchObject({ kind: "ready", workingDraft: null });

      await expect(
        executeWebMcpTool(webMcpTool(tools, "read_revision"), { revision: 2 }),
      ).resolves.toMatchObject({
        revision: 2,
        origin: "human",
      });
      const readBack = await controller.readRevision(2);
      if (!readBack.ok) throw new Error("Expected the committed Revision to be readable");
      expect(readBack.value.markdown).toBe(humanEdited);
      expect(readBack.value.markdown).toContain(LARGE_RICH_MARKDOWN_START_SENTINEL);
      expect(readBack.value.markdown).toContain(LARGE_RICH_MARKDOWN_END_SENTINEL);
      expect(readBack.value.markdown).toContain(humanMarker);
    } finally {
      await running?.shutdown().catch(() => undefined);
      await pool.query("DELETE FROM handoffs WHERE space_id = $1", [spaceId]);
    }
  }, 60_000);
});
