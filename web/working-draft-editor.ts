import "@milkdown/crepe/theme/common/prosemirror.css";
import "@milkdown/crepe/theme/common/reset.css";
import "@milkdown/crepe/theme/common/block-edit.css";
import "@milkdown/crepe/theme/common/code-mirror.css";
import "@milkdown/crepe/theme/common/cursor.css";
import "@milkdown/crepe/theme/common/link-tooltip.css";
import "@milkdown/crepe/theme/common/list-item.css";
import "@milkdown/crepe/theme/common/placeholder.css";
import "@milkdown/crepe/theme/common/toolbar.css";
import "@milkdown/crepe/theme/common/top-bar.css";
import "@milkdown/crepe/theme/classic.css";

import { editorViewOptionsCtx } from "@milkdown/kit/core";
import { uploadConfig } from "@milkdown/kit/plugin/upload";

import { checkRichWorkingDraftMarkdown } from "./rich-working-draft-gate.js";

export type WorkingDraftEditorReplacement = {
  markdown: string;
  history: "reset" | "record";
};

export type WorkingDraftEditor = {
  replaceMarkdown(input: WorkingDraftEditorReplacement): void;
  setReadOnly(readOnly: boolean): void;
  destroy(): Promise<void>;
};

export async function mountWorkingDraftEditor(input: {
  root: HTMLElement;
  markdown: string;
  onHumanMarkdown(markdown: string): void;
}): Promise<WorkingDraftEditor> {
  const initialGate = checkRichWorkingDraftMarkdown(input.markdown);
  if (!initialGate.allowed) {
    throw new Error(
      `Markdown is not accepted by the rich Working Draft path: ${initialGate.blocker}`,
    );
  }

  const [{ Crepe }, { replaceAll }] = await Promise.all([
    import("@milkdown/crepe"),
    import("@milkdown/kit/utils"),
  ]);

  let destroyed = false;
  let replacing = false;
  let lastKnownMarkdown = input.markdown;

  const crepe = new Crepe({
    root: input.root,
    defaultValue: input.markdown,
    features: {
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.Table]: false,
      [Crepe.Feature.TopBar]: true,
      [Crepe.Feature.AI]: false,
    },
  });

  const blockUnsafePaste = (event: ClipboardEvent): void => {
    if (!hasUnsafeClipboardPayload(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const blockFileDrop = (event: DragEvent): void => {
    if (!hasDroppedFiles(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  input.root.addEventListener("paste", blockUnsafePaste, true);
  input.root.addEventListener("drop", blockFileDrop, true);
  const removeSafetyListeners = (): void => {
    input.root.removeEventListener("paste", blockUnsafePaste, true);
    input.root.removeEventListener("drop", blockFileDrop, true);
  };

  crepe.editor.config((ctx) => {
    ctx.update(uploadConfig.key, (value) => ({
      ...value,
      uploader: async () => [],
      enableHtmlFileUploader: false,
    }));
    ctx.update(editorViewOptionsCtx, (value) => ({
      ...value,
      handlePaste: (_view, event) => {
        if (!hasUnsafeClipboardPayload(event)) return false;
        event.preventDefault();
        return true;
      },
      handleDrop: (_view, event) => {
        if (!hasDroppedFiles(event)) return false;
        event.preventDefault();
        return true;
      },
    }));
  });

  try {
    await crepe.create();
  } catch (error) {
    removeSafetyListeners();
    throw error;
  }

  lastKnownMarkdown = crepe.getMarkdown();

  const replaceEditorMarkdown = (markdown: string, clearHistory: boolean): void => {
    replacing = true;
    try {
      crepe.editor.action(replaceAll(markdown, clearHistory));
      lastKnownMarkdown = crepe.getMarkdown();
    } finally {
      replacing = false;
    }
  };

  crepe.on((listener) => {
    listener.markdownUpdated((ctx, nextMarkdown) => {
      if (destroyed || replacing) return;
      if (nextMarkdown === lastKnownMarkdown) return;
      const gate = checkRichWorkingDraftMarkdown(nextMarkdown);
      if (!gate.allowed) {
        replaceEditorMarkdown(lastKnownMarkdown, true);
        return;
      }
      lastKnownMarkdown = nextMarkdown;
      input.onHumanMarkdown(nextMarkdown);
    });
  });

  return {
    replaceMarkdown(replacement): void {
      if (destroyed) return;
      if (!checkRichWorkingDraftMarkdown(replacement.markdown).allowed) return;
      replaceEditorMarkdown(replacement.markdown, replacement.history === "reset");
    },

    setReadOnly(readOnly): void {
      if (destroyed) return;
      crepe.setReadonly(readOnly);
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      removeSafetyListeners();
      await crepe.destroy();
    },
  };
}

function hasUnsafeClipboardPayload(event: ClipboardEvent): boolean {
  const data = event.clipboardData;
  if (!data) return false;
  if (data.files.length > 0) return true;

  const html = data.getData("text/html");
  if (html && !checkRichWorkingDraftMarkdown(html).allowed) return true;

  const text = data.getData("text/plain");
  return text.length > 0 && !checkRichWorkingDraftMarkdown(text).allowed;
}

function hasDroppedFiles(event: DragEvent): boolean {
  return Boolean(event.dataTransfer?.files.length);
}
