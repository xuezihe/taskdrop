import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { installBrowserGlobals } from "./jsdom-browser-globals.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Working Draft editor module", () => {
  let cleanup: () => void;
  let mountWorkingDraftEditor: typeof import("../../web/working-draft-editor.js").mountWorkingDraftEditor;

  beforeAll(async () => {
    cleanup = installBrowserGlobals();
    const module = await import("../../web/working-draft-editor.js");
    mountWorkingDraftEditor = module.mountWorkingDraftEditor;
  });

  afterAll(() => {
    cleanup();
  });

  it("mounts an editor and returns the expected surface", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    const onHumanMarkdown = vi.fn();
    const editor = await mountWorkingDraftEditor({
      root,
      markdown: "# Hello",
      onHumanMarkdown,
    });

    expect(editor.replaceMarkdown).toBeTypeOf("function");
    expect(editor.setReadOnly).toBeTypeOf("function");
    expect(editor.destroy).toBeTypeOf("function");

    await editor.destroy();
    root.remove();
  });

  it("does not fire the human callback for the initial value or for programmatic replacements", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const onHumanMarkdown = vi.fn();

    const editor = await mountWorkingDraftEditor({
      root,
      markdown: "# Initial",
      onHumanMarkdown,
    });

    await wait(300);
    expect(onHumanMarkdown).not.toHaveBeenCalled();

    editor.replaceMarkdown({ markdown: "# Replaced", history: "record" });
    await wait(300);
    expect(onHumanMarkdown).not.toHaveBeenCalled();

    editor.replaceMarkdown({ markdown: "# Reset", history: "reset" });
    await wait(300);
    expect(onHumanMarkdown).not.toHaveBeenCalled();

    await editor.destroy();
    root.remove();
  });

  it("toggles read-only mode without throwing", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    const editor = await mountWorkingDraftEditor({
      root,
      markdown: "# Hello",
      onHumanMarkdown: vi.fn(),
    });

    editor.setReadOnly(true);
    editor.setReadOnly(false);

    await editor.destroy();
    root.remove();
  });

  it("becomes a no-op after destroy", async () => {
    const root = document.createElement("div");
    document.body.append(root);

    const editor = await mountWorkingDraftEditor({
      root,
      markdown: "# Hello",
      onHumanMarkdown: vi.fn(),
    });

    await editor.destroy();

    expect(() => editor.replaceMarkdown({ markdown: "# After", history: "record" })).not.toThrow();
    expect(() => editor.setReadOnly(true)).not.toThrow();
    await expect(editor.destroy()).resolves.toBeUndefined();

    root.remove();
  });
});
