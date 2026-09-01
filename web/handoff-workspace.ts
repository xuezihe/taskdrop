import "./workspace.css";

import { createBrowserApiClient } from "./browser-api-client.js";
import {
  createHandoffWorkspaceController,
  type HandoffWorkspaceController,
  type MarkdownChangeReason,
  type WorkspaceError,
  type WorkspaceState,
} from "./handoff-workspace-controller.js";
import { createSessionWorkingDraftStorage } from "./handoff-session-storage.js";
import type { WorkingDraftEditor } from "./working-draft-editor.js";
import { bindHandoffWebMcpTools } from "./webmcp-registration.js";

type ReadyWorkspaceState = Extract<WorkspaceState, { kind: "ready" }>;

type WorkspaceView = {
  render(state: WorkspaceState, reason: MarkdownChangeReason): void;
  destroy(): void;
};

export async function mountHandoffWorkspace(root: HTMLElement, routeCode: string): Promise<void> {
  let sessionStorage: Storage;
  try {
    sessionStorage = window.sessionStorage;
  } catch {
    root.textContent = "This browser cannot provide a private session for the Handoff.";
    return;
  }

  const controller = createHandoffWorkspaceController({
    code: routeCode,
    sessionStorage,
    workingDraftStorage: createSessionWorkingDraftStorage(sessionStorage),
    createClient: (spaceKey) => createBrowserApiClient(spaceKey),
  });
  const view = createView(root, controller, routeCode);
  const unsubscribe = controller.subscribe(view.render);
  const webMcpBinding = bindHandoffWebMcpTools(controller);
  const dispose = (): void => {
    unsubscribe();
    webMcpBinding.dispose();
    view.destroy();
  };
  window.addEventListener("pagehide", dispose, { once: true });

  view.render(controller.getState(), null);
  await controller.open();
}

