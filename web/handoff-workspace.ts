import "./workspace.css";

import { createBrowserApiClient } from "./browser-api-client.js";
import type { BrowserRevision, BrowserRevisionHistory } from "./browser-api-client.js";
import {
  createHandoffWorkspaceController,
  type HandoffWorkspaceController,
  type MarkdownChangeReason,
  type RevisionConflictChoice,
  type WorkspaceError,
  type WorkspaceState,
} from "./handoff-workspace-controller.js";
import { createSessionWorkingDraftStorage } from "./handoff-session-storage.js";
import { renderMarkdownToHtml } from "./markdown-preview.js";
import {
  checkRichWorkingDraftMarkdown,
  type RichWorkingDraftBlocker,
} from "./rich-working-draft-gate.js";
import type { WorkingDraftEditor } from "./working-draft-editor.js";
import { bindHandoffWebMcpTools } from "./webmcp-registration.js";

type ReadyWorkspaceState = Extract<WorkspaceState, { kind: "ready" }>;

type WorkspaceView = {
  render(state: WorkspaceState, reason: MarkdownChangeReason): void;
  destroy(): void;
};

type RevisionHistoryViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; history: BrowserRevisionHistory }
  | { kind: "error"; error: WorkspaceError };

type DocumentSelection =
  | { kind: "working-draft" }
  | { kind: "historical-loading"; revision: number }
  | { kind: "historical"; snapshot: BrowserRevision }
  | { kind: "historical-error"; revision: number; error: WorkspaceError };

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
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    controller.dispose();
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
  const workingDraftButton = document.createElement("button");
  workingDraftButton.type = "button";
  workingDraftButton.className = "workspace-history-button";
  workingDraftButton.setAttribute("aria-current", "page");
  const workingDraftMarker = document.createElement("span");
  workingDraftMarker.className = "workspace-history-marker";
  const workingDraftBody = document.createElement("div");
  const workingDraftName = document.createElement("span");
  workingDraftName.className = "workspace-history-name";
  workingDraftName.textContent = "Working Draft";
  const workingDraftMeta = document.createElement("span");
  workingDraftMeta.className = "workspace-history-meta";
  workingDraftMeta.textContent = "No local draft";
  const workingDraftDetails = document.createElement("span");
  workingDraftDetails.className = "workspace-history-detail";
  workingDraftDetails.hidden = true;
  workingDraftBody.append(workingDraftName, workingDraftMeta, workingDraftDetails);
  workingDraftButton.append(workingDraftMarker, workingDraftBody);
  workingDraftRow.append(workingDraftButton);
  historyList.append(workingDraftRow);
  const historyEmpty = document.createElement("p");
  historyEmpty.className = "workspace-history-empty";
  historyEmpty.textContent = "Committed Revisions will appear here after Commit.";
  historyEmpty.hidden = true;
  const historyStatus = document.createElement("div");
  historyStatus.className = "workspace-history-status";
  historyStatus.setAttribute("role", "status");
  historyStatus.setAttribute("aria-live", "polite");
  const historyStatusText = document.createElement("p");
  const historyRetry = document.createElement("button");
  historyRetry.type = "button";
  historyRetry.className = "workspace-secondary workspace-history-retry";
  historyRetry.textContent = "Retry";
  historyStatus.append(historyStatusText, historyRetry);
  historySection.append(historyTitle, historyList, historyEmpty, historyStatus);

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
  const contextExpiry = document.createElement("span");
  contextMeta.append(contextCode, contextRevision, contextExpiry);
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

  const conflictPanel = document.createElement("section");
  conflictPanel.className = "workspace-conflict-panel";
  conflictPanel.setAttribute("aria-labelledby", "workspace-conflict-title");
  conflictPanel.hidden = true;
  const conflictTitle = document.createElement("h2");
  conflictTitle.id = "workspace-conflict-title";
  conflictTitle.textContent = "This Handoff changed while you were editing.";
  const conflictSummary = document.createElement("div");
  conflictSummary.className = "workspace-conflict-summary";
  const conflictDraft = document.createElement("p");
  const conflictLatest = document.createElement("p");
  conflictSummary.append(conflictDraft, conflictLatest);
  const conflictActions = document.createElement("div");
  conflictActions.className = "workspace-conflict-actions";
  const useServerLatest = document.createElement("button");
  useServerLatest.type = "button";
  useServerLatest.className = "workspace-secondary workspace-conflict-choice";
  useServerLatest.dataset.conflictChoice = "use-server-latest";
  useServerLatest.textContent = "Use Server Latest";
  const keepWorkingDraft = document.createElement("button");
  keepWorkingDraft.type = "button";
  keepWorkingDraft.className = "workspace-commit-button workspace-conflict-choice";
  keepWorkingDraft.dataset.conflictChoice = "keep-working-draft";
  keepWorkingDraft.textContent = "Keep My Draft as New Latest";
  conflictActions.append(useServerLatest, keepWorkingDraft);
  const conflictMessage = document.createElement("p");
  conflictMessage.className = "workspace-conflict-message";
  conflictMessage.setAttribute("role", "status");
  conflictMessage.setAttribute("aria-live", "polite");
  conflictMessage.hidden = true;
  conflictPanel.append(conflictTitle, conflictSummary, conflictActions, conflictMessage);

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
  const editorFallback = document.createElement("article");
  editorFallback.className = "workspace-editor-fallback";
  editorFallback.hidden = true;
  const editorFallbackText = document.createElement("p");
  editorFallbackText.className = "workspace-editor-fallback-message";
  const editorFallbackContent = document.createElement("div");
  editorFallbackContent.className = "workspace-editor-fallback-content";
  editorFallback.append(editorFallbackText, editorFallbackContent);
  editorViewport.append(editorState, editorFallback, editorRoot);

  const historicalViewport = document.createElement("section");
  historicalViewport.className = "workspace-history-document";
  historicalViewport.setAttribute("aria-label", "Historical Revision");
  historicalViewport.hidden = true;
  const historicalHeader = document.createElement("header");
  historicalHeader.className = "workspace-history-document-header";
  const historicalTitle = document.createElement("h2");
  historicalTitle.className = "workspace-history-document-title";
  const historicalMeta = document.createElement("p");
  historicalMeta.className = "workspace-history-document-meta";
  const historicalReturn = document.createElement("button");
  historicalReturn.type = "button";
  historicalReturn.className = "workspace-secondary workspace-history-return";
  historicalReturn.textContent = "Return to Working Draft";
  historicalHeader.append(historicalTitle, historicalMeta, historicalReturn);
  const historicalState = document.createElement("div");
  historicalState.className = "workspace-history-document-state";
  historicalState.setAttribute("role", "status");
  historicalState.setAttribute("aria-live", "polite");
  const historicalStateText = document.createElement("p");
  const historicalRetry = document.createElement("button");
  historicalRetry.type = "button";
  historicalRetry.className = "workspace-secondary workspace-history-document-retry";
  historicalRetry.textContent = "Retry";
  historicalState.append(historicalStateText, historicalRetry);
  const historicalContent = document.createElement("article");
  historicalContent.className = "workspace-history-document-content";
  historicalViewport.append(historicalHeader, historicalState, historicalContent);

  documentPanel.append(
    contextBar,
    actionMessage,
    conflictPanel,
    editorViewport,
    historicalViewport,
  );
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
  let editorUnsupported: RichWorkingDraftBlocker | null = null;
  let historyState: RevisionHistoryViewState = { kind: "idle" };
  let historyForCommittedRevision: BrowserRevision | null = null;
  let documentSelection: DocumentSelection = { kind: "working-draft" };
  let historyRequestToken = 0;
  let revisionReadToken = 0;
  let conflictResolutionError: WorkspaceError | null = null;

  const effectiveMarkdown = (state: ReadyWorkspaceState): string =>
    state.workingDraft?.markdown ?? state.committed.markdown;

  const isHistoricalSelection = (): boolean => documentSelection.kind !== "working-draft";

  const invalidateHistoryRequests = (): void => {
    historyRequestToken += 1;
    revisionReadToken += 1;
  };

  const resetHistoryView = (): void => {
    invalidateHistoryRequests();
    historyForCommittedRevision = null;
    historyState = { kind: "idle" };
    documentSelection = { kind: "working-draft" };
  };

  function renderHistory(state: WorkspaceState): void {
    historyList.replaceChildren(workingDraftRow);
    if (state.kind !== "ready") {
      workingDraftRow.className = "workspace-history-row workspace-history-row-active";
      workingDraftButton.setAttribute("aria-current", "page");
      historyStatus.hidden = true;
      historyEmpty.hidden = true;
      return;
    }

    const workingDraftActive = documentSelection.kind === "working-draft";
    workingDraftRow.className = `workspace-history-row ${
      workingDraftActive ? "workspace-history-row-active" : ""
    }`;
    if (workingDraftActive) workingDraftButton.setAttribute("aria-current", "page");
    else workingDraftButton.removeAttribute("aria-current");

    if (historyState.kind === "ready") {
      historyEmpty.hidden = historyState.history.revisions.length > 0;
      for (const revision of historyState.history.revisions) {
        historyList.append(createRevisionHistoryRow(revision));
      }
      historyStatus.hidden = true;
      historyRetry.hidden = true;
      return;
    }

    historyEmpty.hidden = true;
    historyStatus.hidden = false;
    historyRetry.hidden = historyState.kind !== "error";
    historyStatusText.textContent =
      historyState.kind === "loading"
        ? "Loading Revision history…"
        : historyState.kind === "error"
          ? describeError(historyState.error)
          : "";
  }

  function createRevisionHistoryRow(
    revision: BrowserRevisionHistory["revisions"][number],
  ): HTMLLIElement {
    const row = document.createElement("li");
    const selectedRevision =
      documentSelection.kind === "historical" ||
      documentSelection.kind === "historical-loading" ||
      documentSelection.kind === "historical-error"
        ? documentSelection.kind === "historical"
          ? documentSelection.snapshot.revision
          : documentSelection.revision
        : null;
    const selected = selectedRevision === revision.revision;
    row.className = `workspace-history-row ${selected ? "workspace-history-row-active" : ""}`;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-history-button";
    button.setAttribute("aria-label", `Read Revision ${revision.revision}`);
    if (selected) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => void selectRevision(revision.revision));

    const marker = document.createElement("span");
    marker.className = "workspace-history-marker";
    const body = document.createElement("span");
    body.className = "workspace-history-body";
    const name = document.createElement("span");
    name.className = "workspace-history-name";
    name.textContent = `Revision ${revision.revision}`;
    const meta = document.createElement("span");
    meta.className = "workspace-history-meta";
    const origin = document.createElement("span");
    origin.textContent = formatRevisionOrigin(revision.origin);
    const separator = document.createTextNode(" · ");
    const time = document.createElement("time");
    time.dateTime = revision.createdAt;
    time.textContent = formatRevisionTimestamp(revision.createdAt);
    meta.append(origin, separator, time);
    body.append(name, meta);
    button.append(marker, body);
    row.append(button);
    return row;
  }

  function requestHistory(committed: BrowserRevision): void {
    const token = ++historyRequestToken;
    historyState = { kind: "loading" };
    documentSelection = { kind: "working-draft" };
    const state = controller.getState();
    if (state.kind === "ready") renderHistory(state);

    void controller
      .getRevisionHistory()
      .then((result) => {
        const current = controller.getState();
        if (
          destroyed ||
          token !== historyRequestToken ||
          current.kind !== "ready" ||
          current.committed !== committed
        ) {
          return;
        }
        historyState = result.ok
          ? { kind: "ready", history: result.value }
          : { kind: "error", error: result.error };
        renderHistory(current);
      })
      .catch(() => {
        const current = controller.getState();
        if (
          destroyed ||
          token !== historyRequestToken ||
          current.kind !== "ready" ||
          current.committed !== committed
        ) {
          return;
        }
        historyState = { kind: "error", error: { code: "NETWORK_ERROR" } };
        renderHistory(current);
      });
  }

  function ensureHistory(state: ReadyWorkspaceState): void {
    if (historyForCommittedRevision === state.committed) return;
    historyForCommittedRevision = state.committed;
    requestHistory(state.committed);
  }

  async function selectRevision(revision: number): Promise<void> {
    const state = controller.getState();
    if (state.kind !== "ready") return;
    const token = ++revisionReadToken;
    documentSelection = { kind: "historical-loading", revision };
    renderState(state);
    renderHistory(state);
    renderDocument(state);

    let result;
    try {
      result = await controller.readRevision(revision);
    } catch {
      result = { ok: false as const, error: { code: "NETWORK_ERROR" as const } };
    }

    const current = controller.getState();
    if (
      destroyed ||
      token !== revisionReadToken ||
      current.kind !== "ready" ||
      current.committed !== state.committed
    ) {
      return;
    }
    documentSelection = result.ok
      ? { kind: "historical", snapshot: result.value }
      : { kind: "historical-error", revision, error: result.error };
    renderState(current);
    renderHistory(current);
    renderDocument(current);
  }

  const renderEditorState = (): void => {
    if (editorUnsupported) {
      editorRoot.hidden = true;
      editorState.hidden = true;
      editorFallback.hidden = false;
      return;
    }

    editorFallback.hidden = true;
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

  const showUnsupportedMarkdown = (markdown: string, blocker: RichWorkingDraftBlocker): void => {
    editorUnsupported = blocker;
    editorFallbackText.textContent = describeRichWorkingDraftBlocker(blocker);
    editorFallbackContent.innerHTML = renderMarkdownToHtml(markdown);
    renderEditorState();
  };

  const clearUnsupportedMarkdown = (): void => {
    editorUnsupported = null;
    editorFallbackText.textContent = "";
    editorFallbackContent.replaceChildren();
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
    const markdown = effectiveMarkdown(state);
    const gate = checkRichWorkingDraftMarkdown(markdown);
    if (!gate.allowed) {
      showUnsupportedMarkdown(markdown, gate.blocker);
      return;
    }

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
      const currentMarkdown = effectiveMarkdown(current);
      const currentGate = checkRichWorkingDraftMarkdown(currentMarkdown);
      if (!currentGate.allowed) {
        editorMounting = false;
        showUnsupportedMarkdown(currentMarkdown, currentGate.blocker);
        return;
      }
      const mountedEditor = await mountWorkingDraftEditor({
        root: editorRoot,
        markdown: currentMarkdown,
        onHumanMarkdown: (value) => {
          const latest = controller.getState();
          if (latest.kind !== "ready" || latest.commitPending) return;
          const update = controller.updateMarkdown(value, "human");
          if (!update.ok && editor) {
            editor.replaceMarkdown({
              markdown: effectiveMarkdown(latest),
              history: "reset",
            });
          }
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
      contextExpiry.textContent = "";
      statusPill.textContent = isLoading ? "Loading" : "Open a Handoff";
      statusPill.className = "workspace-status-pill";
      workingDraftDetails.hidden = true;
      workingDraftDetails.textContent = "";
      commit.disabled = true;
      discardMenuItem.disabled = true;
      discardConfirmAction.disabled = true;
      actionMessage.hidden = true;
      conflictPanel.hidden = true;
      conflictResolutionError = null;
      renderEditorState();
      return;
    }

    contextCode.textContent = state.code;
    contextRevision.textContent = `Latest Revision ${state.committed.latestRevision}`;
    contextExpiry.textContent = `Expires ${formatExpiry(state.committed.expiresAt)}`;
    statusPill.textContent = topbarStatusText(state);
    statusPill.className = `workspace-status-pill ${
      state.workingDraft ? "workspace-status-pill-active" : ""
    }`;
    workingDraftMeta.textContent = draftStatusText(state);
    workingDraftDetails.hidden = state.workingDraft === null;
    workingDraftDetails.textContent = draftMetadataText(state);
    handoffCode.textContent = state.code;
    const historySelected = isHistoricalSelection();
    const conflict = state.actionError?.code === "REVISION_CONFLICT" ? state.actionError : null;
    const hasConflict = conflict !== null && state.workingDraft !== null;
    if (!hasConflict) conflictResolutionError = null;
    conflictPanel.hidden = !hasConflict;
    if (hasConflict && state.workingDraft) {
      conflictDraft.textContent = `Your Working Draft · Based on Revision ${state.workingDraft.baseRevision}`;
      conflictLatest.textContent = `Server Latest · Revision ${conflict.expectedRevision}`;
      conflictMessage.hidden = conflictResolutionError === null;
      conflictMessage.textContent = conflictResolutionError
        ? describeError(conflictResolutionError)
        : "";
    } else {
      conflictDraft.textContent = "";
      conflictLatest.textContent = "";
      conflictMessage.hidden = true;
      conflictMessage.textContent = "";
    }
    useServerLatest.disabled = !hasConflict || state.commitPending;
    keepWorkingDraft.disabled = !hasConflict || state.commitPending;
    commit.disabled =
      historySelected || hasConflict || state.workingDraft === null || state.commitPending;
    discardMenuItem.disabled =
      historySelected || hasConflict || state.workingDraft === null || state.commitPending;
    discardConfirmAction.disabled =
      historySelected || hasConflict || state.workingDraft === null || state.commitPending;
    const message = state.commitPending
      ? hasConflict
        ? "Resolving Revision conflict…"
        : "Committing Revision…"
      : state.actionError
        ? hasConflict
          ? ""
          : describeError(state.actionError)
        : "";
    actionMessage.hidden = message.length === 0;
    actionMessage.textContent = message;
  };

  function renderDocument(state: WorkspaceState): void {
    const selection = documentSelection;
    const historical = selection.kind !== "working-draft";
    editorViewport.hidden = historical;
    historicalViewport.hidden = !historical;
    if (!historical) {
      historicalState.hidden = true;
      historicalContent.replaceChildren();
      historicalTitle.textContent = "";
      historicalMeta.textContent = "";
      return;
    }

    historicalReturn.hidden = false;
    historicalTitle.textContent = `Revision ${
      selection.kind === "historical" ? selection.snapshot.revision : selection.revision
    }`;
    historicalState.hidden = selection.kind === "historical";
    historicalRetry.hidden = selection.kind !== "historical-error";

    if (selection.kind === "historical-loading") {
      historicalMeta.textContent = "";
      historicalStateText.textContent = "Loading Revision…";
      historicalContent.replaceChildren();
      return;
    }
    if (selection.kind === "historical-error") {
      historicalMeta.textContent = "";
      historicalStateText.textContent = describeError(selection.error);
      historicalContent.replaceChildren();
      return;
    }

    const origin = formatRevisionOrigin(selection.snapshot.origin);
    historicalMeta.replaceChildren(
      document.createTextNode(`${origin} · `),
      createRevisionTime(selection.snapshot.createdAt),
    );
    historicalContent.innerHTML = renderMarkdownToHtml(selection.snapshot.markdown);
  }

  const render = (state: WorkspaceState, reason: MarkdownChangeReason): void => {
    if (state.kind !== "ready") {
      resetHistoryView();
    } else {
      ensureHistory(state);
    }
    renderState(state);
    renderHistory(state);

    if (state.kind !== "ready") {
      clearUnsupportedMarkdown();
      destroyEditor();
      renderDocument(state);
      return;
    }

    const markdown = effectiveMarkdown(state);
    const gate = checkRichWorkingDraftMarkdown(markdown);
    if (!gate.allowed) {
      destroyEditor();
      showUnsupportedMarkdown(markdown, gate.blocker);
      return;
    }
    clearUnsupportedMarkdown();

    if (!editor && !editorMounting && !editorError) {
      void mountEditor();
    }
    if (!editor) {
      renderEditorState();
      renderDocument(state);
      return;
    }

    if (reason === "webmcp-replace") {
      editor.replaceMarkdown({ markdown, history: "record" });
    } else if (reason === "workspace-reset") {
      editor.replaceMarkdown({ markdown, history: "reset" });
    }
    editor.setReadOnly(state.commitPending);
    renderEditorState();
    renderDocument(state);
  };

  function showWorkingDraft(): void {
    const state = controller.getState();
    if (state.kind !== "ready") return;
    revisionReadToken += 1;
    documentSelection = { kind: "working-draft" };
    renderState(state);
    renderHistory(state);
    renderDocument(state);
  }

  function retryHistory(): void {
    const state = controller.getState();
    if (state.kind !== "ready") return;
    requestHistory(state.committed);
  }

  async function resolveConflict(choice: RevisionConflictChoice): Promise<void> {
    const state = controller.getState();
    if (state.kind !== "ready" || state.actionError?.code !== "REVISION_CONFLICT") return;
    conflictResolutionError = null;
    renderState(state);
    const result = await controller.resolveRevisionConflict(choice);
    if (!result.ok && result.error.code !== "REVISION_CONFLICT") {
      conflictResolutionError = result.error;
      const current = controller.getState();
      if (current.kind === "ready") renderState(current);
    }
  }

  keyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.submitSpaceKey(keyInput.value);
  });
  workingDraftButton.addEventListener("click", showWorkingDraft);
  historyRetry.addEventListener("click", retryHistory);
  useServerLatest.addEventListener("click", () => void resolveConflict("use-server-latest"));
  keepWorkingDraft.addEventListener("click", () => void resolveConflict("keep-working-draft"));
  historicalReturn.addEventListener("click", showWorkingDraft);
  historicalRetry.addEventListener("click", () => {
    if (
      documentSelection.kind === "historical-error" ||
      documentSelection.kind === "historical-loading"
    ) {
      void selectRevision(documentSelection.revision);
    }
  });
  changeKey.addEventListener("click", () => {
    controller.changeSpaceKey();
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
      invalidateHistoryRequests();
      document.removeEventListener("click", documentClickHandler);
      destroyEditor();
    },
  };
}

