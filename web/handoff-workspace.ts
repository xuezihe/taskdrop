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
  controller.subscribe(view.render);
  const webMcpBinding = bindHandoffWebMcpTools(controller);
  window.addEventListener("pagehide", () => webMcpBinding.dispose(), { once: true });
  view.render(controller.getState(), null);
  await controller.open();
}

function createView(
  root: HTMLElement,
  controller: HandoffWorkspaceController,
  routeCode: string,
): { render(state: WorkspaceState, reason: MarkdownChangeReason): void } {
  const shell = document.createElement("main");
  shell.className = "workspace-shell";

  const keyForm = document.createElement("form");
  keyForm.className = "workspace-key-form";
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
  keySubmit.className = "workspace-primary";
  keySubmit.textContent = "Open Handoff";
  const keyMessage = document.createElement("p");
  keyMessage.className = "workspace-message";
  keyMessage.setAttribute("aria-live", "polite");
  keyForm.append(keyLabel, keyInput, keySubmit, keyMessage);

  const loadMessage = document.createElement("p");
  loadMessage.className = "workspace-load-message";
  loadMessage.setAttribute("aria-live", "polite");

  const layout = document.createElement("div");
  layout.className = "workspace-layout";
  layout.hidden = true;

  const sidebar = document.createElement("aside");
  sidebar.className = "workspace-sidebar";

  const historySection = document.createElement("section");
  historySection.className = "workspace-sidebar-section";
  const historyTitle = document.createElement("h2");
  historyTitle.textContent = "History";
  const historyList = document.createElement("ul");
  historyList.className = "workspace-history-list";
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
  handoffSection.className = "workspace-sidebar-section";
  const handoffTitle = document.createElement("h2");
  handoffTitle.textContent = "Handoff";
  const handoffValue = document.createElement("div");
  handoffValue.className = "workspace-handoff-value";
  const handoffCode = document.createElement("code");
  handoffCode.textContent = routeCode;
  const copyCode = document.createElement("button");
  copyCode.type = "button";
  copyCode.className = "workspace-icon-button";
  copyCode.setAttribute("aria-label", "Copy Handoff code");
  copyCode.title = "Copy Handoff code";
  copyCode.textContent = "\u2398";
  handoffValue.append(handoffCode, copyCode);
  handoffSection.append(handoffTitle, handoffValue);

  sidebar.append(historySection, spaceSection, handoffSection);

  const main = document.createElement("div");
  main.className = "workspace-main";

  const topbar = document.createElement("div");
  topbar.className = "workspace-topbar";
  const topbarTitle = document.createElement("h1");
  topbarTitle.className = "workspace-topbar-title";
  topbarTitle.textContent = "TaskDrop Handoff";
  const statusPill = document.createElement("span");
  statusPill.className = "workspace-status-pill";
  statusPill.textContent = "No local draft";
  const topbarActions = document.createElement("div");
  topbarActions.className = "workspace-topbar-actions";
  const commit = document.createElement("button");
  commit.type = "button";
  commit.className = "workspace-primary";
  commit.textContent = "Commit Revision";
  const overflow = document.createElement("button");
  overflow.type = "button";
  overflow.className = "workspace-icon-button workspace-overflow";
  overflow.setAttribute("aria-label", "More actions");
  overflow.setAttribute("aria-haspopup", "true");
  overflow.setAttribute("aria-expanded", "false");
  overflow.textContent = "\u22ee";
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
  const discardConfirmCancel = document.createElement("button");
  discardConfirmCancel.type = "button";
  discardConfirmCancel.className = "workspace-secondary";
  discardConfirmCancel.textContent = "Cancel";
  const discardConfirmAction = document.createElement("button");
  discardConfirmAction.type = "button";
  discardConfirmAction.className = "workspace-danger";
  discardConfirmAction.textContent = "Discard";
  discardConfirm.append(discardConfirmText, discardConfirmCancel, discardConfirmAction);
  overflowMenu.append(discardConfirm);
  topbarActions.append(commit, overflow, overflowMenu);
  topbar.append(topbarTitle, statusPill, topbarActions);

  const actionMessage = document.createElement("p");
  actionMessage.className = "workspace-message workspace-topbar-message";
  actionMessage.setAttribute("aria-live", "polite");

  const editorCanvas = document.createElement("div");
  editorCanvas.className = "workspace-editor-canvas";

  main.append(topbar, actionMessage, editorCanvas);
  layout.append(sidebar, main);
  shell.append(keyForm, loadMessage, layout);
  root.replaceChildren(shell);
  document.title = `TaskDrop — Handoff ${routeCode}`;

  let editor: WorkingDraftEditor | null = null;
  let editorMounting = false;
  let overflowOpen = false;
  let confirmingDiscard = false;

  const showOverflow = (show: boolean): void => {
    overflowOpen = show;
    overflowMenu.hidden = !show;
    overflow.setAttribute("aria-expanded", String(show));
  };

  const showDiscardConfirm = (show: boolean): void => {
    confirmingDiscard = show;
    discardMenuItem.hidden = show;
    discardConfirm.hidden = !show;
  };

  const destroyEditor = (): void => {
    if (editorMounting) editorMounting = false;
    if (editor) {
      const ed = editor;
      editor = null;
      void ed.destroy();
    }
  };

  const effectiveMarkdown = (state: Extract<WorkspaceState, { kind: "ready" }>): string =>
    state.workingDraft?.markdown ?? state.committed.markdown;

  const mountEditor = async (): Promise<void> => {
    if (editor || editorMounting) return;
    const state = controller.getState();
    if (state.kind !== "ready") return;
    editorMounting = true;
    const markdown = effectiveMarkdown(state);
    try {
      const { mountWorkingDraftEditor } = await import("./working-draft-editor.js");
      const ed = await mountWorkingDraftEditor({
        root: editorCanvas,
        markdown,
        onHumanMarkdown: (value) => {
          const current = controller.getState();
          if (current.kind !== "ready" || current.commitPending) return;
          controller.updateMarkdown(value, "human");
        },
      });
      if (!editorMounting) {
        void ed.destroy();
        return;
      }
      editor = ed;
      editorMounting = false;
      render(controller.getState(), "workspace-reset");
    } catch {
      editorMounting = false;
    }
  };

  keyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.submitSpaceKey(keyInput.value);
  });
  changeKey.addEventListener("click", () => {
    destroyEditor();
    keyForm.hidden = false;
    keyInput.value = "";
    keyInput.focus();
    layout.hidden = true;
    loadMessage.textContent = "";
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
  copyCode.addEventListener("click", () => {
    const state = controller.getState();
    const code = state.kind === "ready" ? state.code : routeCode;
    void navigator.clipboard.writeText(code);
  });
  document.addEventListener("click", (event) => {
    if (!overflowOpen) return;
    if (
      event.target instanceof Node &&
      !overflowMenu.contains(event.target) &&
      event.target !== overflow
    ) {
      showOverflow(false);
    }
  });

  function render(state: WorkspaceState, reason: MarkdownChangeReason): void {
    const isReady = state.kind === "ready";
    const isLoading = state.kind === "loading";
    const isNeedsKey = state.kind === "needs-space-key";
    const isLoadError = state.kind === "load-error";

    keyForm.hidden = !isNeedsKey && !isLoadError;
    layout.hidden = !isReady;
    loadMessage.textContent = isLoading
      ? "Loading the committed Revision…"
      : isLoadError
        ? describeError(state.error)
        : "";

    if (isNeedsKey) {
      keyMessage.textContent = state.inputError ? describeError(state.inputError) : "";
    } else {
      keyMessage.textContent = "";
    }

    if (!isReady) {
      destroyEditor();
      return;
    }

    if (!editor && !editorMounting) {
      void mountEditor();
      return;
    }
    if (editorMounting) return;
    if (!editor) return;

    const markdown = effectiveMarkdown(state);
    if (reason === "human-edit") {
      // Editor already contains the Human change; no replacement needed.
    } else if (reason === "webmcp-replace") {
      editor.replaceMarkdown({ markdown, history: "record" });
    } else if (reason === "workspace-reset") {
      editor.replaceMarkdown({ markdown, history: "reset" });
    }
    editor.setReadOnly(state.commitPending);

    workingDraftMeta.textContent = draftStatusText(state);
    statusPill.textContent = topbarStatusText(state);
    statusPill.className = `workspace-status-pill ${state.workingDraft ? "workspace-status-pill-active" : ""}`;
    topbarTitle.textContent = `Handoff ${state.code}`;
    handoffCode.textContent = state.code;
    commit.disabled = state.workingDraft === null || state.commitPending;
    discardMenuItem.disabled = state.workingDraft === null || state.commitPending;
    discardConfirmAction.disabled = state.workingDraft === null || state.commitPending;
    actionMessage.textContent = state.commitPending
      ? "Committing Revision…"
      : state.actionError
        ? describeError(state.actionError)
        : "";
  }

  return { render };
}

function draftStatusText(state: Extract<WorkspaceState, { kind: "ready" }>): string {
  if (!state.workingDraft) return "No local draft";
  if (state.commitPending) return "Commit pending";
  if (state.actionError) return "Recoverable error";
  return state.workingDraft.lastModifiedVia === "human" ? "Edited by you" : "Updated by WebMCP";
}

function topbarStatusText(state: Extract<WorkspaceState, { kind: "ready" }>): string {
  if (state.commitPending) return "Committing Revision…";
  if (state.actionError) return "Draft error";
  if (!state.workingDraft) return "No local Working Draft";
  return state.workingDraft.lastModifiedVia === "human"
    ? "Draft saved locally · Human"
    : "Draft saved locally · WebMCP";
}

function formatExpiry(expiresAt: string): string {
  const timestamp = Date.parse(expiresAt);
  if (Number.isNaN(timestamp)) return "later";
  return new Date(timestamp).toLocaleString();
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
