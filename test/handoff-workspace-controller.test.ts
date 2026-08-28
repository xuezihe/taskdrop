import { describe, expect, it } from "vitest";

import { formatSpaceKey } from "../src/production/space-identity.js";
import {
  createHandoffWorkspaceController,
  type HandoffWorkspaceController,
  type WorkspaceState,
} from "../web/handoff-workspace-controller.js";
import type {
  BrowserApiClient,
  BrowserClientResult,
  BrowserRevision,
} from "../web/browser-api-client.js";
import { createSessionWorkingDraftStorage } from "../web/handoff-session-storage.js";

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
const OTHER_SPACE_KEY = formatSpaceKey(new Uint8Array(32).fill(1));

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

function readyState(
  controller: HandoffWorkspaceController,
): Extract<WorkspaceState, { kind: "ready" }> {
  const state = controller.getState();
  if (state.kind !== "ready") throw new Error(`Expected ready state, got ${state.kind}`);
  return state;
}

function success(value: BrowserRevision): BrowserClientResult {
  return value;
}

function fakeClient(
  current: BrowserClientResult,
  append: BrowserClientResult = revision({ revision: 2, latestRevision: 2, origin: "human" }),
  observations: { append?: Parameters<BrowserApiClient["appendRevision"]>[0] } = {},
): BrowserApiClient {
  return {
    getCurrent: async () => current,
    appendRevision: async (input) => {
      observations.append = input;
      return append;
    },
  };
}

function createController(
  storage: MemoryStorage,
  clients: Map<string, BrowserApiClient>,
  code = "ABC001",
): HandoffWorkspaceController {
  return createHandoffWorkspaceController({
    code,
    sessionStorage: storage,
    workingDraftStorage: createSessionWorkingDraftStorage(storage),
    createClient: (spaceKey) =>
      clients.get(spaceKey) ?? fakeClient({ ok: false, error: { code: "NETWORK_ERROR" } }),
    now: () => "2026-08-28T08:01:00.000Z",
  });
}

