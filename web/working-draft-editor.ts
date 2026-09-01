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
  const [{ Crepe }, { replaceAll }] = await Promise.all([
    import("@milkdown/crepe"),
    import("@milkdown/kit/utils"),
  ]);

  let destroyed = false;
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

  await crepe.create();

  lastKnownMarkdown = crepe.getMarkdown();

  crepe.on((listener) => {
    listener.markdownUpdated((ctx, nextMarkdown) => {
      if (destroyed) return;
      if (nextMarkdown === lastKnownMarkdown) return;
      lastKnownMarkdown = nextMarkdown;
      input.onHumanMarkdown(nextMarkdown);
    });
  });

  return {
    replaceMarkdown(replacement): void {
      if (destroyed) return;
      crepe.editor.action(replaceAll(replacement.markdown, replacement.history === "reset"));
      lastKnownMarkdown = crepe.getMarkdown();
    },

    setReadOnly(readOnly): void {
      if (destroyed) return;
      crepe.setReadonly(readOnly);
    },

    async destroy(): Promise<void> {
      if (destroyed) return;
      destroyed = true;
      await crepe.destroy();
    },
  };
}