function draftStatusText(state: ReadyWorkspaceState): string {
  if (!state.workingDraft) return "No local draft";
  if (state.commitPending && state.actionError?.code === "REVISION_CONFLICT") {
    return "Conflict resolution pending";
  }
  if (state.commitPending) return "Commit pending";
  if (state.actionError?.code === "REVISION_CONFLICT") return "Conflict needs resolution";
  if (state.actionError) return "Recoverable error";
  return state.workingDraft.lastModifiedVia === "human" ? "Edited by you" : "Updated by WebMCP";
}

function topbarStatusText(state: ReadyWorkspaceState): string {
  if (state.commitPending && state.actionError?.code === "REVISION_CONFLICT") {
    return "Resolving Revision conflict…";
  }
  if (state.commitPending) return "Committing Revision…";
  if (state.actionError?.code === "REVISION_CONFLICT") return "Revision conflict";
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
    case "NO_REVISION_CONFLICT":
      return "There is no active Revision conflict to resolve.";
    case "RICH_DRAFT_UNSUPPORTED":
      return describeRichWorkingDraftBlocker(error.blocker);
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

function formatExpiry(expiresAt: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(expiresAt);
  return match ? `${match[1]} ${match[2]} UTC` : expiresAt;
}

function formatRevisionOrigin(origin: BrowserRevision["origin"]): string {
  switch (origin) {
    case "mcp":
      return "MCP";
    case "human":
      return "Human";
    case "webmcp":
      return "WebMCP";
  }
}

function formatRevisionTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return createdAt;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function createRevisionTime(createdAt: string): HTMLTimeElement {
  const time = document.createElement("time");
  time.dateTime = createdAt;
  time.textContent = formatRevisionTimestamp(createdAt);
  return time;
}

function draftMetadataText(state: ReadyWorkspaceState): string {
  const draft = state.workingDraft;
  if (!draft) return "";
  const contributors = draft.contributors
    .map((surface) => (surface === "human" ? "Human" : "WebMCP"))
    .join(" · ");
  return `Based on Revision ${draft.baseRevision} · Last modified: ${
    draft.lastModifiedVia === "human" ? "Human" : "WebMCP"
  } · Contributors: ${contributors || "None"}`;
}

function describeRichWorkingDraftBlocker(blocker: RichWorkingDraftBlocker): string {
  switch (blocker) {
    case "raw-html":
      return "This content contains raw HTML that is not accepted by the rich Working Draft editor. The Markdown is preserved in a sanitized read-only view.";
    case "image":
      return "This content contains an image. Images are not accepted by the rich Working Draft editor, so the Markdown is preserved in a sanitized read-only view.";
    case "table":
      return "This content contains a table. Tables are not accepted by the current rich Working Draft editor, so the Markdown is preserved in a sanitized read-only view.";
    case "unsafe-link":
      return "This content contains an unsafe link protocol and cannot enter the rich Working Draft editor.";
  }
}
