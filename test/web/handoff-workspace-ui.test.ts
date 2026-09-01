import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { installBrowserGlobals } from "./jsdom-browser-globals.js";
import type {
  HandoffWorkspaceController,
  WorkspaceState,
} from "../../web/handoff-workspace-controller.js";
import type { WorkingDraftEditor } from "../../web/working-draft-editor.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function readyState(
  overrides: Partial<Extract<WorkspaceState, { kind: "ready" }>> = {},
): Extract<WorkspaceState, { kind: "ready" }> {
  return {
    kind: "ready",
    code: "ABC001",
    committed: {
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
    },
    workingDraft: null,
    commitPending: false,
    actionError: null,
    ...overrides,
  };
}

function historyResult() {
  return {
    ok: true as const,
    code: "ABC001",
    latestRevision: 3,
    expiresAt: "2026-08-29T08:00:00.000Z",
    revisions: [
      { revision: 3, origin: "human" as const, createdAt: "2026-08-28T10:00:00.000Z" },
      { revision: 2, origin: "webmcp" as const, createdAt: "2026-08-28T09:00:00.000Z" },
      { revision: 1, origin: "mcp" as const, createdAt: "2026-08-28T08:00:00.000Z" },
    ],
  };
}

vi.mock("../../web/handoff-workspace-controller.js", async () => {
  const actual = await vi.importActual<typeof import("../../web/handoff-workspace-controller.js")>(
    "../../web/handoff-workspace-controller.js",
  );
  return {
    ...actual,
    createHandoffWorkspaceController: vi.fn(),
  };
});

vi.mock("../../web/webmcp-registration.js", () => ({
  bindHandoffWebMcpTools: () => ({ dispose: vi.fn() }),
}));

vi.mock("../../web/working-draft-editor.js", () => ({
  mountWorkingDraftEditor: vi.fn(),
}));

