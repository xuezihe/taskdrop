import { describe, expect, it, vi } from "vitest";

import { formatSpaceKey } from "../src/production/space-identity.js";
import {
  createHandoffWorkspaceController,
  type HandoffWorkspaceController,
  type MarkdownChangeReason,
  type WorkspaceState,
} from "../web/handoff-workspace-controller.js";
import type {
  BrowserApiClient,
  BrowserClientResult,
  BrowserRevision,
  BrowserRevisionHistory,
} from "../web/browser-api-client.js";
import {
  createSessionWorkingDraftStorage,
  SPACE_KEY_STORAGE_KEY,
} from "../web/handoff-session-storage.js";

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

function history(): BrowserRevisionHistory {
  return {
    ok: true,
    code: "ABC001",
    latestRevision: 1,
    expiresAt: "2026-08-29T08:00:00.000Z",
    revisions: [{ revision: 1, origin: "mcp", createdAt: "2026-08-28T08:00:00.000Z" }],
  };
}

function fakeClient(
  current: BrowserClientResult,
  append: BrowserClientResult = revision({ revision: 2, latestRevision: 2, origin: "human" }),
  observations: { append?: Parameters<BrowserApiClient["appendRevision"]>[0] } = {},
): BrowserApiClient {
  return {
    getCurrent: async () => current,
    getRevisionHistory: async () => history(),
    readRevision: async () => current,
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
      getRevisionHistory: async () => history(),
      readRevision: async () => revision(),
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

  it("loads Server Latest before discarding a conflicted Draft", async () => {
    const storage = new MemoryStorage();
    const initial = revision();
    const latest = revision({
      revision: 2,
      latestRevision: 2,
      markdown: "# Server latest",
      origin: "mcp",
    });
    const conflict = {
      ok: false as const,
      error: { code: "REVISION_CONFLICT" as const, expectedRevision: 2, receivedBaseRevision: 1 },
    };
    let currentCalls = 0;
    let appendCalls = 0;
    const client: BrowserApiClient = {
      getCurrent: async () => {
        currentCalls += 1;
        return currentCalls === 1 ? initial : latest;
      },
      getRevisionHistory: async () => history(),
      readRevision: async () => initial,
      appendRevision: async () => {
        appendCalls += 1;
        return conflict;
      },
    };
    const controller = createController(storage, new Map([[SPACE_KEY, client]]));

    await controller.submitSpaceKey(SPACE_KEY);
    controller.updateMarkdown("# Preserve until Server Latest loads");
    await expect(controller.commit()).resolves.toEqual(conflict);

    await expect(controller.resolveRevisionConflict("use-server-latest")).resolves.toEqual({
      ok: true,
      value: latest,
    });
    expect(appendCalls).toBe(1);
    expect(readyState(controller)).toMatchObject({
      committed: latest,
      workingDraft: null,
      commitPending: false,
      actionError: null,
    });
  });

  it("preserves the conflicted Draft when Use Server Latest cannot load", async () => {
    const storage = new MemoryStorage();
    const initial = revision();
    const conflict = {
      ok: false as const,
      error: { code: "REVISION_CONFLICT" as const, expectedRevision: 2, receivedBaseRevision: 1 },
    };
    const failure = { ok: false as const, error: { code: "NETWORK_ERROR" as const } };
    let currentCalls = 0;
    const client: BrowserApiClient = {
      getCurrent: async () => {
        currentCalls += 1;
        return currentCalls === 1 ? initial : failure;
      },
      getRevisionHistory: async () => history(),
      readRevision: async () => initial,
      appendRevision: async () => conflict,
    };
    const controller = createController(storage, new Map([[SPACE_KEY, client]]));

    await controller.submitSpaceKey(SPACE_KEY);
    controller.updateMarkdown("# Keep while Server Latest is unavailable");
    await expect(controller.commit()).resolves.toEqual(conflict);
    const draftBeforeResolution = readyState(controller).workingDraft;

    await expect(controller.resolveRevisionConflict("use-server-latest")).resolves.toEqual(failure);
    expect(readyState(controller)).toMatchObject({
      committed: initial,
      workingDraft: draftBeforeResolution,
      commitPending: false,
      actionError: conflict.error,
    });
  });

  it("keeps a conflicted Draft and retries against each observed latest Revision", async () => {
    const storage = new MemoryStorage();
    const initial = revision();
    const firstConflict = {
      ok: false as const,
      error: { code: "REVISION_CONFLICT" as const, expectedRevision: 2, receivedBaseRevision: 1 },
    };
    const repeatedConflict = {
      ok: false as const,
      error: { code: "REVISION_CONFLICT" as const, expectedRevision: 3, receivedBaseRevision: 2 },
    };
    const committed = revision({
      revision: 4,
      latestRevision: 4,
      markdown: "# Edited after conflict",
      origin: "webmcp",
    });
    const appendResults: BrowserClientResult[] = [firstConflict, repeatedConflict, committed];
    const appendInputs: Parameters<BrowserApiClient["appendRevision"]>[0][] = [];
    const client: BrowserApiClient = {
      getCurrent: async () => initial,
      getRevisionHistory: async () => history(),
      readRevision: async () => initial,
      appendRevision: async (input) => {
        appendInputs.push(input);
        const result = appendResults.shift();
        if (!result) throw new Error("Unexpected append");
        return result;
      },
    };
    const controller = createController(storage, new Map([[SPACE_KEY, client]]));

    await controller.submitSpaceKey(SPACE_KEY);
    controller.updateMarkdown("# Local Draft", "human");
    await expect(controller.commit()).resolves.toEqual(firstConflict);
    controller.updateMarkdown("# Edited after conflict", "webmcp");

    await expect(controller.resolveRevisionConflict("keep-working-draft")).resolves.toEqual(
      repeatedConflict,
    );
    expect(readyState(controller)).toMatchObject({
      workingDraft: {
        markdown: "# Edited after conflict",
        baseRevision: 1,
        lastModifiedVia: "webmcp",
        contributors: ["human", "webmcp"],
      },
      actionError: repeatedConflict.error,
      commitPending: false,
    });

    await expect(controller.resolveRevisionConflict("keep-working-draft")).resolves.toEqual({
      ok: true,
      value: committed,
    });
    expect(appendInputs).toEqual([
      {
        code: "ABC001",
        baseRevision: 1,
        markdown: "# Local Draft",
        origin: "human",
      },
      {
        code: "ABC001",
        baseRevision: 2,
        markdown: "# Edited after conflict",
        origin: "webmcp",
      },
      {
        code: "ABC001",
        baseRevision: 3,
        markdown: "# Edited after conflict",
        origin: "webmcp",
      },
    ]);
    expect(readyState(controller)).toMatchObject({
      committed,
      workingDraft: null,
      commitPending: false,
      actionError: null,
    });
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

  it("rejects a concurrent Commit while the first append is still pending", async () => {
    const storage = new MemoryStorage();
    let resolveAppend: ((result: BrowserClientResult) => void) | undefined;
    const client: BrowserApiClient = {
      getCurrent: async () => revision(),
      getRevisionHistory: async () => history(),
      readRevision: async () => revision(),
      appendRevision: async () =>
        new Promise((resolve) => {
          resolveAppend = resolve;
        }),
    };
    const controller = createController(storage, new Map([[SPACE_KEY, client]]));
    await controller.submitSpaceKey(SPACE_KEY);
    controller.updateMarkdown("# Commit once", "webmcp");

    const firstCommit = controller.commit();
    await expect(controller.commit()).resolves.toEqual({
      ok: false,
      error: { code: "COMMIT_IN_PROGRESS" },
    });

    if (!resolveAppend) throw new Error("Expected the first Commit to reach the Browser API");
    resolveAppend(
      revision({
        revision: 2,
        latestRevision: 2,
        markdown: "# Commit once",
        origin: "webmcp",
      }),
    );
    await expect(firstCommit).resolves.toMatchObject({ ok: true, value: { revision: 2 } });
  });

  it("aborts an older Space Key load and ignores its late result", async () => {
    const storage = new MemoryStorage();
    let firstSignal: AbortSignal | undefined;
    let secondSignal: AbortSignal | undefined;
    let resolveFirst: ((result: BrowserClientResult) => void) | undefined;
    let resolveSecond: ((result: BrowserClientResult) => void) | undefined;
    const firstClient: BrowserApiClient = {
      getCurrent: async (_code, signal) => {
        firstSignal = signal;
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      },
      getRevisionHistory: async () => history(),
      readRevision: async () => revision(),
      appendRevision: async () => revision(),
    };
    const secondClient: BrowserApiClient = {
      getCurrent: async (_code, signal) => {
        secondSignal = signal;
        return new Promise((resolve) => {
          resolveSecond = resolve;
        });
      },
      getRevisionHistory: async () => history(),
      readRevision: async () => revision(),
      appendRevision: async () => revision(),
    };
    const controller = createController(
      storage,
      new Map([
        [SPACE_KEY, firstClient],
        [OTHER_SPACE_KEY, secondClient],
      ]),
    );

    const firstLoad = controller.submitSpaceKey(SPACE_KEY);
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    const secondLoad = controller.submitSpaceKey(OTHER_SPACE_KEY);
    await vi.waitFor(() => expect(secondSignal).toBeDefined());

    expect(firstSignal?.aborted).toBe(true);
    resolveFirst?.(revision({ markdown: "# Late first Space" }));
    resolveSecond?.(revision({ markdown: "# Second Space" }));
    await Promise.all([firstLoad, secondLoad]);

    expect(readyState(controller)).toMatchObject({
      committed: { markdown: "# Second Space" },
    });
  });

  it("changes Space Key without deleting the namespaced Working Draft", async () => {
    const storage = new MemoryStorage();
    const controller = createController(
      storage,
      new Map([[SPACE_KEY, fakeClient(success(revision()))]]),
    );

    await controller.submitSpaceKey(SPACE_KEY);
    controller.updateMarkdown("# Recover after changing Space");
    controller.changeSpaceKey();

    expect(controller.getState()).toEqual({
      kind: "needs-space-key",
      code: "ABC001",
      inputError: null,
    });
    expect(storage.getItem(SPACE_KEY_STORAGE_KEY)).toBeNull();
    expect(controller.updateMarkdown("# Must not reach old Space")).toEqual({
      ok: false,
      error: { code: "WORKSPACE_NOT_READY" },
    });

    await controller.submitSpaceKey(SPACE_KEY);
    expect(readyState(controller).workingDraft).toMatchObject({
      markdown: "# Recover after changing Space",
    });
  });

  it("cancels a pending Commit on dispose without clearing the local Draft", async () => {
    const storage = new MemoryStorage();
    let appendSignal: AbortSignal | undefined;
    let resolveAppend: ((result: BrowserClientResult) => void) | undefined;
    const client: BrowserApiClient = {
      getCurrent: async () => revision(),
      getRevisionHistory: async () => history(),
      readRevision: async () => revision(),
      appendRevision: async (_input, signal) => {
        appendSignal = signal;
        return new Promise((resolve) => {
          resolveAppend = resolve;
        });
      },
    };
    const controller = createController(storage, new Map([[SPACE_KEY, client]]));
    await controller.submitSpaceKey(SPACE_KEY);
    controller.updateMarkdown("# Keep after page disposal");

    const pendingCommit = controller.commit();
    await vi.waitFor(() => expect(appendSignal).toBeDefined());
    controller.dispose();
    expect(appendSignal?.aborted).toBe(true);
    resolveAppend?.(revision({ revision: 2, latestRevision: 2 }));

    await expect(pendingCommit).resolves.toEqual({
      ok: false,
      error: { code: "REQUEST_CANCELLED" },
    });
    expect(controller.getState()).toMatchObject({ kind: "needs-space-key" });
    expect(controller.updateMarkdown("# No mutation after dispose")).toEqual({
      ok: false,
      error: { code: "WORKSPACE_NOT_READY" },
    });

    const recovered = createController(
      storage,
      new Map([[SPACE_KEY, fakeClient(success(revision()))]]),
    );
    await recovered.submitSpaceKey(SPACE_KEY);
    expect(readyState(recovered).workingDraft).toMatchObject({
      markdown: "# Keep after page disposal",
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

  it("shares one Draft between WebMCP and Human while read commands remain read-only", async () => {
    const storage = new MemoryStorage();
    const controller = createController(
      storage,
      new Map([[SPACE_KEY, fakeClient(success(revision()))]]),
    );

    await controller.submitSpaceKey(SPACE_KEY);
    expect(controller.updateMarkdown("# Existing Draft", "human")).toEqual({ ok: true });
    const draftBeforeReads = readyState(controller).workingDraft;
    const storageBeforeReads = Array.from({ length: storage.length }, (_, index) => [
      storage.key(index),
      storage.key(index) === null ? null : storage.getItem(storage.key(index)!),
    ]);
    await expect(controller.getRevisionHistory()).resolves.toEqual({
      ok: true,
      value: history(),
    });
    await expect(controller.readRevision(1)).resolves.toEqual({
      ok: true,
      value: revision(),
    });
    expect(readyState(controller).workingDraft).toBe(draftBeforeReads);
    expect(
      Array.from({ length: storage.length }, (_, index) => [
        storage.key(index),
        storage.key(index) === null ? null : storage.getItem(storage.key(index)!),
      ]),
    ).toEqual(storageBeforeReads);

    expect(controller.updateMarkdown("# Agent update", "webmcp")).toEqual({ ok: true });
    expect(readyState(controller).workingDraft).toMatchObject({
      markdown: "# Agent update",
      lastModifiedVia: "webmcp",
      contributors: ["human", "webmcp"],
    });

    expect(controller.updateMarkdown("# Human follow-up")).toEqual({ ok: true });
    expect(readyState(controller).workingDraft).toMatchObject({
      markdown: "# Human follow-up",
      lastModifiedVia: "human",
      contributors: ["human", "webmcp"],
    });
  });

  it("rejects known rich-path blockers before changing the Draft", async () => {
    const storage = new MemoryStorage();
    const controller = createController(
      storage,
      new Map([[SPACE_KEY, fakeClient(success(revision()))]]),
    );

    await controller.submitSpaceKey(SPACE_KEY);
    expect(controller.updateMarkdown("# Allowed", "webmcp")).toEqual({ ok: true });
    const before = readyState(controller).workingDraft;

    expect(controller.updateMarkdown("![remote](https://example.com/image.png)", "webmcp")).toEqual(
      {
        ok: false,
        error: { code: "RICH_DRAFT_UNSUPPORTED", blocker: "image" },
      },
    );
    expect(readyState(controller).workingDraft).toBe(before);

    const reloaded = createController(
      storage,
      new Map([[SPACE_KEY, fakeClient(success(revision()))]]),
    );
    await reloaded.submitSpaceKey(SPACE_KEY);
    expect(readyState(reloaded).workingDraft).toEqual(before);
  });

  describe("markdown change reasons", () => {
    it("emits workspace-reset when the Handoff loads", async () => {
      const storage = new MemoryStorage();
      const controller = createController(
        storage,
        new Map([[SPACE_KEY, fakeClient(success(revision()))]]),
      );
      const reasons: MarkdownChangeReason[] = [];
      controller.subscribe((state, reason) => {
        if (state.kind === "ready") reasons.push(reason);
      });

      await controller.submitSpaceKey(SPACE_KEY);
      expect(reasons).toEqual(["workspace-reset"]);
    });

    it("emits human-edit for a Human surface change", async () => {
      const storage = new MemoryStorage();
      const controller = createController(
        storage,
        new Map([[SPACE_KEY, fakeClient(success(revision()))]]),
      );
      const reasons: MarkdownChangeReason[] = [];
      controller.subscribe((_, reason) => reasons.push(reason));

      await controller.submitSpaceKey(SPACE_KEY);
      controller.updateMarkdown("# Human update");
      expect(reasons.at(-1)).toBe("human-edit");
    });

    it("emits webmcp-replace for a WebMCP surface change", async () => {
      const storage = new MemoryStorage();
      const controller = createController(
        storage,
        new Map([[SPACE_KEY, fakeClient(success(revision()))]]),
      );
      const reasons: MarkdownChangeReason[] = [];
      controller.subscribe((_, reason) => reasons.push(reason));

      await controller.submitSpaceKey(SPACE_KEY);
      controller.updateMarkdown("# Agent update", "webmcp");
      expect(reasons.at(-1)).toBe("webmcp-replace");
    });

    it("emits null when the Markdown is unchanged", async () => {
      const storage = new MemoryStorage();
      const controller = createController(
        storage,
        new Map([[SPACE_KEY, fakeClient(success(revision()))]]),
      );
      const reasons: MarkdownChangeReason[] = [];
      controller.subscribe((_, reason) => reasons.push(reason));

      await controller.submitSpaceKey(SPACE_KEY);
      controller.updateMarkdown("# Initial");
      expect(reasons.at(-1)).toBeNull();
    });

    it("emits workspace-reset on discard", async () => {
      const storage = new MemoryStorage();
      const controller = createController(
        storage,
        new Map([[SPACE_KEY, fakeClient(success(revision()))]]),
      );
      const reasons: MarkdownChangeReason[] = [];
      controller.subscribe((_, reason) => reasons.push(reason));

      await controller.submitSpaceKey(SPACE_KEY);
      controller.updateMarkdown("# Draft");
      controller.discard();
      expect(reasons.at(-1)).toBe("workspace-reset");
    });

    it("emits workspace-reset on successful commit", async () => {
      const storage = new MemoryStorage();
      const controller = createController(
        storage,
        new Map([[SPACE_KEY, fakeClient(success(revision({ revision: 2, latestRevision: 2 })))]]),
      );
      const reasons: MarkdownChangeReason[] = [];
      controller.subscribe((_, reason) => reasons.push(reason));

      await controller.submitSpaceKey(SPACE_KEY);
      controller.updateMarkdown("# Draft");
      await controller.commit();
      expect(reasons.at(-1)).toBe("workspace-reset");
    });

    it("emits null for status-only updates", async () => {
      const storage = new MemoryStorage();
      const failed = {
        ok: false as const,
        error: { code: "NETWORK_ERROR" as const },
      };
      const controller = createController(
        storage,
        new Map([[SPACE_KEY, fakeClient(success(revision()), failed)]]),
      );
      const reasons: MarkdownChangeReason[] = [];
      controller.subscribe((_, reason) => reasons.push(reason));

      await controller.submitSpaceKey(SPACE_KEY);
      controller.updateMarkdown("# Draft");
      const beforeCommit = reasons.length;
      await controller.commit();
      expect(reasons.slice(beforeCommit)).toEqual([null, null]);
    });
  });
});
