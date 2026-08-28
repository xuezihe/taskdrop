import { describe, expect, it, vi } from "vitest";

import { formatSpaceKey } from "../src/production/space-identity.js";
import type { BrowserApiClient, BrowserRevision } from "../web/browser-api-client.js";
import { createSessionWorkingDraftStorage } from "../web/handoff-session-storage.js";
import {
  createHandoffWorkspaceController,
  type HandoffWorkspaceController,
} from "../web/handoff-workspace-controller.js";
import {
  bindHandoffWebMcpTools,
  registerHandoffWebMcpTools,
  type HandoffWebMcpBinding,
  type WebMcpDocument,
} from "../web/webmcp-registration.js";

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

function revision(): BrowserRevision {
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
  };
}

function fakeClient(): BrowserApiClient {
  return {
    getCurrent: async () => revision(),
    getRevisionHistory: async () => ({
      ok: true,
      code: "ABC001",
      latestRevision: 1,
      expiresAt: "2026-08-29T08:00:00.000Z",
      revisions: [],
    }),
    readRevision: async () => revision(),
    appendRevision: async () => revision(),
  };
}

function controller(): HandoffWorkspaceController {
  const storage = new MemoryStorage();
  return createHandoffWorkspaceController({
    code: "ABC001",
    sessionStorage: storage,
    workingDraftStorage: createSessionWorkingDraftStorage(storage),
    createClient: () => fakeClient(),
  });
}

describe("Handoff WebMCP registration", () => {
  it("registers all five tools with one lifecycle signal and no cross-origin exposure", async () => {
    const workspace = controller();
    await workspace.submitSpaceKey(SPACE_KEY);
    const registrations: Array<{
      tool: WebMcpToolDefinition;
      options: WebMcpToolRegistrationOptions | undefined;
    }> = [];
    const modelContext: WebMcpModelContext = {
      registerTool: async (tool, options) => {
        registrations.push({ tool, options });
      },
    };
    const lifecycle = new AbortController();

    await registerHandoffWebMcpTools(modelContext, workspace, lifecycle.signal);

    expect(registrations.map(({ tool }) => tool.name)).toEqual([
      "get_handoff_context",
      "get_revision_history",
      "read_revision",
      "update_working_draft",
      "commit_working_draft",
    ]);
    for (const { options } of registrations) {
      expect(options).toEqual({ signal: lifecycle.signal });
      expect(options).not.toHaveProperty("exposedTo");
    }
  });

  it("progressively registers only while the Workspace is ready and aborts on disposal", async () => {
    const workspace = controller();
    const signals: AbortSignal[] = [];
    const host: WebMcpDocument = {
      modelContext: {
        registerTool: async (_tool, options) => {
          if (options?.signal) signals.push(options.signal);
        },
      },
    };

    const binding = bindHandoffWebMcpTools(workspace, host);
    expect(signals).toHaveLength(0);

    await workspace.submitSpaceKey(SPACE_KEY);
    await vi.waitFor(() => expect(signals).toHaveLength(5));
    expect(new Set(signals).size).toBe(1);
    const registrationSignal = signals[0]!;
    expect(registrationSignal.aborted).toBe(false);

    binding.dispose();
    expect(registrationSignal.aborted).toBe(true);
  });

  it("leaves the Human Workspace usable when WebMCP is unavailable or registration fails", async () => {
    const workspace = controller();
    const unsupported: HandoffWebMcpBinding = bindHandoffWebMcpTools(workspace, {});
    await workspace.submitSpaceKey(SPACE_KEY);
    expect(workspace.getState()).toMatchObject({ kind: "ready" });
    unsupported.dispose();

    let signal: AbortSignal | undefined;
    const failingHost: WebMcpDocument = {
      modelContext: {
        registerTool: async (_tool, options) => {
          signal = options?.signal;
          throw new Error("unsupported registration");
        },
      },
    };
    const failing = bindHandoffWebMcpTools(workspace, failingHost);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(workspace.getState()).toMatchObject({ kind: "ready" });
    expect(workspace.updateMarkdown("# Human still works")).toEqual({ ok: true });
    failing.dispose();
  });
});
