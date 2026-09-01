import { describe, expect, it } from "vitest";

import { formatSpaceKey } from "../src/production/space-identity.js";
import type {
  BrowserApiClient,
  BrowserClientResult,
  BrowserRevision,
  BrowserRevisionHistory,
} from "../web/browser-api-client.js";
import { createSessionWorkingDraftStorage } from "../web/handoff-session-storage.js";
import {
  createHandoffWorkspaceController,
  type HandoffWorkspaceController,
} from "../web/handoff-workspace-controller.js";
import {
  createHandoffWebMcpTools,
  WEBMCP_TOOL_NAMES,
  type HandoffWebMcpTool,
} from "../web/webmcp-tools.js";

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

const SPACE_KEY = formatSpaceKey(new Uint8Array(32));

function revision(overrides: Partial<BrowserRevision> = {}): BrowserRevision {
  return {
    ok: true,
    code: "ABC001",
    revision: 1,
    latestRevision: 1,
    isLatest: true,
    markdown: "# Initial",
    contentSanitized: false,
    redactionCount: 0,
    origin: "mcp",
    createdAt: "2026-08-28T08:00:00.000Z",
    expiresAt: "2026-08-29T08:00:00.000Z",
    ...overrides,
  };
}

function history(): BrowserRevisionHistory {
  return {
    ok: true,
    code: "ABC001",
    latestRevision: 2,
    expiresAt: "2026-08-29T08:00:00.000Z",
    revisions: [
      { revision: 2, origin: "human", createdAt: "2026-08-28T09:00:00.000Z" },
      { revision: 1, origin: "mcp", createdAt: "2026-08-28T08:00:00.000Z" },
    ],
  };
}

function fakeClient(
  append: BrowserClientResult = revision({
    revision: 2,
    latestRevision: 2,
    markdown: "# Agent update",
    origin: "webmcp",
  }),
  observations: { append?: Parameters<BrowserApiClient["appendRevision"]>[0] } = {},
): BrowserApiClient {
  return {
    getCurrent: async () => revision(),
    getRevisionHistory: async () => history(),
    readRevision: async (_code, requestedRevision) =>
      revision({
        revision: requestedRevision,
        latestRevision: 2,
        isLatest: requestedRevision === 2,
        markdown: requestedRevision === 1 ? "# Initial" : "# Human Revision",
      }),
    appendRevision: async (input) => {
      observations.append = input;
      return append;
    },
  };
}

async function readyController(client = fakeClient()): Promise<HandoffWorkspaceController> {
  const storage = new MemoryStorage();
  const controller = createHandoffWorkspaceController({
    code: "ABC001",
    sessionStorage: storage,
    workingDraftStorage: createSessionWorkingDraftStorage(storage),
    createClient: () => client,
    now: () => "2026-08-28T08:01:00.000Z",
  });
  await controller.submitSpaceKey(SPACE_KEY);
  return controller;
}

function tool(tools: readonly HandoffWebMcpTool[], name: string): HandoffWebMcpTool {
  const match = tools.find((candidate) => candidate.name === name);
  if (!match) throw new Error(`Missing tool ${name}`);
  return match;
}

function execute(selected: HandoffWebMcpTool, input: unknown): Promise<unknown> {
  return selected.execute(input, { signal: new AbortController().signal });
}

