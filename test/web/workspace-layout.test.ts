import { readFileSync } from "node:fs";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { installBrowserGlobals } from "./jsdom-browser-globals.js";

const landingStyles = readFileSync(new URL("../../web/styles.css", import.meta.url), "utf8");
const workspaceStyles = readFileSync(new URL("../../web/workspace.css", import.meta.url), "utf8");

function installStyles(...sources: string[]): void {
  for (const source of sources) {
    const style = document.createElement("style");
    style.textContent = source;
    document.head.append(style);
  }
}

describe("Handoff Workspace layout", () => {
  const cleanup = installBrowserGlobals();

  afterEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it("uses the viewport as the workspace frame without an outer card", () => {
    installStyles(landingStyles, workspaceStyles);

    const shell = document.createElement("main");
    shell.className = "workspace-shell";
    const layout = document.createElement("div");
    layout.className = "workspace-layout";
    shell.append(layout);
    document.body.append(shell);

    const shellStyle = getComputedStyle(shell);
    const layoutStyle = getComputedStyle(layout);

    expect(shellStyle.padding).toBe("0px");
    expect(layoutStyle.borderWidth).toBe("0px");
    expect(Number.parseFloat(layoutStyle.borderRadius)).toBe(0);
    expect(layoutStyle.maxWidth).not.toBe("1280px");
  });

  it("keeps Workspace rules in the Workspace stylesheet", () => {
    expect(landingStyles).not.toMatch(/\.workspace-/);
  });

  it("sizes the editor from its container and caps the reading width", () => {
    installStyles(workspaceStyles);

    const root = document.createElement("div");
    root.className = "workspace-editor-root";
    const milkdown = document.createElement("div");
    milkdown.className = "milkdown";
    const editor = document.createElement("div");
    editor.className = "editor";
    milkdown.append(editor);
    root.append(milkdown);
    document.body.append(root);

    expect(getComputedStyle(editor).minHeight).not.toContain("dvh");
    expect(getComputedStyle(milkdown).maxWidth).toBe("960px");
  });

  it("keeps the editor below the optional conflict panel", () => {
    installStyles(workspaceStyles);

    const viewport = document.createElement("div");
    viewport.className = "workspace-editor-viewport";
    document.body.append(viewport);

    expect(getComputedStyle(viewport).gridRow).toBe("4");
  });

  afterAll(() => {
    cleanup();
  });
});