describe("Handoff Workspace controller", () => {
  it("loads the current Revision and keeps Commit unavailable before the first edit", async () => {
    const storage = new MemoryStorage();
    const controller = createController(
      storage,
      new Map([[SPACE_KEY, fakeClient(success(revision()))]]),
    );

    await controller.open();
    expect(controller.getState()).toMatchObject({ kind: "needs-space-key" });

    await controller.submitSpaceKey(SPACE_KEY);
    expect(readyState(controller)).toMatchObject({
      committed: revision(),
      workingDraft: null,
      commitPending: false,
    });

    await expect(controller.commit()).resolves.toEqual({
      ok: false,
      error: { code: "NO_WORKING_DRAFT" },
    });
  });

  it("lazily creates and persists a Human Draft, then commits its base and origin", async () => {
    const storage = new MemoryStorage();
    const observations: { append?: Parameters<BrowserApiClient["appendRevision"]>[0] } = {};
    const controller = createController(
      storage,
      new Map([[SPACE_KEY, fakeClient(success(revision()), undefined, observations)]]),
    );

    await controller.submitSpaceKey(SPACE_KEY);
    controller.updateMarkdown("# Human update");
    expect(readyState(controller).workingDraft).toMatchObject({
      handoffCode: "ABC001",
      baseRevision: 1,
      markdown: "# Human update",
      lastModifiedVia: "human",
      contributors: ["human"],
    });

    await expect(controller.commit()).resolves.toMatchObject({ ok: true });
    expect(observations.append).toEqual({
      code: "ABC001",
      baseRevision: 1,
      markdown: "# Human update",
      origin: "human",
    });
    expect(readyState(controller)).toMatchObject({
      workingDraft: null,
      committed: { revision: 2, markdown: "# Initial", origin: "human" },
    });
  });

  it("keeps an empty Draft local and rejects empty Commit without calling the Browser API", async () => {
    const storage = new MemoryStorage();
    let appendCalls = 0;
    const client: BrowserApiClient = {
      getCurrent: async () => revision(),
      appendRevision: async () => {
        appendCalls += 1;
        return revision({ revision: 2 });
      },
    };
    const controller = createController(storage, new Map([[SPACE_KEY, client]]));

    await controller.submitSpaceKey(SPACE_KEY);
    controller.updateMarkdown("");

    await expect(controller.commit()).resolves.toEqual({
      ok: false,
      error: { code: "EMPTY_MARKDOWN" },
    });
    expect(appendCalls).toBe(0);
    expect(readyState(controller).workingDraft).toMatchObject({ markdown: "" });
  });

  it("preserves the exact Draft after conflict or network failure", async () => {
    const storage = new MemoryStorage();
    const failed = {
      ok: false as const,
      error: { code: "REVISION_CONFLICT" as const, expectedRevision: 2, receivedBaseRevision: 1 },
    };
    const controller = createController(
      storage,
      new Map([[SPACE_KEY, fakeClient(success(revision()), failed)]]),
    );

    await controller.submitSpaceKey(SPACE_KEY);
    controller.updateMarkdown("# Recover me");
    const before = readyState(controller).workingDraft;

    await expect(controller.commit()).resolves.toEqual(failed);
    expect(readyState(controller).workingDraft).toEqual(before);
    expect(readyState(controller).actionError).toEqual(failed.error);
  });

  it("preserves the Draft when the Browser API request cannot reach the service", async () => {
    const storage = new MemoryStorage();
    const networkFailure = { ok: false as const, error: { code: "NETWORK_ERROR" as const } };
    const controller = createController(
      storage,
      new Map([[SPACE_KEY, fakeClient(success(revision()), networkFailure)]]),
    );

    await controller.submitSpaceKey(SPACE_KEY);
    controller.updateMarkdown("# Keep after network failure");

    await expect(controller.commit()).resolves.toEqual(networkFailure);
    expect(readyState(controller)).toMatchObject({
      workingDraft: { markdown: "# Keep after network failure", baseRevision: 1 },
      actionError: { code: "NETWORK_ERROR" },
    });
  });

  it("discards only the current Draft and restores the loaded committed Markdown", async () => {
    const storage = new MemoryStorage();
    const controller = createController(
      storage,
      new Map([[SPACE_KEY, fakeClient(success(revision()))]]),
    );

    await controller.submitSpaceKey(SPACE_KEY);
    controller.updateMarkdown("# Discard me");
    controller.discard();

    expect(readyState(controller)).toMatchObject({
      workingDraft: null,
      committed: { markdown: "# Initial" },
    });
  });

  it("restores a Draft in the same session but isolates another active Space", async () => {
    const storage = new MemoryStorage();
    const clients = new Map([
      [SPACE_KEY, fakeClient(success(revision()))],
      [OTHER_SPACE_KEY, fakeClient(success(revision({ markdown: "# Other Space" })))],
    ]);
    const controller = createController(storage, clients);

    await controller.submitSpaceKey(SPACE_KEY);
    controller.updateMarkdown("# First Space Draft");

    await controller.submitSpaceKey(OTHER_SPACE_KEY);
    expect(readyState(controller)).toMatchObject({
      committed: { markdown: "# Other Space" },
      workingDraft: null,
    });

    await controller.submitSpaceKey(SPACE_KEY);
    expect(readyState(controller).workingDraft).toMatchObject({ markdown: "# First Space Draft" });

    const secondController = createController(storage, clients);
    await secondController.submitSpaceKey(SPACE_KEY);
    expect(readyState(secondController).workingDraft).toMatchObject({
      markdown: "# First Space Draft",
    });
  });

  it("uses the Server canonical Code for Draft recovery after an alias route", async () => {
    const storage = new MemoryStorage();
    const controller = createController(
      storage,
      new Map([[SPACE_KEY, fakeClient(success(revision({ code: "ABC001" })))]]),
      "abc0oi",
    );

    await controller.submitSpaceKey(SPACE_KEY);
    controller.updateMarkdown("# Canonical key");

    const secondController = createController(
      storage,
      new Map([[SPACE_KEY, fakeClient(success(revision({ code: "ABC001" })))]]),
      "abc0oi",
    );
    await secondController.submitSpaceKey(SPACE_KEY);
    expect(readyState(secondController).workingDraft).toMatchObject({
      markdown: "# Canonical key",
    });
  });
});