function createView(
  root: HTMLElement,
  controller: HandoffWorkspaceController,
  routeCode: string,
): WorkspaceView {
  const shell = document.createElement("main");
  shell.className = "workspace-shell";
  shell.setAttribute("aria-label", "Handoff Workspace");

  const keyGate = document.createElement("section");
  keyGate.className = "workspace-key-gate";
  keyGate.setAttribute("aria-labelledby", "workspace-key-title");

  const keyForm = document.createElement("form");
  keyForm.className = "workspace-key-form";
  const keyTitle = document.createElement("h1");
  keyTitle.id = "workspace-key-title";
  keyTitle.textContent = "Open Handoff";
  const keyLabel = document.createElement("label");
  keyLabel.htmlFor = "workspace-space-key";
  keyLabel.textContent = "Space Key";
  const keyInput = document.createElement("input");
  keyInput.id = "workspace-space-key";
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.spellcheck = false;
  keyInput.required = true;
  keyInput.placeholder = "tdp_...";
  const keySubmit = document.createElement("button");
  keySubmit.type = "submit";
  keySubmit.className = "workspace-key-submit";
  keySubmit.textContent = "Open Handoff";
  const keyMessage = document.createElement("p");
  keyMessage.className = "workspace-message";
  keyMessage.setAttribute("aria-live", "polite");
  keyForm.append(keyTitle, keyLabel, keyInput, keySubmit, keyMessage);
  keyGate.append(keyForm);

  const loadMessage = document.createElement("p");
  loadMessage.className = "workspace-load-message";
  loadMessage.setAttribute("aria-live", "polite");
  loadMessage.hidden = true;

  const layout = document.createElement("div");
  layout.className = "workspace-layout";
  layout.hidden = true;

  const sidebar = document.createElement("aside");
  sidebar.className = "workspace-sidebar";
  sidebar.setAttribute("aria-label", "Workspace navigation");

  const historySection = document.createElement("section");
  historySection.className =
    "workspace-sidebar-section workspace-history-section workspace-sidebar-section-grow";
  const historyTitle = document.createElement("h2");
  historyTitle.textContent = "History";
  const historyList = document.createElement("ul");
  historyList.className = "workspace-history-list";
  historyList.setAttribute("aria-label", "Handoff history");
  const workingDraftRow = document.createElement("li");
  workingDraftRow.className = "workspace-history-row workspace-history-row-active";
  const workingDraftMarker = document.createElement("span");
  workingDraftMarker.className = "workspace-history-marker";
  const workingDraftBody = document.createElement("div");
  const workingDraftName = document.createElement("span");
  workingDraftName.className = "workspace-history-name";
  workingDraftName.textContent = "Working Draft";
  const workingDraftMeta = document.createElement("span");
  workingDraftMeta.className = "workspace-history-meta";
  workingDraftMeta.textContent = "No local draft";
  workingDraftBody.append(workingDraftName, workingDraftMeta);
  workingDraftRow.append(workingDraftMarker, workingDraftBody);
  historyList.append(workingDraftRow);
  const historyEmpty = document.createElement("p");
  historyEmpty.className = "workspace-history-empty";
  historyEmpty.textContent = "Committed Revisions will appear here after Commit.";
  historySection.append(historyTitle, historyList, historyEmpty);

  const spaceSection = document.createElement("section");
  spaceSection.className = "workspace-sidebar-section";
  const spaceTitle = document.createElement("h2");
  spaceTitle.textContent = "Space";
  const spaceValue = document.createElement("p");
  spaceValue.className = "workspace-sidebar-value";
  spaceValue.textContent = "Current browser session";
  const changeKey = document.createElement("button");
  changeKey.type = "button";
  changeKey.className = "workspace-secondary workspace-change-key";
  changeKey.textContent = "Change Space Key";
  spaceSection.append(spaceTitle, spaceValue, changeKey);

  const handoffSection = document.createElement("section");
  handoffSection.className = "workspace-sidebar-section workspace-handoff-section";
  const handoffTitle = document.createElement("h2");
  handoffTitle.textContent = "Handoff";
  const handoffValue = document.createElement("div");
  handoffValue.className = "workspace-handoff-value";
  const handoffCode = document.createElement("code");
  handoffCode.textContent = routeCode;
  const copyCode = document.createElement("button");
  copyCode.type = "button";
  copyCode.className = "workspace-icon-button workspace-copy-button";
  copyCode.setAttribute("aria-label", "Copy Handoff code");
  copyCode.title = "Copy Handoff code";
  copyCode.textContent = "⧉";
  handoffValue.append(handoffCode, copyCode);
  handoffSection.append(handoffTitle, handoffValue);

  sidebar.append(historySection, spaceSection, handoffSection);

  const documentPanel = document.createElement("section");
  documentPanel.className = "workspace-document";
  documentPanel.setAttribute("aria-label", "Working Draft document");

  const contextBar = document.createElement("header");
  contextBar.className = "workspace-context-bar";
  const documentContext = document.createElement("div");
  documentContext.className = "workspace-document-context";
  const contextTitle = document.createElement("h1");
  contextTitle.className = "workspace-context-title";
  contextTitle.textContent = "TaskDrop Handoff";
  const contextMeta = document.createElement("div");
  contextMeta.className = "workspace-context-meta";
  const contextCode = document.createElement("span");
  const contextRevision = document.createElement("span");
  contextMeta.append(contextCode, contextRevision);
  documentContext.append(contextTitle, contextMeta);

  const statusPill = document.createElement("span");
  statusPill.className = "workspace-status-pill";
  statusPill.setAttribute("role", "status");
  statusPill.textContent = "No local Working Draft";

  const topbarActions = document.createElement("div");
  topbarActions.className = "workspace-context-actions";
  const commit = document.createElement("button");
  commit.type = "button";
  commit.className = "workspace-commit-button";
  commit.textContent = "Commit Revision";
  const overflow = document.createElement("button");
  overflow.type = "button";
  overflow.className = "workspace-icon-button workspace-overflow";
  overflow.setAttribute("aria-label", "More actions");
  overflow.setAttribute("aria-haspopup", "true");
  overflow.setAttribute("aria-expanded", "false");
  overflow.title = "More actions";
  overflow.textContent = "⋯";
  const overflowMenu = document.createElement("div");
  overflowMenu.className = "workspace-overflow-menu";
  overflowMenu.hidden = true;
  const discardMenuItem = document.createElement("button");
  discardMenuItem.type = "button";
  discardMenuItem.className = "workspace-overflow-item";
  discardMenuItem.textContent = "Discard";
  overflowMenu.append(discardMenuItem);
  const discardConfirm = document.createElement("div");
  discardConfirm.className = "workspace-discard-confirm";
  discardConfirm.hidden = true;
  const discardConfirmText = document.createElement("p");
  discardConfirmText.textContent = "Discard the current Working Draft? This cannot be undone.";
  const discardConfirmActions = document.createElement("div");
  const discardConfirmCancel = document.createElement("button");
  discardConfirmCancel.type = "button";
  discardConfirmCancel.className = "workspace-secondary";
  discardConfirmCancel.textContent = "Cancel";
  const discardConfirmAction = document.createElement("button");
  discardConfirmAction.type = "button";
  discardConfirmAction.className = "workspace-danger";
  discardConfirmAction.textContent = "Discard";
  discardConfirmActions.append(discardConfirmCancel, discardConfirmAction);
  discardConfirm.append(discardConfirmText, discardConfirmActions);
  overflowMenu.append(discardConfirm);
  topbarActions.append(commit, overflow, overflowMenu);
  contextBar.append(documentContext, statusPill, topbarActions);

  const actionMessage = document.createElement("p");
  actionMessage.className = "workspace-message workspace-action-message";
  actionMessage.setAttribute("aria-live", "polite");
  actionMessage.hidden = true;

  const editorViewport = document.createElement("div");
  editorViewport.className = "workspace-editor-viewport";
  const editorRoot = document.createElement("div");
  editorRoot.className = "workspace-editor-root";
  editorRoot.hidden = true;
  const editorState = document.createElement("div");
  editorState.className = "workspace-editor-state";
  editorState.setAttribute("role", "status");
  editorState.setAttribute("aria-live", "polite");
  const editorStateText = document.createElement("p");
  const editorRetry = document.createElement("button");
  editorRetry.type = "button";
  editorRetry.className = "workspace-secondary workspace-editor-retry";
  editorRetry.textContent = "Retry";
  editorRetry.hidden = true;
  editorState.append(editorStateText, editorRetry);
  editorViewport.append(editorState, editorRoot);

  documentPanel.append(contextBar, actionMessage, editorViewport);
  layout.append(sidebar, documentPanel);
  shell.append(keyGate, loadMessage, layout);
  root.replaceChildren(shell);
  document.title = `TaskDrop — Handoff ${routeCode}`;

  let editor: WorkingDraftEditor | null = null;
  let editorMounting = false;
  let editorError = false;
  let editorDestroying: Promise<void> | null = null;
  let mountSequence = 0;
  let overflowOpen = false;
  let destroyed = false;

  const effectiveMarkdown = (state: ReadyWorkspaceState): string =>
    state.workingDraft?.markdown ?? state.committed.markdown;

  const renderEditorState = (): void => {
    if (editor) {
      editorRoot.hidden = false;
      editorState.hidden = true;
      return;
    }

    editorRoot.hidden = true;
    if (editorMounting) {
      editorState.hidden = false;
      editorStateText.textContent = "Loading document editor…";
      editorRetry.hidden = true;
    } else if (editorError) {
      editorState.hidden = false;
      editorStateText.textContent = "The document editor could not be loaded.";
      editorRetry.hidden = false;
    } else {
      editorState.hidden = true;
      editorStateText.textContent = "";
      editorRetry.hidden = true;
    }
  };

  const destroyEditor = (): void => {
    mountSequence += 1;
    editorMounting = false;
    editorError = false;
    const activeEditor = editor;
    editor = null;
    editorRoot.replaceChildren();
    if (activeEditor) {
      editorDestroying = activeEditor.destroy().catch(() => undefined);
    }
    renderEditorState();
  };

  const mountEditor = async (): Promise<void> => {
    if (destroyed || editor || editorMounting || editorError) return;
    const state = controller.getState();
    if (state.kind !== "ready") return;

    const sequence = ++mountSequence;
    editorMounting = true;
    editorError = false;
    renderEditorState();

    const previousDestroy = editorDestroying;
    if (previousDestroy) await previousDestroy;
    if (destroyed || sequence !== mountSequence) return;

    try {
      const { mountWorkingDraftEditor } = await import("./working-draft-editor.js");
      const current = controller.getState();
      if (current.kind !== "ready") return;
      const mountedEditor = await mountWorkingDraftEditor({
        root: editorRoot,
        markdown: effectiveMarkdown(current),
        onHumanMarkdown: (value) => {
          const latest = controller.getState();
          if (latest.kind !== "ready" || latest.commitPending) return;
          controller.updateMarkdown(value, "human");
        },
      });

      if (destroyed || sequence !== mountSequence || controller.getState().kind !== "ready") {
        await mountedEditor.destroy();
        return;
      }

      editor = mountedEditor;
      editorMounting = false;
      editorDestroying = null;
      render(controller.getState(), "workspace-reset");
    } catch {
      if (destroyed || sequence !== mountSequence) return;
      editorMounting = false;
      editorError = true;
      editorRoot.replaceChildren();
      renderEditorState();
    }
  };

  const showOverflow = (show: boolean): void => {
    overflowOpen = show;
    overflowMenu.hidden = !show;
    overflow.setAttribute("aria-expanded", String(show));
  };

  const showDiscardConfirm = (show: boolean): void => {
    discardMenuItem.hidden = show;
    discardConfirm.hidden = !show;
  };

  const renderState = (state: WorkspaceState): void => {
    const isReady = state.kind === "ready";
    const isLoading = state.kind === "loading";
    const isNeedsKey = state.kind === "needs-space-key";
    const isLoadError = state.kind === "load-error";

    keyGate.hidden = !isNeedsKey && !isLoadError;
    layout.hidden = !isReady;
    loadMessage.hidden = !isLoading;
    loadMessage.textContent = isLoading ? "Loading Handoff…" : "";
    keyMessage.textContent = isNeedsKey
      ? state.inputError
        ? describeError(state.inputError)
        : ""
      : isLoadError
        ? describeError(state.error)
        : "";

    if (!isReady) {
      contextCode.textContent = "";
      contextRevision.textContent = "";
      statusPill.textContent = isLoading ? "Loading" : "Open a Handoff";
      statusPill.className = "workspace-status-pill";
      commit.disabled = true;
      discardMenuItem.disabled = true;
      discardConfirmAction.disabled = true;
      actionMessage.hidden = true;
      renderEditorState();
      return;
    }

    contextCode.textContent = state.code;
    contextRevision.textContent = `Revision ${state.committed.revision}`;
    statusPill.textContent = topbarStatusText(state);
    statusPill.className = `workspace-status-pill ${
      state.workingDraft ? "workspace-status-pill-active" : ""
    }`;
    workingDraftMeta.textContent = draftStatusText(state);
    handoffCode.textContent = state.code;
    commit.disabled = state.workingDraft === null || state.commitPending;
    discardMenuItem.disabled = state.workingDraft === null || state.commitPending;
    discardConfirmAction.disabled = state.workingDraft === null || state.commitPending;
    const message = state.commitPending
      ? "Committing Revision…"
      : state.actionError
        ? describeError(state.actionError)
        : "";
    actionMessage.hidden = message.length === 0;
    actionMessage.textContent = message;
  };

  const render = (state: WorkspaceState, reason: MarkdownChangeReason): void => {
    renderState(state);

    if (state.kind !== "ready") {
      destroyEditor();
      return;
    }

    if (!editor && !editorMounting && !editorError) {
      void mountEditor();
    }
    if (!editor) {
      renderEditorState();
      return;
    }

    const markdown = effectiveMarkdown(state);
    if (reason === "webmcp-replace") {
      editor.replaceMarkdown({ markdown, history: "record" });
    } else if (reason === "workspace-reset") {
      editor.replaceMarkdown({ markdown, history: "reset" });
    }
    editor.setReadOnly(state.commitPending);
    renderEditorState();
  };

  keyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.submitSpaceKey(keyInput.value);
  });
  changeKey.addEventListener("click", () => {
    destroyEditor();
    keyGate.hidden = false;
    layout.hidden = true;
    loadMessage.hidden = true;
    keyInput.value = "";
    keyInput.focus();
  });
  commit.addEventListener("click", () => void controller.commit());
  overflow.addEventListener("click", () => showOverflow(!overflowOpen));
  discardMenuItem.addEventListener("click", () => showDiscardConfirm(true));
  discardConfirmCancel.addEventListener("click", () => showDiscardConfirm(false));
  discardConfirmAction.addEventListener("click", () => {
    showDiscardConfirm(false);
    showOverflow(false);
    controller.discard();
  });
  editorRetry.addEventListener("click", () => {
    editorError = false;
    render(controller.getState(), "workspace-reset");
  });
  copyCode.addEventListener("click", () => {
    const state = controller.getState();
    const code = state.kind === "ready" ? state.code : routeCode;
    void navigator.clipboard.writeText(code);
  });
  const documentClickHandler = (event: MouseEvent): void => {
    if (!overflowOpen) return;
    if (
      event.target instanceof Node &&
      !overflowMenu.contains(event.target) &&
      event.target !== overflow
    ) {
      showOverflow(false);
    }
  };
  document.addEventListener("click", documentClickHandler);

  return {
    render,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      document.removeEventListener("click", documentClickHandler);
      destroyEditor();
    },
  };
}

