import DOMPurify from "dompurify";
import { Marked } from "marked";

const markedInstance = new Marked({
  async: false,
  breaks: false,
  gfm: true,
});

export function renderMarkdownToHtml(
  markdown: string,
  windowContext: Window & typeof globalThis = window,
): string {
  if (markdown === "") return "";
  const rawHtml = markedInstance.parse(markdown) as string;
  const purify = DOMPurify(windowContext);
  return purify.sanitize(rawHtml);
}