describe("Handoff WebMCP tools", () => {
  it("defines exactly the five credential-free page tools with strict schemas", async () => {
    const tools = createHandoffWebMcpTools(await readyController());

    expect(tools.map(({ name }) => name)).toEqual(WEBMCP_TOOL_NAMES);
    expect(tools).toHaveLength(5);
    expect(tool(tools, "read_revision").inputSchema).toEqual({
      type: "object",
      properties: {
        revision: {
          type: "integer",
          minimum: 1,
          description: "Positive Revision number to read from the current Handoff.",
        },
      },
      required: ["revision"],
      additionalProperties: false,
    });
    expect(tool(tools, "update_working_draft").inputSchema).toEqual({
      type: "object",
      properties: {
        markdown: {
          type: "string",
          description: "Complete Markdown content for the shared Working Draft.",
        },
      },
      required: ["markdown"],
      additionalProperties: false,
    });
    expect(tool(tools, "get_handoff_context").annotations?.readOnlyHint).toBe(true);
    expect(tool(tools, "get_revision_history").annotations?.readOnlyHint).toBe(true);
    expect(tool(tools, "read_revision").annotations?.readOnlyHint).toBe(true);
    expect(tool(tools, "update_working_draft").annotations?.readOnlyHint).toBe(false);
    expect(tool(tools, "commit_working_draft").annotations?.readOnlyHint).toBe(false);

    const definitions = JSON.stringify(
      tools.map(({ execute: _execute, ...definition }) => definition),
    );
    expect(definitions).not.toContain(SPACE_KEY);
    expect(definitions).not.toMatch(/space key/i);
    expect(definitions).not.toContain("localSpaceId");
    expect(definitions).not.toContain("handoffCode");
  });

  it("reads context, history, and historical Markdown without creating a Draft", async () => {
    const controller = await readyController();
    const tools = createHandoffWebMcpTools(controller);

    await expect(execute(tool(tools, "get_handoff_context"), {})).resolves.toEqual({
      code: "ABC001",
      latestRevision: 1,
      latestMarkdown: "# Initial",
      latestOrigin: "mcp",
      expiresAt: "2026-08-29T08:00:00.000Z",
      workingDraft: null,
    });
    await expect(execute(tool(tools, "get_revision_history"), {})).resolves.toEqual(
      history().revisions,
    );
    await expect(execute(tool(tools, "read_revision"), { revision: 1 })).resolves.toEqual({
      revision: 1,
      markdown: "# Initial",
      createdAt: "2026-08-28T08:00:00.000Z",
      origin: "mcp",
    });
    expect(controller.getState()).toMatchObject({ kind: "ready", workingDraft: null });
  });

  it("updates the Human-visible Draft and returns the resulting Margin-style context", async () => {
    const controller = await readyController();
    const tools = createHandoffWebMcpTools(controller);
    const states: unknown[] = [];
    controller.subscribe((state) => states.push(state));

    await expect(
      execute(tool(tools, "update_working_draft"), { markdown: "# Agent update" }),
    ).resolves.toMatchObject({
      latestRevision: 1,
      latestMarkdown: "# Initial",
      workingDraft: {
        baseRevision: 1,
        markdown: "# Agent update",
        lastModifiedVia: "webmcp",
        contributors: ["webmcp"],
      },
    });
    expect(states.at(-1)).toMatchObject({
      kind: "ready",
      workingDraft: { markdown: "# Agent update", lastModifiedVia: "webmcp" },
    });
  });

  it("rejects a known rich-path blocker without changing the shared Draft", async () => {
    const controller = await readyController();
    const tools = createHandoffWebMcpTools(controller);

    await expect(
      execute(tool(tools, "update_working_draft"), {
        markdown: "![remote](https://example.com/image.png)",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "RICH_DRAFT_UNSUPPORTED", blocker: "image" },
    });
    expect(controller.getState()).toMatchObject({ kind: "ready", workingDraft: null });
  });

  it("commits from Draft provenance and returns structured no-Draft, empty, and conflict results", async () => {
    const conflict = {
      ok: false as const,
      error: { code: "REVISION_CONFLICT" as const, expectedRevision: 2, receivedBaseRevision: 1 },
    };
    const controller = await readyController(fakeClient(conflict));
    const tools = createHandoffWebMcpTools(controller);
    const commit = tool(tools, "commit_working_draft");

    await expect(execute(commit, {})).resolves.toEqual({
      ok: false,
      error: { code: "NO_WORKING_DRAFT" },
    });
    await execute(tool(tools, "update_working_draft"), { markdown: "" });
    await expect(execute(commit, {})).resolves.toEqual({
      ok: false,
      error: { code: "EMPTY_MARKDOWN" },
    });
    await execute(tool(tools, "update_working_draft"), { markdown: "# Preserve" });
    await expect(execute(commit, {})).resolves.toEqual(conflict);
    expect(controller.getState()).toMatchObject({
      kind: "ready",
      workingDraft: { markdown: "# Preserve", lastModifiedVia: "webmcp" },
    });
  });

  it("commits WebMCP provenance, clears the Draft, and returns the committed Revision", async () => {
    const observations: { append?: Parameters<BrowserApiClient["appendRevision"]>[0] } = {};
    const committed = revision({
      revision: 2,
      latestRevision: 2,
      markdown: "# Agent update",
      origin: "webmcp",
    });
    const controller = await readyController(fakeClient(committed, observations));
    const tools = createHandoffWebMcpTools(controller);

    await execute(tool(tools, "update_working_draft"), { markdown: "# Agent update" });
    await expect(execute(tool(tools, "commit_working_draft"), {})).resolves.toEqual(committed);

    expect(observations.append).toEqual({
      code: "ABC001",
      baseRevision: 1,
      markdown: "# Agent update",
      origin: "webmcp",
    });
    expect(controller.getState()).toMatchObject({
      kind: "ready",
      committed: { revision: 2, origin: "webmcp" },
      workingDraft: null,
    });
  });

  it("never exposes the Space Key in any tool execution output", async () => {
    const controller = await readyController();
    const tools = createHandoffWebMcpTools(controller);

    const results: unknown[] = [];
    results.push(await execute(tool(tools, "get_handoff_context"), {}));
    results.push(await execute(tool(tools, "get_revision_history"), {}));
    results.push(await execute(tool(tools, "read_revision"), { revision: 1 }));
    results.push(await execute(tool(tools, "update_working_draft"), { markdown: "# Draft" }));
    results.push(await execute(tool(tools, "commit_working_draft"), {}));

    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(SPACE_KEY);
    expect(serialized).not.toMatch(/tdp_[A-Za-z0-9+/=]{20,}/);
    expect(serialized).not.toContain("localSpaceId");
  });

  it("rejects invalid direct execution inputs with a structured result", async () => {
    const tools = createHandoffWebMcpTools(await readyController());

    await expect(execute(tool(tools, "read_revision"), { revision: 0 })).resolves.toEqual({
      ok: false,
      error: { code: "INVALID_REQUEST" },
    });
    await expect(
      execute(tool(tools, "update_working_draft"), {
        markdown: "# Update",
        handoffCode: "ABC001",
      }),
    ).resolves.toEqual({ ok: false, error: { code: "INVALID_REQUEST" } });
  });
});
