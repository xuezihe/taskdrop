import { isCanonicalSpaceKey } from "../src/production/space-identity.js";

import {
  deriveLocalSpaceId,
  getStoredSpaceKey,
  removeStoredSpaceKey,
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
  changeSpaceKey(): void;
  dispose(): void;
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
  type WorkspaceContext = { controller: AbortController };
  type ActiveSpace = {
    context: WorkspaceContext;
    localSpaceId: string;
    client: BrowserApiClient;
  };

  const listeners = new Set<WorkspaceListener>();
  const now = options.now ?? (() => new Date().toISOString());
  let state: WorkspaceState = {
    kind: "needs-space-key",
    code: options.code,
    inputError: null,
  };
  let activeSpace: ActiveSpace | null = null;
  let context: WorkspaceContext = { controller: new AbortController() };
  let disposed = false;

  const notify = (reason: MarkdownChangeReason): void => {
    for (const listener of listeners) listener(state, reason);
  };

  const setState = (next: WorkspaceState, reason: MarkdownChangeReason): void => {
    state = next;
    notify(reason);
  };

  const replaceContext = (): WorkspaceContext => {
    context.controller.abort();
    context = { controller: new AbortController() };
    activeSpace = null;
    return context;
  };

  const isCurrentContext = (candidate: WorkspaceContext): boolean =>
    !disposed && context === candidate && !candidate.controller.signal.aborted;

  const isCurrentSpace = (candidate: ActiveSpace): boolean =>
    isCurrentContext(candidate.context) && activeSpace === candidate && state.kind === "ready";

  const requestSignal = (
    candidate: WorkspaceContext,
    callerSignal: AbortSignal | undefined,
  ): AbortSignal =>
    callerSignal
      ? AbortSignal.any([candidate.controller.signal, callerSignal])
      : candidate.controller.signal;

  const cancelled = (): { ok: false; error: { code: "REQUEST_CANCELLED" } } => ({
    ok: false,
    error: { code: "REQUEST_CANCELLED" },
  });

  const loadWithSpaceKey = async (
    spaceKey: string,
    nextContext: WorkspaceContext = replaceContext(),
  ): Promise<void> => {
    if (disposed) return;
    setState({ kind: "loading", code: options.code }, null);

    try {
      const localSpaceId = await deriveLocalSpaceId(spaceKey);
      if (!isCurrentContext(nextContext)) return;
      const client = options.createClient(spaceKey);
      const result = await client.getCurrent(options.code, nextContext.controller.signal);
      if (!isCurrentContext(nextContext)) return;
      if (!result.ok) {
        setState({ kind: "load-error", code: options.code, error: result.error }, null);
        return;
      }

      const workingDraft = options.workingDraftStorage.load(localSpaceId, result.code);
      activeSpace = { context: nextContext, localSpaceId, client };
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
      if (!isCurrentContext(nextContext)) return;
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
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async open(): Promise<void> {
      if (disposed) return;
      const spaceKey = getStoredSpaceKey(options.sessionStorage);
      if (!spaceKey) {
        replaceContext();
        setState({ kind: "needs-space-key", code: options.code, inputError: null }, null);
        return;
      }
      await loadWithSpaceKey(spaceKey);
    },

    async submitSpaceKey(spaceKey: string): Promise<void> {
      if (!isCanonicalSpaceKey(spaceKey)) {
        if (disposed) return;
        replaceContext();
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
      if (disposed) return;
      const nextContext = replaceContext();
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
      await loadWithSpaceKey(spaceKey, nextContext);
    },

    changeSpaceKey(): void {
      if (disposed) return;
      replaceContext();
      try {
        removeStoredSpaceKey(options.sessionStorage);
        setState({ kind: "needs-space-key", code: options.code, inputError: null }, null);
      } catch {
        setState(
          {
            kind: "needs-space-key",
            code: options.code,
            inputError: { code: "SPACE_KEY_STORAGE_ERROR" },
          },
          null,
        );
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      context.controller.abort();
      activeSpace = null;
      state = { kind: "needs-space-key", code: options.code, inputError: null };
      notify(null);
      listeners.clear();
    },

    async getRevisionHistory(signal?: AbortSignal): Promise<WorkspaceHistoryResult> {
      if (disposed || state.kind !== "ready" || !activeSpace) {
        return { ok: false, error: { code: "WORKSPACE_NOT_READY" } };
      }
      if (signal?.aborted) {
        return { ok: false, error: { code: "REQUEST_CANCELLED" } };
      }

      const space = activeSpace;
      const combinedSignal = requestSignal(space.context, signal);
      let result;
      try {
        result = await space.client.getRevisionHistory(state.committed.code, combinedSignal);
      } catch {
        if (combinedSignal.aborted) return cancelled();
        return { ok: false, error: { code: "NETWORK_ERROR" } };
      }
      if (combinedSignal.aborted) return cancelled();
      if (activeSpace !== space || state.kind !== "ready") {
        return { ok: false, error: { code: "WORKSPACE_NOT_READY" } };
      }
      return result.ok ? { ok: true, value: result } : result;
    },

    async readRevision(revision: number, signal?: AbortSignal): Promise<WorkspaceCommandResult> {
      if (disposed || state.kind !== "ready" || !activeSpace) {
        return { ok: false, error: { code: "WORKSPACE_NOT_READY" } };
      }
      if (signal?.aborted) {
        return { ok: false, error: { code: "REQUEST_CANCELLED" } };
      }

      const space = activeSpace;
      const combinedSignal = requestSignal(space.context, signal);
      let result: BrowserClientResult;
      try {
        result = await space.client.readRevision(state.committed.code, revision, combinedSignal);
      } catch {
        if (combinedSignal.aborted) return cancelled();
        return { ok: false, error: { code: "NETWORK_ERROR" } };
      }
      if (combinedSignal.aborted) return cancelled();
      if (activeSpace !== space || state.kind !== "ready") {
        return { ok: false, error: { code: "WORKSPACE_NOT_READY" } };
      }
      return result.ok ? { ok: true, value: result } : result;
    },

    updateMarkdown(markdown: string, surface: EditSurface = "human"): WorkspaceUpdateResult {
      if (disposed || state.kind !== "ready" || !activeSpace) {
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
      if (disposed || state.kind !== "ready" || !state.workingDraft || !activeSpace) return;
      try {
        options.workingDraftStorage.remove(activeSpace.localSpaceId, state.committed.code);
        setState({ ...state, workingDraft: null, actionError: null }, "workspace-reset");
      } catch {
        setState({ ...state, actionError: { code: "DRAFT_STORAGE_ERROR" } }, null);
      }
    },

    async commit(signal?: AbortSignal): Promise<WorkspaceCommandResult> {
      if (disposed) {
        return { ok: false, error: { code: "WORKSPACE_NOT_READY" } };
      }
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
      const combinedSignal = requestSignal(space.context, signal);
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
          combinedSignal,
        );
      } catch {
        result = { ok: false, error: { code: "NETWORK_ERROR" } };
      }

      if (combinedSignal.aborted) {
        if (!isCurrentSpace(space) || state.workingDraft !== draft || !state.commitPending) {
          return cancelled();
        }
        setState(
          { ...state, commitPending: false, actionError: { code: "REQUEST_CANCELLED" } },
          null,
        );
        return cancelled();
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
      if (disposed || state.kind !== "ready" || !activeSpace) {
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
      const combinedSignal = requestSignal(space.context, signal);
      setState({ ...state, commitPending: true }, null);

      let result: BrowserClientResult;
      try {
        result =
          choice === "use-server-latest"
            ? await space.client.getCurrent(committed.code, combinedSignal)
            : await space.client.appendRevision(
                {
                  code: committed.code,
                  baseRevision: conflict.expectedRevision,
                  markdown: draft.markdown,
                  origin: draft.lastModifiedVia,
                },
                combinedSignal,
              );
      } catch {
        result = { ok: false, error: { code: "NETWORK_ERROR" } };
      }

      if (combinedSignal.aborted) {
        if (!isCurrentSpace(space) || state.workingDraft !== draft || !state.commitPending) {
          return cancelled();
        }
        setState(
          { ...state, commitPending: false, actionError: { code: "REQUEST_CANCELLED" } },
          null,
        );
        return cancelled();
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