describe("Handoff Workspace UI", () => {
  let cleanup: () => void;

  beforeAll(() => {
    cleanup = installBrowserGlobals();
  });

  afterAll(() => {
    cleanup();
  });

  it("shows the key form before the Handoff loads and the workspace after it loads", async () => {
    const { createHandoffWorkspaceController } =
      await import("../../web/handoff-workspace-controller.js");
    const { mountWorkingDraftEditor } = await import("../../web/working-draft-editor.js");
    const { mountHandoffWorkspace } = await import("../../web/handoff-workspace.js");

    const ready: Extract<WorkspaceState, { kind: "ready" }> = {
      kind: "ready",
      code: "ABC001",
      committed: {
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
      },
      workingDraft: null,
      commitPending: false,
      actionError: null,
    };

    let listener:
      | ((
          state: WorkspaceState,
          reason: import("../../web/handoff-workspace-controller.js").MarkdownChangeReason,
        ) => void)
      | undefined;
    const controller: HandoffWorkspaceController = {
      getState: () => ready,
      subscribe: (l) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      open: async () => {
        if (listener) listener(ready, "workspace-reset");
      },
      submitSpaceKey: async () => {},
      getRevisionHistory: async () => ({ ok: false, error: { code: "WORKSPACE_NOT_READY" } }),
      readRevision: async () => ({ ok: false, error: { code: "WORKSPACE_NOT_READY" } }),
      updateMarkdown: () => ({ ok: true }),
      discard: () => {},
      commit: async () => ({ ok: false, error: { code: "NO_WORKING_DRAFT" } }),
    };

    vi.mocked(createHandoffWorkspaceController).mockReturnValue(controller);
    const mockEditor: WorkingDraftEditor = {
      replaceMarkdown: vi.fn(),
      setReadOnly: vi.fn(),
      destroy: async () => {},
    };
    vi.mocked(mountWorkingDraftEditor).mockResolvedValue(mockEditor);

    const root = document.createElement("div");
    document.body.append(root);
    await mountHandoffWorkspace(root, "ABC001");

    const keyForm = root.querySelector(".workspace-key-form");
    const keyGate = root.querySelector<HTMLElement>(".workspace-key-gate");
    const layout = root.querySelector(".workspace-layout");
    expect(keyForm).toBeTruthy();
    expect(keyGate?.hidden).toBe(true);
    expect(layout).toBeTruthy();
    expect(layout?.hasAttribute("hidden")).toBe(false);
    expect(root.querySelector(".workspace-context-title")?.textContent).toBe("TaskDrop Handoff");
    expect(root.querySelector(".workspace-context-meta")?.textContent).toContain("Revision 1");
    expect(root.querySelector(".workspace-context-meta")?.textContent).toContain(
      "Latest Revision 1",
    );
    expect(root.querySelector(".workspace-context-meta")?.textContent).toContain(
      "Expires 2026-08-29 08:00 UTC",
    );

    root.remove();
  });

  it("loads and renders a newest-first Revision timeline", async () => {
    const { createHandoffWorkspaceController } =
      await import("../../web/handoff-workspace-controller.js");
    const { mountWorkingDraftEditor } = await import("../../web/working-draft-editor.js");
    const { mountHandoffWorkspace } = await import("../../web/handoff-workspace.js");

    const ready = readyState({
      committed: {
        ...readyState().committed,
        revision: 3,
        latestRevision: 3,
      },
    });
    const history = historyResult();
    let currentState: WorkspaceState = ready;
    let listener:
      | ((
          state: WorkspaceState,
          reason: import("../../web/handoff-workspace-controller.js").MarkdownChangeReason,
        ) => void)
      | undefined;
    const getRevisionHistory = vi.fn(async () => ({ ok: true as const, value: history }));
    const controller: HandoffWorkspaceController = {
      getState: () => currentState,
      subscribe: (nextListener) => {
        listener = nextListener;
        return () => {
          listener = undefined;
        };
      },
      open: async () => {
        listener?.(currentState, "workspace-reset");
      },
      submitSpaceKey: async () => {},
      getRevisionHistory,
      readRevision: async () => ({ ok: false, error: { code: "WORKSPACE_NOT_READY" } }),
      updateMarkdown: () => ({ ok: true }),
      discard: () => {},
      commit: async () => ({ ok: false, error: { code: "NO_WORKING_DRAFT" } }),
    };

    vi.mocked(createHandoffWorkspaceController).mockReturnValue(controller);
    vi.mocked(mountWorkingDraftEditor).mockResolvedValue({
      replaceMarkdown: vi.fn(),
      setReadOnly: vi.fn(),
      destroy: async () => {},
    });

    const root = document.createElement("div");
    document.body.append(root);
    await mountHandoffWorkspace(root, "ABC001");
    await wait(0);
    await wait(0);

    expect(getRevisionHistory).toHaveBeenCalledTimes(1);
    const rows = [...root.querySelectorAll<HTMLLIElement>(".workspace-history-row")];
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.querySelector(".workspace-history-name")?.textContent)).toEqual([
      "Working Draft",
      "Revision 3",
      "Revision 2",
      "Revision 1",
    ]);
    expect(rows[1]?.textContent).toContain("Human");
    expect(rows[2]?.textContent).toContain("WebMCP");
    expect(rows[3]?.textContent).toContain("MCP");
    expect(rows[1]?.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-08-28T10:00:00.000Z",
    );
    expect(rows[0]?.classList.contains("workspace-history-row-active")).toBe(true);

    root.remove();
  });

  it("reads a historical Revision without replacing the current Working Draft", async () => {
    const { createHandoffWorkspaceController } =
      await import("../../web/handoff-workspace-controller.js");
    const { mountWorkingDraftEditor } = await import("../../web/working-draft-editor.js");
    const { mountHandoffWorkspace } = await import("../../web/handoff-workspace.js");

    const initial = readyState({
      committed: {
        ...readyState().committed,
        revision: 3,
        latestRevision: 3,
      },
      workingDraft: {
        handoffCode: "ABC001",
        baseRevision: 3,
        markdown: "# Current Draft",
        lastModifiedVia: "human",
        contributors: ["human"],
        updatedAt: "2026-08-28T10:01:00.000Z",
      },
    });
    const historical: typeof initial.committed = {
      ...initial.committed,
      revision: 2,
      isLatest: false,
      markdown: '<script>alert("xss")</script>\n\n# Historical Revision',
      origin: "webmcp",
      createdAt: "2026-08-28T09:00:00.000Z",
    };
    const history = historyResult();
    let currentState: WorkspaceState = initial;
    let listener:
      | ((
          state: WorkspaceState,
          reason: import("../../web/handoff-workspace-controller.js").MarkdownChangeReason,
        ) => void)
      | undefined;
    const getRevisionHistory = vi.fn(async () => ({ ok: true as const, value: history }));
    const readRevision = vi.fn(async () => ({ ok: true as const, value: historical }));
    const updateMarkdown = vi.fn(() => ({ ok: true as const }));
    const discard = vi.fn();
    const commit = vi.fn(async () => ({
      ok: false as const,
      error: { code: "NO_WORKING_DRAFT" as const },
    }));
    const controller: HandoffWorkspaceController = {
      getState: () => currentState,
      subscribe: (nextListener) => {
        listener = nextListener;
        return () => {
          listener = undefined;
        };
      },
      open: async () => {
        listener?.(currentState, "workspace-reset");
      },
      submitSpaceKey: async () => {},
      getRevisionHistory,
      readRevision,
      updateMarkdown,
      discard,
      commit,
    };

    vi.mocked(createHandoffWorkspaceController).mockReturnValue(controller);
    const replaceMarkdown = vi.fn();
    const mockEditor: WorkingDraftEditor = {
      replaceMarkdown,
      setReadOnly: vi.fn(),
      destroy: async () => {},
    };
    vi.mocked(mountWorkingDraftEditor).mockResolvedValue(mockEditor);

    const root = document.createElement("div");
    document.body.append(root);
    await mountHandoffWorkspace(root, "ABC001");
    await wait(0);
    await wait(0);

    const revisionButton = root.querySelector<HTMLButtonElement>('[aria-label="Read Revision 2"]');
    expect(revisionButton).toBeTruthy();
    revisionButton?.click();
    await wait(0);

    expect(readRevision).toHaveBeenCalledWith(2);
    expect(root.querySelector<HTMLElement>(".workspace-history-document")?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>(".workspace-editor-viewport")?.hidden).toBe(true);
    expect(root.querySelector(".workspace-history-document-title")?.textContent).toBe("Revision 2");
    expect(root.querySelector(".workspace-history-document-meta")?.textContent).toContain("WebMCP");
    expect(root.querySelector(".workspace-history-document-content")?.textContent).toContain(
      "Historical Revision",
    );
    expect(root.querySelector(".workspace-history-document-content")?.innerHTML).not.toContain(
      "<script",
    );
    expect(root.querySelector<HTMLElement>(".workspace-history-detail")?.textContent).toContain(
      "Based on Revision 3",
    );
    expect(root.querySelector<HTMLButtonElement>(".workspace-commit-button")?.disabled).toBe(true);
    expect(updateMarkdown).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();

    const updated = readyState({
      ...initial,
      workingDraft: {
        ...initial.workingDraft!,
        markdown: "# Latest Draft",
        lastModifiedVia: "webmcp",
        contributors: ["human", "webmcp"],
      },
    });
    currentState = updated;
    listener?.(updated, "webmcp-replace");
    await wait(0);
    expect(root.querySelector(".workspace-history-document-content")?.textContent).toContain(
      "Historical Revision",
    );
    expect(replaceMarkdown).toHaveBeenLastCalledWith({
      markdown: "# Latest Draft",
      history: "record",
    });

    root.querySelector<HTMLButtonElement>(".workspace-history-button")?.click();
    expect(root.querySelector<HTMLElement>(".workspace-history-document")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>(".workspace-editor-viewport")?.hidden).toBe(false);
    expect(root.querySelector(".workspace-history-detail")?.textContent).toContain(
      "Based on Revision 3",
    );

    root.remove();
  });

  it("surfaces a history failure with retry and ignores a stale historical read", async () => {
    const { createHandoffWorkspaceController } =
      await import("../../web/handoff-workspace-controller.js");
    const { mountWorkingDraftEditor } = await import("../../web/working-draft-editor.js");
    const { mountHandoffWorkspace } = await import("../../web/handoff-workspace.js");

    const ready = readyState({
      committed: {
        ...readyState().committed,
        revision: 3,
        latestRevision: 3,
      },
    });
    const history = historyResult();
    const historicalOne: typeof ready.committed = {
      ...ready.committed,
      revision: 1,
      latestRevision: 3,
      isLatest: false,
      markdown: "# Revision One",
      origin: "mcp",
      createdAt: "2026-08-28T08:00:00.000Z",
    };
    const historicalTwo: typeof ready.committed = {
      ...ready.committed,
      revision: 2,
      latestRevision: 3,
      isLatest: false,
      markdown: "# Revision Two",
      origin: "webmcp",
      createdAt: "2026-08-28T09:00:00.000Z",
    };
    let currentState: WorkspaceState = ready;
    let listener:
      | ((
          state: WorkspaceState,
          reason: import("../../web/handoff-workspace-controller.js").MarkdownChangeReason,
        ) => void)
      | undefined;
    let historyAttempt = 0;
    const getRevisionHistory = vi.fn(async () => {
      historyAttempt += 1;
      return historyAttempt === 1
        ? ({ ok: false as const, error: { code: "NETWORK_ERROR" as const } } as const)
        : ({ ok: true as const, value: history } as const);
    });
    type ReadResult = Awaited<ReturnType<HandoffWorkspaceController["readRevision"]>>;
    const pendingReads = new Map<number, (result: ReadResult) => void>();
    const readRevision = vi.fn(
      (revision: number) =>
        new Promise<ReadResult>((resolve) => {
          pendingReads.set(revision, resolve);
        }),
    );
    const controller: HandoffWorkspaceController = {
      getState: () => currentState,
      subscribe: (nextListener) => {
        listener = nextListener;
        return () => {
          listener = undefined;
        };
      },
      open: async () => {
        listener?.(currentState, "workspace-reset");
      },
      submitSpaceKey: async () => {},
      getRevisionHistory,
      readRevision,
      updateMarkdown: () => ({ ok: true }),
      discard: () => {},
      commit: async () => ({ ok: false, error: { code: "NO_WORKING_DRAFT" } }),
    };

    vi.mocked(createHandoffWorkspaceController).mockReturnValue(controller);
    vi.mocked(mountWorkingDraftEditor).mockResolvedValue({
      replaceMarkdown: vi.fn(),
      setReadOnly: vi.fn(),
      destroy: async () => {},
    });

    const root = document.createElement("div");
    document.body.append(root);
    await mountHandoffWorkspace(root, "ABC001");
    await wait(0);
    await wait(0);

    expect(getRevisionHistory).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".workspace-history-status")?.textContent).toContain(
      "could not be reached",
    );
    root.querySelector<HTMLButtonElement>(".workspace-history-retry")?.click();
    await wait(0);
    await wait(0);
    expect(getRevisionHistory).toHaveBeenCalledTimes(2);
    expect(root.querySelectorAll(".workspace-history-row")).toHaveLength(4);

    root.querySelector<HTMLButtonElement>('[aria-label="Read Revision 1"]')?.click();
    root.querySelector<HTMLButtonElement>('[aria-label="Read Revision 2"]')?.click();
    expect(readRevision).toHaveBeenNthCalledWith(1, 1);
    expect(readRevision).toHaveBeenNthCalledWith(2, 2);

    pendingReads.get(1)?.({ ok: true, value: historicalOne });
    await wait(0);
    expect(root.querySelector(".workspace-history-document-title")?.textContent).toBe("Revision 2");
    expect(root.querySelector(".workspace-history-document-content")?.textContent).not.toContain(
      "Revision One",
    );

    pendingReads.get(2)?.({ ok: true, value: historicalTwo });
    await wait(0);
    expect(root.querySelector(".workspace-history-document-title")?.textContent).toBe("Revision 2");
    expect(root.querySelector(".workspace-history-document-content")?.textContent).toContain(
      "Revision Two",
    );

    root.querySelector<HTMLButtonElement>('[aria-label="Read Revision 3"]')?.click();
    await wait(0);
    pendingReads.get(3)?.({
      ok: false,
      error: { code: "HANDOFF_NOT_FOUND", handoffCode: "ABC001" },
    });
    await wait(0);
    expect(root.querySelector(".workspace-history-document-state")?.textContent).toContain(
      "not available in the active Space",
    );

    root.querySelector<HTMLButtonElement>(".workspace-history-document-retry")?.click();
    await wait(0);
    const historicalThree: typeof ready.committed = {
      ...ready.committed,
      revision: 3,
      latestRevision: 3,
      isLatest: true,
      markdown: "# Revision Three",
      origin: "human",
      createdAt: "2026-08-28T10:00:00.000Z",
    };
    pendingReads.get(3)?.({ ok: true, value: historicalThree });
    await wait(0);
    expect(root.querySelector(".workspace-history-document-content")?.textContent).toContain(
      "Revision Three",
    );

    root.remove();
  });

  it("surfaces a gated committed Markdown value in sanitized read-only mode", async () => {
    const { createHandoffWorkspaceController } =
      await import("../../web/handoff-workspace-controller.js");
    const { mountWorkingDraftEditor } = await import("../../web/working-draft-editor.js");
    const { mountHandoffWorkspace } = await import("../../web/handoff-workspace.js");

    const ready: Extract<WorkspaceState, { kind: "ready" }> = {
      kind: "ready",
      code: "ABC001",
      committed: {
        ok: true,
        code: "ABC001",
        revision: 1,
        latestRevision: 1,
        isLatest: true,
        markdown: '<script>alert("xss")</script>\n\n# Preserved',
        contentSanitized: false,
        redactionCount: 0,
        origin: "mcp",
        createdAt: "2026-08-28T08:00:00.000Z",
        expiresAt: "2026-08-29T08:00:00.000Z",
      },
      workingDraft: null,
      commitPending: false,
      actionError: null,
    };
    const controller: HandoffWorkspaceController = {
      getState: () => ready,
      subscribe: () => () => {},
      open: async () => {},
      submitSpaceKey: async () => {},
      getRevisionHistory: async () => ({ ok: false, error: { code: "WORKSPACE_NOT_READY" } }),
      readRevision: async () => ({ ok: false, error: { code: "WORKSPACE_NOT_READY" } }),
      updateMarkdown: () => ({ ok: true }),
      discard: () => {},
      commit: async () => ({ ok: false, error: { code: "NO_WORKING_DRAFT" } }),
    };

    vi.mocked(createHandoffWorkspaceController).mockReturnValue(controller);
    vi.mocked(mountWorkingDraftEditor).mockClear();

    const root = document.createElement("div");
    document.body.append(root);
    await mountHandoffWorkspace(root, "ABC001");
    await wait(0);

    expect(mountWorkingDraftEditor).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>(".workspace-editor-fallback")?.hidden).toBe(false);
    expect(root.querySelector(".workspace-editor-fallback-message")?.textContent).toContain(
      "raw HTML",
    );
    expect(root.querySelector(".workspace-editor-fallback-content")?.innerHTML).not.toContain(
      "<script",
    );
    expect(root.querySelector(".workspace-editor-fallback-content")?.textContent).toContain(
      "Preserved",
    );

    root.remove();
  });

  it("keeps the loaded Workspace visible and surfaces a retry when the editor fails", async () => {
    const { createHandoffWorkspaceController } =
      await import("../../web/handoff-workspace-controller.js");
    const { mountWorkingDraftEditor } = await import("../../web/working-draft-editor.js");
    const { mountHandoffWorkspace } = await import("../../web/handoff-workspace.js");

    const ready: Extract<WorkspaceState, { kind: "ready" }> = {
      kind: "ready",
      code: "ABC001",
      committed: {
        ok: true,
        code: "ABC001",
        revision: 3,
        latestRevision: 3,
        isLatest: true,
        markdown: "# Loaded despite editor failure",
        contentSanitized: false,
        redactionCount: 0,
        origin: "mcp",
        createdAt: "2026-08-28T08:00:00.000Z",
        expiresAt: "2026-08-29T08:00:00.000Z",
      },
      workingDraft: null,
      commitPending: false,
      actionError: null,
    };
    const controller: HandoffWorkspaceController = {
      getState: () => ready,
      subscribe: () => () => {},
      open: async () => {},
      submitSpaceKey: async () => {},
      getRevisionHistory: async () => ({ ok: false, error: { code: "WORKSPACE_NOT_READY" } }),
      readRevision: async () => ({ ok: false, error: { code: "WORKSPACE_NOT_READY" } }),
      updateMarkdown: () => ({ ok: true }),
      discard: () => {},
      commit: async () => ({ ok: false, error: { code: "NO_WORKING_DRAFT" } }),
    };

    vi.mocked(createHandoffWorkspaceController).mockReturnValue(controller);
    vi.mocked(mountWorkingDraftEditor).mockRejectedValueOnce(new Error("Crepe failed to mount"));

    const root = document.createElement("div");
    document.body.append(root);
    await mountHandoffWorkspace(root, "ABC001");
    await wait(0);

    expect(root.querySelector<HTMLElement>(".workspace-layout")?.hidden).toBe(false);
    expect(root.querySelector(".workspace-context-meta")?.textContent).toContain("Revision 3");
    expect(root.querySelector(".workspace-editor-state")?.textContent).toContain(
      "The document editor could not be loaded.",
    );
    expect(root.querySelector<HTMLElement>(".workspace-editor-retry")?.hidden).toBe(false);

    root.remove();
  });

  it("maps WebMCP replacement to a recordable editor replacement and reset to a reset", async () => {
    const { createHandoffWorkspaceController } =
      await import("../../web/handoff-workspace-controller.js");
    const { mountWorkingDraftEditor } = await import("../../web/working-draft-editor.js");
    const { mountHandoffWorkspace } = await import("../../web/handoff-workspace.js");

    const ready: Extract<WorkspaceState, { kind: "ready" }> = {
      kind: "ready",
      code: "ABC001",
      committed: {
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
      },
      workingDraft: {
        handoffCode: "ABC001",
        baseRevision: 1,
        markdown: "# Agent",
        lastModifiedVia: "webmcp",
        contributors: ["webmcp"],
        updatedAt: "2026-08-28T08:01:00.000Z",
      },
      commitPending: false,
      actionError: null,
    };

    let listener:
      | ((
          state: WorkspaceState,
          reason: import("../../web/handoff-workspace-controller.js").MarkdownChangeReason,
        ) => void)
      | undefined;
    const controller: HandoffWorkspaceController = {
      getState: () => ready,
      subscribe: (l) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      open: async () => {
        if (listener) listener(ready, "workspace-reset");
      },
      submitSpaceKey: async () => {},
      getRevisionHistory: async () => ({ ok: false, error: { code: "WORKSPACE_NOT_READY" } }),
      readRevision: async () => ({ ok: false, error: { code: "WORKSPACE_NOT_READY" } }),
      updateMarkdown: () => ({ ok: true }),
      discard: () => {},
      commit: async () => ({ ok: false, error: { code: "NO_WORKING_DRAFT" } }),
    };

    vi.mocked(createHandoffWorkspaceController).mockReturnValue(controller);
    const mockEditor: WorkingDraftEditor = {
      replaceMarkdown: vi.fn(),
      setReadOnly: vi.fn(),
      destroy: async () => {},
    };
    vi.mocked(mountWorkingDraftEditor).mockResolvedValue(mockEditor);

    const root = document.createElement("div");
    document.body.append(root);
    await mountHandoffWorkspace(root, "ABC001");
    await wait(0);

    expect(root.querySelector(".workspace-history-detail")?.textContent).toContain(
      "Based on Revision 1",
    );
    expect(root.querySelector(".workspace-history-detail")?.textContent).toContain(
      "Last modified: WebMCP",
    );
    expect(root.querySelector(".workspace-history-detail")?.textContent).toContain(
      "Contributors: WebMCP",
    );

    if (!listener) throw new Error("Expected listener to be registered");
    listener(ready, "webmcp-replace");
    await wait(0);
    expect(mockEditor.replaceMarkdown).toHaveBeenLastCalledWith({
      markdown: "# Agent",
      history: "record",
    });

    listener(
      {
        ...ready,
        workingDraft: null,
      },
      "workspace-reset",
    );
    await wait(0);
    expect(mockEditor.replaceMarkdown).toHaveBeenLastCalledWith({
      markdown: "# Initial",
      history: "reset",
    });

    root.remove();
  });

  it("passes human edits to the controller without replacing the editor", async () => {
    const { createHandoffWorkspaceController } =
      await import("../../web/handoff-workspace-controller.js");
    const { mountWorkingDraftEditor } = await import("../../web/working-draft-editor.js");
    const { mountHandoffWorkspace } = await import("../../web/handoff-workspace.js");

    const updateMarkdown = vi.fn<() => { ok: true }>(() => ({ ok: true }));
    const ready: Extract<WorkspaceState, { kind: "ready" }> = {
      kind: "ready",
      code: "ABC001",
      committed: {
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
      },
      workingDraft: null,
      commitPending: false,
      actionError: null,
    };

    let listener:
      | ((
          state: WorkspaceState,
          reason: import("../../web/handoff-workspace-controller.js").MarkdownChangeReason,
        ) => void)
      | undefined;
    const controller: HandoffWorkspaceController = {
      getState: () => ready,
      subscribe: (l) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      open: async () => {
        if (listener) listener(ready, "workspace-reset");
      },
      submitSpaceKey: async () => {},
      getRevisionHistory: async () => ({ ok: false, error: { code: "WORKSPACE_NOT_READY" } }),
      readRevision: async () => ({ ok: false, error: { code: "WORKSPACE_NOT_READY" } }),
      updateMarkdown,
      discard: () => {},
      commit: async () => ({ ok: false, error: { code: "NO_WORKING_DRAFT" } }),
    };

    vi.mocked(createHandoffWorkspaceController).mockReturnValue(controller);
    const mockEditor: WorkingDraftEditor = {
      replaceMarkdown: vi.fn(),
      setReadOnly: vi.fn(),
      destroy: async () => {},
    };
    let onHumanMarkdown: ((markdown: string) => void) | undefined;
    vi.mocked(mountWorkingDraftEditor).mockImplementation(async (input) => {
      onHumanMarkdown = input.onHumanMarkdown;
      return mockEditor;
    });

    const root = document.createElement("div");
    document.body.append(root);
    await mountHandoffWorkspace(root, "ABC001");
    await wait(0);

    if (!onHumanMarkdown) throw new Error("Expected editor mount callback");
    onHumanMarkdown("# Human edit");
    await wait(0);
    expect(updateMarkdown).toHaveBeenCalledWith("# Human edit", "human");
    expect(mockEditor.replaceMarkdown).not.toHaveBeenCalledWith(
      expect.objectContaining({ markdown: "# Human edit" }),
    );

    root.remove();
  });
});
