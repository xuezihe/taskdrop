import { createBrowserApiClient } from "./browser-api-client.js";
import {
  createHandoffWorkspaceController,
  type HandoffWorkspaceController,
  type WorkspaceError,
  type WorkspaceState,
} from "./handoff-workspace-controller.js";
import { createSessionWorkingDraftStorage } from "./handoff-session-storage.js";
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
  view.render(controller.getState());
  await controller.open();
}

function createView(
  root: HTMLElement,
  controller: HandoffWorkspaceController,
  routeCode: string,
): { render(state: WorkspaceState): void } {
  const shell = document.createElement("main");
  shell.className = "workspace-shell";

  const header = document.createElement("header");
  header.className = "workspace-header";
  const title = document.createElement("p");
  title.className = "workspace-kicker";
  title.textContent = "TASKDROP HANDOFF";
  const heading = document.createElement("h1");
  heading.textContent = "Handoff ";
  const codeLabel = document.createElement("code");
  codeLabel.textContent = routeCode;
  heading.append(codeLabel);
  header.append(title, heading);

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

  const keyChange = document.createElement("button");
  keyChange.type = "button";
  keyChange.className = "workspace-secondary workspace-change-key";
  keyChange.textContent = "Change Space Key";

  const workspace = document.createElement("section");
  workspace.className = "workspace-editor-section";
  workspace.setAttribute("aria-labelledby", "workspace-editor-title");
  const editorTitle = document.createElement("h2");
  editorTitle.id = "workspace-editor-title";
  editorTitle.textContent = "Markdown Workspace";
  const committedMeta = document.createElement("p");
  committedMeta.className = "workspace-meta";
  const textarea = document.createElement("textarea");
  textarea.className = "workspace-textarea";
  textarea.setAttribute("aria-label", "Handoff Markdown");
  textarea.spellcheck = false;
  const draftMeta = document.createElement("p");
  draftMeta.className = "workspace-draft-meta";
  const actions = document.createElement("div");
  actions.className = "workspace-actions";
  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "workspace-secondary";
  discard.textContent = "Discard";
  const commit = document.createElement("button");
  commit.type = "button";
  commit.className = "workspace-primary";
  commit.textContent = "Commit Revision";
  actions.append(discard, commit);
  const actionMessage = document.createElement("p");
  actionMessage.className = "workspace-message";
  actionMessage.setAttribute("aria-live", "polite");
  workspace.append(editorTitle, committedMeta, textarea, draftMeta, actions, actionMessage);

  const loadMessage = document.createElement("p");
  loadMessage.className = "workspace-load-message";
  loadMessage.setAttribute("aria-live", "polite");

  keyForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void controller.submitSpaceKey(keyInput.value);
  });
  keyChange.addEventListener("click", () => {
    keyForm.hidden = false;
    keyInput.value = "";
    keyInput.focus();
  });
  textarea.addEventListener("input", () => controller.updateMarkdown(textarea.value));
  discard.addEventListener("click", () => controller.discard());
  commit.addEventListener("click", () => void controller.commit());

  root.replaceChildren(shell);
  shell.append(header, keyChange, keyForm, loadMessage, workspace);
  document.title = `TaskDrop — Handoff ${routeCode}`;

  return {
    render(state): void {
      const isReady = state.kind === "ready";
      const isLoading = state.kind === "loading";
      const isNeedsKey = state.kind === "needs-space-key";

      keyForm.hidden = !isNeedsKey && state.kind !== "load-error";
      keyChange.hidden = !isReady;
      workspace.hidden = !isReady;
      loadMessage.textContent = isLoading
        ? "Loading the committed Revision…"
        : state.kind === "load-error"
          ? describeError(state.error)
          : "";

      if (isNeedsKey) {
        keyMessage.textContent = state.inputError ? describeError(state.inputError) : "";
      } else {
        keyMessage.textContent = "";
      }

      if (!isReady) return;

      const markdown = state.workingDraft?.markdown ?? state.committed.markdown;
      if (textarea.value !== markdown) textarea.value = markdown;
      textarea.disabled = state.commitPending;
      committedMeta.textContent = `Latest committed Revision: r${state.committed.revision} · Expires ${formatExpiry(state.committed.expiresAt)}`;
      draftMeta.textContent = state.workingDraft
        ? `Working Draft · based on r${state.workingDraft.baseRevision} · last modified via ${state.workingDraft.lastModifiedVia} · contributors: ${state.workingDraft.contributors.join(" · ")}`
        : "No local Working Draft · edit the Markdown to begin";
      discard.disabled = state.workingDraft === null || state.commitPending;
      commit.disabled = state.workingDraft === null || state.commitPending;
      actionMessage.textContent = state.commitPending
        ? "Committing Revision…"
        : state.actionError
          ? describeError(state.actionError)
          : "";
    },
  };
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
