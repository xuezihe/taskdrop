import { isCanonicalSpaceKey } from "../src/production/space-identity.js";

import {
  deriveLocalSpaceId,
  getStoredSpaceKey,
  setStoredSpaceKey,
  type WorkingDraftStorage,
} from "./handoff-session-storage.js";
import {
  createWorkingDraft,
  updateWorkingDraft,
  type EditSurface,
  type WorkingDraft,
} from "./working-draft.js";
import {
  checkRichWorkingDraftMarkdown,
  type RichWorkingDraftBlocker,
} from "./rich-working-draft-gate.js";
import type {
  BrowserApiClient,
  BrowserApiError,
  BrowserClientError,
  BrowserClientResult,
  BrowserRevision,
  BrowserRevisionHistory,
} from "./browser-api-client.js";

export type WorkspaceLocalError =
  | { code: "INVALID_SPACE_KEY" }
  | { code: "SPACE_KEY_STORAGE_ERROR" }
  | { code: "NO_WORKING_DRAFT" }
  | { code: "EMPTY_MARKDOWN" }
  | { code: "DRAFT_STORAGE_ERROR" }
  | { code: "WORKSPACE_NOT_READY" }
  | { code: "COMMIT_IN_PROGRESS" }
  | { code: "NO_REVISION_CONFLICT" }
  | { code: "RICH_DRAFT_UNSUPPORTED"; blocker: RichWorkingDraftBlocker };

export type WorkspaceError = BrowserApiError | BrowserClientError | WorkspaceLocalError;

export type WorkspaceState =
  | { kind: "needs-space-key"; code: string; inputError: WorkspaceError | null }
  | { kind: "loading"; code: string }
  | { kind: "load-error"; code: string; error: WorkspaceError }
  | {
      kind: "ready";
      code: string;
      committed: BrowserRevision;
      workingDraft: WorkingDraft | null;
      commitPending: boolean;
      actionError: WorkspaceError | null;
    };

export type WorkspaceCommandResult =
  | { ok: true; value: BrowserRevision }
  | { ok: false; error: WorkspaceError };

export type RevisionConflictChoice = "use-server-latest" | "keep-working-draft";

export type WorkspaceHistoryResult =
  | { ok: true; value: BrowserRevisionHistory }
  | { ok: false; error: WorkspaceError };

export type WorkspaceUpdateResult = { ok: true } | { ok: false; error: WorkspaceError };

export type MarkdownChangeReason = "human-edit" | "webmcp-replace" | "workspace-reset" | null;

export type WorkspaceListener = (
  state: WorkspaceState,
  markdownChange: MarkdownChangeReason,
) => void;

export interface HandoffWorkspaceController {
  getState(): WorkspaceState;
  subscribe(listener: WorkspaceListener): () => void;
  open(): Promise<void>;
  submitSpaceKey(spaceKey: string): Promise<void>;
  getRevisionHistory(signal?: AbortSignal): Promise<WorkspaceHistoryResult>;
  readRevision(revision: number, signal?: AbortSignal): Promise<WorkspaceCommandResult>;
  updateMarkdown(markdown: string, surface?: EditSurface): WorkspaceUpdateResult;
  discard(): void;
  commit(signal?: AbortSignal): Promise<WorkspaceCommandResult>;
  resolveRevisionConflict(
    choice: RevisionConflictChoice,
    signal?: AbortSignal,
  ): Promise<WorkspaceCommandResult>;
}

export interface HandoffWorkspaceControllerOptions {
  code: string;
  sessionStorage: Storage;
  workingDraftStorage: WorkingDraftStorage;
  createClient(spaceKey: string): BrowserApiClient;
  now?: () => string;
}