function draftStatusText(state: ReadyWorkspaceState): string {
  if (!state.workingDraft) return "No local draft";
  if (state.commitPending) return "Commit pending";
  if (state.actionError) return "Recoverable error";
  return state.workingDraft.lastModifiedVia === "human" ? "Edited by you" : "Updated by WebMCP";
}

function topbarStatusText(state: ReadyWorkspaceState): string {
  if (state.commitPending) return "Committing Revision…";
  if (state.actionError) return "Draft error";
  if (!state.workingDraft) return "No local Working Draft";
  return state.workingDraft.lastModifiedVia === "human"
    ? "Draft saved locally · Human"
    : "Draft saved locally · WebMCP";
}

function describeError(error: WorkspaceError): string {
  switch (error.code) {
    case "INVALID_SPACE_KEY":
      return "Enter a valid Space Key.";
    case "SPACE_KEY_STORAGE_ERROR":
      return "This browser could not save the Space Key for this session.";
    case "NO_WORKING_DRAFT":
      return "Edit the Markdown before committing.";
    case "EMPTY_MARKDOWN":
      return "The Working Draft is empty. Add Markdown before committing.";
    case "DRAFT_STORAGE_ERROR":
      return "The browser could not save the Working Draft in this session.";
    case "WORKSPACE_NOT_READY":
      return "Open the Handoff before editing or reading its Workspace.";
    case "COMMIT_IN_PROGRESS":
      return "Wait for the current Commit to finish before editing.";
    case "REQUEST_CANCELLED":
      return "The Handoff request was cancelled. Your local Draft is preserved.";
    case "NETWORK_ERROR":
      return "The Handoff service could not be reached. Your local Draft is preserved.";
    case "INVALID_RESPONSE":
      return "The Handoff service returned an invalid response. Your local Draft is preserved.";
    case "UNAUTHORIZED":
      return "The Space Key was not accepted.";
    case "HANDOFF_NOT_FOUND":
      return "This Handoff is not available in the active Space.";
    case "REVISION_CONFLICT":
      return "The Handoff changed elsewhere. Your local Draft is preserved for review.";
    case "REVISION_LIMIT_REACHED":
      return "This Handoff has reached its Revision limit. Your local Draft is preserved.";
    case "SPACE_QUOTA_EXCEEDED":
      return "The Space quota was reached. Your local Draft is preserved.";
    case "CONTENT_TOO_LARGE":
      return "This Markdown is too large for a committed Revision. Your local Draft is preserved.";
    case "INVALID_REQUEST":
    case "METHOD_NOT_ALLOWED":
    case "NOT_FOUND":
      return "The Handoff request was not accepted. Your local Draft is preserved.";
    case "INTERNAL_ERROR":
      return "The Handoff service failed this request. Your local Draft is preserved.";
  }
}
