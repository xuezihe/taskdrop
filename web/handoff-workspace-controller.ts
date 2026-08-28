import { isCanonicalSpaceKey } from "../src/production/space-identity.js";

import {
  deriveLocalSpaceId,
  getStoredSpaceKey,
  setStoredSpaceKey,
  type WorkingDraftStorage,
} from "./handoff-session-storage.js";
import { createWorkingDraft, updateWorkingDraft, type WorkingDraft } from "./working-draft.js";
import type {
  BrowserApiClient,
  BrowserApiError,
  BrowserClientError,
  BrowserClientResult,
  BrowserRevision,
} from "./browser-api-client.js";

export type WorkspaceLocalError =
  | { code: "INVALID_SPACE_KEY" }
  | { code: "SPACE_KEY_STORAGE_ERROR" }
  | { code: "NO_WORKING_DRAFT" }
  | { code: "EMPTY_MARKDOWN" }
  | { code: "DRAFT_STORAGE_ERROR" };

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

export interface HandoffWorkspaceController {
  getState(): WorkspaceState;
  subscribe(listener: (state: WorkspaceState) => void): () => void;
  open(): Promise<void>;
  submitSpaceKey(spaceKey: string): Promise<void>;
  updateMarkdown(markdown: string): void;
  discard(): void;
  commit(): Promise<WorkspaceCommandResult>;
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
  const listeners = new Set<(state: WorkspaceState) => void>();
  const now = options.now ?? (() => new Date().toISOString());
  let state: WorkspaceState = {
    kind: "needs-space-key",
    code: options.code,
    inputError: null,
  };
  let activeSpace: { localSpaceId: string; client: BrowserApiClient } | null = null;
  let loadSequence = 0;

  const notify = (): void => {
    for (const listener of listeners) listener(state);
  };

  const setState = (next: WorkspaceState): void => {
    state = next;
    notify();
  };

  const loadWithSpaceKey = async (spaceKey: string): Promise<void> => {
    const sequence = ++loadSequence;
    activeSpace = null;
    setState({ kind: "loading", code: options.code });

    try {
      const localSpaceId = await deriveLocalSpaceId(spaceKey);
      const client = options.createClient(spaceKey);
      const result = await client.getCurrent(options.code);
      if (sequence !== loadSequence) return;
      if (!result.ok) {
        setState({ kind: "load-error", code: options.code, error: result.error });
        return;
      }

      const workingDraft = options.workingDraftStorage.load(localSpaceId, result.code);
      activeSpace = { localSpaceId, client };
      setState({
        kind: "ready",
        code: result.code,
        committed: result,
        workingDraft,
        commitPending: false,
        actionError: null,
      });
    } catch {
      if (sequence !== loadSequence) return;
      setState({
        kind: "load-error",
        code: options.code,
        error: { code: "NETWORK_ERROR" },
      });
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
        setState({ kind: "needs-space-key", code: options.code, inputError: null });
        return;
      }
      await loadWithSpaceKey(spaceKey);
    },

    async submitSpaceKey(spaceKey: string): Promise<void> {
      if (!isCanonicalSpaceKey(spaceKey)) {
        setState({
          kind: "needs-space-key",
          code: options.code,
          inputError: { code: "INVALID_SPACE_KEY" },
        });
        return;
      }
      try {
        setStoredSpaceKey(options.sessionStorage, spaceKey);
      } catch {
        setState({
          kind: "needs-space-key",
          code: options.code,
          inputError: { code: "SPACE_KEY_STORAGE_ERROR" },
        });
        return;
      }
      await loadWithSpaceKey(spaceKey);
    },

    updateMarkdown(markdown: string): void {
      if (state.kind !== "ready" || state.commitPending || !activeSpace) return;
      const draft = state.workingDraft
        ? updateWorkingDraft(state.workingDraft, markdown, "human", now())
        : createWorkingDraft(
            {
              code: state.committed.code,
              revision: state.committed.revision,
              markdown: state.committed.markdown,
            },
            markdown,
            "human",
            now(),
          );
      let actionError: WorkspaceError | null = null;
      try {
        options.workingDraftStorage.save(activeSpace.localSpaceId, state.committed.code, draft);
      } catch {
        actionError = { code: "DRAFT_STORAGE_ERROR" };
      }
      setState({ ...state, workingDraft: draft, actionError });
    },

    discard(): void {
      if (state.kind !== "ready" || !state.workingDraft || !activeSpace) return;
      try {
        options.workingDraftStorage.remove(activeSpace.localSpaceId, state.committed.code);
        setState({ ...state, workingDraft: null, actionError: null });
      } catch {
        setState({ ...state, actionError: { code: "DRAFT_STORAGE_ERROR" } });
      }
    },

    async commit(): Promise<WorkspaceCommandResult> {
      if (state.kind !== "ready" || !state.workingDraft || !activeSpace) {
        return { ok: false, error: { code: "NO_WORKING_DRAFT" } };
      }
      if (state.workingDraft.markdown.length === 0) {
        return { ok: false, error: { code: "EMPTY_MARKDOWN" } };
      }

      const draft = state.workingDraft;
      const committed = state.committed;
      const space = activeSpace;
      setState({ ...state, commitPending: true, actionError: null });

      let result: BrowserClientResult;
      try {
        result = await space.client.appendRevision({
          code: committed.code,
          baseRevision: draft.baseRevision,
          markdown: draft.markdown,
          origin: draft.lastModifiedVia,
        });
      } catch {
        result = { ok: false, error: { code: "NETWORK_ERROR" } };
      }

      if (state.kind !== "ready" || state.workingDraft !== draft || !state.commitPending) {
        return result.ok ? { ok: true, value: result } : result;
      }
      if (!result.ok) {
        setState({ ...state, commitPending: false, actionError: result.error });
        return result;
      }

      try {
        options.workingDraftStorage.remove(space.localSpaceId, committed.code);
      } catch {
        setState({
          ...state,
          committed: result,
          commitPending: false,
          actionError: { code: "DRAFT_STORAGE_ERROR" },
        });
        return { ok: true, value: result };
      }

      setState({
        kind: "ready",
        code: result.code,
        committed: result,
        workingDraft: null,
        commitPending: false,
        actionError: null,
      });
      return { ok: true, value: result };
    },
  };
}