export function createHandoffWorkspaceController(
  options: HandoffWorkspaceControllerOptions,
): HandoffWorkspaceController {
  const listeners = new Set<WorkspaceListener>();
  const now = options.now ?? (() => new Date().toISOString());
  let state: WorkspaceState = {
    kind: "needs-space-key",
    code: options.code,
    inputError: null,
  };
  let activeSpace: { localSpaceId: string; client: BrowserApiClient } | null = null;
  let loadSequence = 0;

  const notify = (reason: MarkdownChangeReason): void => {
    for (const listener of listeners) listener(state, reason);
  };

  const setState = (next: WorkspaceState, reason: MarkdownChangeReason): void => {
    state = next;
    notify(reason);
  };

  const loadWithSpaceKey = async (spaceKey: string): Promise<void> => {
    const sequence = ++loadSequence;
    activeSpace = null;
    setState({ kind: "loading", code: options.code }, null);

    try {
      const localSpaceId = await deriveLocalSpaceId(spaceKey);
      const client = options.createClient(spaceKey);
      const result = await client.getCurrent(options.code);
      if (sequence !== loadSequence) return;
      if (!result.ok) {
        setState({ kind: "load-error", code: options.code, error: result.error }, null);
        return;
      }

      const workingDraft = options.workingDraftStorage.load(localSpaceId, result.code);
      activeSpace = { localSpaceId, client };
      setState(
        {
          kind: "ready",
          code: result.code,
          committed: result,
          workingDraft,
          commitPending: false,
          actionError: null,
        },
        "workspace-reset",
      );
    } catch {
      if (sequence !== loadSequence) return;
      setState(
        {
          kind: "load-error",
          code: options.code,
          error: { code: "NETWORK_ERROR" },
        },
        null,
      );
    }
  };

  return {
    getState: () => state,

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async open(): Promise<void> {
      const spaceKey = getStoredSpaceKey(options.sessionStorage);
      if (!spaceKey) {
        activeSpace = null;
        setState({ kind: "needs-space-key", code: options.code, inputError: null }, null);
        return;
      }
      await loadWithSpaceKey(spaceKey);
    },

    async submitSpaceKey(spaceKey: string): Promise<void> {
      if (!isCanonicalSpaceKey(spaceKey)) {
        setState(
          {
            kind: "needs-space-key",
            code: options.code,
            inputError: { code: "INVALID_SPACE_KEY" },
          },
          null,
        );
        return;
      }
      try {
        setStoredSpaceKey(options.sessionStorage, spaceKey);
      } catch {
        setState(
          {
            kind: "needs-space-key",
            code: options.code,
            inputError: { code: "SPACE_KEY_STORAGE_ERROR" },
          },
          null,
        );
        return;
      }
      await loadWithSpaceKey(spaceKey);
    },

    async getRevisionHistory(signal?: AbortSignal): Promise<WorkspaceHistoryResult> {
      if (state.kind !== "ready" || !activeSpace) {
        return { ok: false, error: { code: "WORKSPACE_NOT_READY" } };
      }
      if (signal?.aborted) {
        return { ok: false, error: { code: "REQUEST_CANCELLED" } };
      }

      const space = activeSpace;
      let result;
      try {
        result = await space.client.getRevisionHistory(state.committed.code, signal);
      } catch {
        return { ok: false, error: { code: "NETWORK_ERROR" } };
      }
      if (activeSpace !== space || state.kind !== "ready") {
        return { ok: false, error: { code: "WORKSPACE_NOT_READY" } };
      }
      return result.ok ? { ok: true, value: result } : result;
    },

    async readRevision(revision: number, signal?: AbortSignal): Promise<WorkspaceCommandResult> {
      if (state.kind !== "ready" || !activeSpace) {
        return { ok: false, error: { code: "WORKSPACE_NOT_READY" } };
      }
      if (signal?.aborted) {
        return { ok: false, error: { code: "REQUEST_CANCELLED" } };
      }

      const space = activeSpace;
      let result: BrowserClientResult;
      try {
        result = await space.client.readRevision(state.committed.code, revision, signal);
      } catch {
        return { ok: false, error: { code: "NETWORK_ERROR" } };
      }
      if (activeSpace !== space || state.kind !== "ready") {
        return { ok: false, error: { code: "WORKSPACE_NOT_READY" } };
      }
      return result.ok ? { ok: true, value: result } : result;
    },

    updateMarkdown(markdown: string, surface: EditSurface = "human"): WorkspaceUpdateResult {
      if (state.kind !== "ready" || !activeSpace) {
        return { ok: false, error: { code: "WORKSPACE_NOT_READY" } };
      }
      if (state.commitPending) {
        return { ok: false, error: { code: "COMMIT_IN_PROGRESS" } };
      }
      const gate = checkRichWorkingDraftMarkdown(markdown);
      if (!gate.allowed) {
        return {
          ok: false,
          error: { code: "RICH_DRAFT_UNSUPPORTED", blocker: gate.blocker },
        };
      }
      const draft = state.workingDraft
        ? updateWorkingDraft(state.workingDraft, markdown, surface, now())
        : createWorkingDraft(
            {
              code: state.committed.code,
              revision: state.committed.revision,
              markdown: state.committed.markdown,
            },
            markdown,
            surface,
            now(),
          );
      let actionError: WorkspaceError | null = null;
      try {
        options.workingDraftStorage.save(activeSpace.localSpaceId, state.committed.code, draft);
      } catch {
        actionError = { code: "DRAFT_STORAGE_ERROR" };
      }
      const previousMarkdown = state.workingDraft?.markdown ?? state.committed.markdown;
      const markdownChanged = previousMarkdown !== draft.markdown;
      const reason: MarkdownChangeReason =
        markdownChanged && !actionError
          ? surface === "human"
            ? "human-edit"
            : "webmcp-replace"
          : null;
      const nextActionError =
        actionError ?? (state.actionError?.code === "REVISION_CONFLICT" ? state.actionError : null);
      setState({ ...state, workingDraft: draft, actionError: nextActionError }, reason);
      return actionError ? { ok: false, error: actionError } : { ok: true };
    },

    discard(): void {
      if (state.kind !== "ready" || !state.workingDraft || !activeSpace) return;
      try {
        options.workingDraftStorage.remove(activeSpace.localSpaceId, state.committed.code);
        setState({ ...state, workingDraft: null, actionError: null }, "workspace-reset");
      } catch {
        setState({ ...state, actionError: { code: "DRAFT_STORAGE_ERROR" } }, null);
      }
    },

    async commit(signal?: AbortSignal): Promise<WorkspaceCommandResult> {
      if (state.kind !== "ready" || !state.workingDraft || !activeSpace) {
        return { ok: false, error: { code: "NO_WORKING_DRAFT" } };
      }
      if (state.commitPending) {
        return { ok: false, error: { code: "COMMIT_IN_PROGRESS" } };
      }
      if (state.workingDraft.markdown.length === 0) {
        return { ok: false, error: { code: "EMPTY_MARKDOWN" } };
      }
      if (signal?.aborted) {
        return { ok: false, error: { code: "REQUEST_CANCELLED" } };
      }

      const draft = state.workingDraft;
      const committed = state.committed;
      const space = activeSpace;
      setState({ ...state, commitPending: true, actionError: null }, null);

      let result: BrowserClientResult;
      try {
        result = await space.client.appendRevision(
          {
            code: committed.code,
            baseRevision: draft.baseRevision,
            markdown: draft.markdown,
            origin: draft.lastModifiedVia,
          },
          signal,
        );
      } catch {
        result = { ok: false, error: { code: "NETWORK_ERROR" } };
      }

      if (state.kind !== "ready" || state.workingDraft !== draft || !state.commitPending) {
        return result.ok ? { ok: true, value: result } : result;
      }
      if (!result.ok) {
        setState({ ...state, commitPending: false, actionError: result.error }, null);
        return result;
      }

      try {
        options.workingDraftStorage.remove(space.localSpaceId, committed.code);
      } catch {
        setState(
          {
            ...state,
            committed: result,
            commitPending: false,
            actionError: { code: "DRAFT_STORAGE_ERROR" },
          },
          "workspace-reset",
        );
        return { ok: true, value: result };
      }

      setState(
        {
          kind: "ready",
          code: result.code,
          committed: result,
          workingDraft: null,
          commitPending: false,
          actionError: null,
        },
        "workspace-reset",
      );
      return { ok: true, value: result };
    },

    async resolveRevisionConflict(
      choice: RevisionConflictChoice,
      signal?: AbortSignal,
    ): Promise<WorkspaceCommandResult> {
      if (state.kind !== "ready" || !activeSpace) {
        return { ok: false, error: { code: "WORKSPACE_NOT_READY" } };
      }
      if (!state.workingDraft) {
        return { ok: false, error: { code: "NO_WORKING_DRAFT" } };
      }
      if (state.commitPending) {
        return { ok: false, error: { code: "COMMIT_IN_PROGRESS" } };
      }
      const conflict = state.actionError?.code === "REVISION_CONFLICT" ? state.actionError : null;
      if (!conflict) {
        return { ok: false, error: { code: "NO_REVISION_CONFLICT" } };
      }
      if (choice === "keep-working-draft" && state.workingDraft.markdown.length === 0) {
        return { ok: false, error: { code: "EMPTY_MARKDOWN" } };
      }
      if (signal?.aborted) {
        return { ok: false, error: { code: "REQUEST_CANCELLED" } };
      }

      const draft = state.workingDraft;
      const committed = state.committed;
      const space = activeSpace;
      setState({ ...state, commitPending: true }, null);

      let result: BrowserClientResult;
      try {
        result =
          choice === "use-server-latest"
            ? await space.client.getCurrent(committed.code, signal)
            : await space.client.appendRevision(
                {
                  code: committed.code,
                  baseRevision: conflict.expectedRevision,
                  markdown: draft.markdown,
                  origin: draft.lastModifiedVia,
                },
                signal,
              );
      } catch {
        result = { ok: false, error: { code: "NETWORK_ERROR" } };
      }

      if (state.kind !== "ready" || state.workingDraft !== draft || !state.commitPending) {
        return result.ok ? { ok: true, value: result } : result;
      }
      if (!result.ok) {
        setState(
          {
            ...state,
            commitPending: false,
            actionError: result.error.code === "REVISION_CONFLICT" ? result.error : conflict,
          },
          null,
        );
        return result;
      }

      try {
        options.workingDraftStorage.remove(space.localSpaceId, committed.code);
      } catch {
        if (choice === "use-server-latest") {
          setState({ ...state, commitPending: false, actionError: conflict }, null);
          return { ok: false, error: { code: "DRAFT_STORAGE_ERROR" } };
        }
        setState(
          {
            ...state,
            committed: result,
            commitPending: false,
            actionError: { code: "DRAFT_STORAGE_ERROR" },
          },
          "workspace-reset",
        );
        return { ok: true, value: result };
      }

      setState(
        {
          kind: "ready",
          code: result.code,
          committed: result,
          workingDraft: null,
          commitPending: false,
          actionError: null,
        },
        "workspace-reset",
      );
      return { ok: true, value: result };
    },
  };
}
