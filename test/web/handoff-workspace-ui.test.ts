import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { installBrowserGlobals } from "./jsdom-browser-globals.js";
import type {
  HandoffWorkspaceController,
  WorkspaceState,
} from "../../web/handoff-workspace-controller.js";
import type { WorkingDraftEditor } from "../../web/working-draft-editor.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const layout = root.querySelector(".workspace-layout");
    expect(keyForm).toBeTruthy();
    expect(layout).toBeTruthy();
    expect(layout?.hasAttribute("hidden")).toBe(false);

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
