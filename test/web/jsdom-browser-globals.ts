import { JSDOM } from "jsdom";

type PropertyRestore =
  | { kind: "value"; key: string; value: unknown }
  | { kind: "descriptor"; key: string; descriptor: PropertyDescriptor | undefined };

export function installBrowserGlobals(): () => void {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "http://localhost",
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  const restores: PropertyRestore[] = [];

  const override = (key: string, value: unknown): void => {
    const descriptor = Object.getOwnPropertyDescriptor(global, key);
    if (descriptor && !descriptor.writable && !descriptor.configurable) return;
    if (descriptor && !descriptor.writable && descriptor.configurable) {
      restores.push({ kind: "descriptor", key, descriptor });
      Object.defineProperty(global, key, { value, configurable: true });
    } else {
      restores.push({
        kind: "value",
        key,
        value: key in global ? (global as unknown as Record<string, unknown>)[key] : undefined,
      });
      (global as unknown as Record<string, unknown>)[key] = value;
    }
  };

  const navigator = {
    ...(win.navigator as unknown as object),
    clipboard: { writeText: async () => undefined },
  };

  const overrides: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    addEventListener: win.addEventListener.bind(win),
    removeEventListener: win.removeEventListener.bind(win),
    dispatchEvent: win.dispatchEvent.bind(win),
    MutationObserver: win.MutationObserver,
    ResizeObserver:
      "ResizeObserver" in win
        ? win.ResizeObserver
        : class {
            observe() {}
            unobserve() {}
            disconnect() {}
          },
    IntersectionObserver:
      "IntersectionObserver" in win
        ? win.IntersectionObserver
        : class {
            observe() {}
            unobserve() {}
            disconnect() {}
            takeRecords(): IntersectionObserverEntry[] {
              return [];
            }
          },
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    getComputedStyle: win.getComputedStyle.bind(win),
    URL: win.URL,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    Node: win.Node,
    Document: win.Document,
    Range: win.Range,
    Selection: win.Selection,
    DOMRect: win.DOMRect,
    DOMParser: win.DOMParser,
    XMLSerializer: win.XMLSerializer,
    SVGSVGElement: win.SVGSVGElement,
    SVGElement: win.SVGElement,
    SVGGraphicsElement: win.SVGGraphicsElement,
    Text: win.Text,
    Comment: win.Comment,
    DocumentFragment: win.DocumentFragment,
    HTMLDivElement: win.HTMLDivElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLAnchorElement: win.HTMLAnchorElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLFormElement: win.HTMLFormElement,
    HTMLUListElement: win.HTMLUListElement,
    HTMLOListElement: win.HTMLOListElement,
    HTMLLIElement: win.HTMLLIElement,
    KeyboardEvent: win.KeyboardEvent,
    MouseEvent: win.MouseEvent,
    FocusEvent: win.FocusEvent,
    InputEvent: win.InputEvent,
    ClipboardEvent: win.ClipboardEvent,
    DragEvent: win.DragEvent,
    UIEvent: win.UIEvent,
  };

  for (const [key, value] of Object.entries(overrides)) {
    override(key, value);
  }

  return () => {
    for (const restore of restores) {
      if (restore.kind === "descriptor") {
        if (restore.descriptor) {
          Object.defineProperty(global, restore.key, restore.descriptor);
        } else {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete (global as unknown as Record<string, unknown>)[restore.key];
        }
      } else {
        if (restore.value === undefined) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
          delete (global as unknown as Record<string, unknown>)[restore.key];
        } else {
          (global as unknown as Record<string, unknown>)[restore.key] = restore.value;
        }
      }
    }
  };
}
