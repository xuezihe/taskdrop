import DOMPurify from "dompurify";
import { Marked } from "marked";

const markedInstance = new Marked({
  async: false,
  breaks: false,
  gfm: true,
});

const READ_ONLY_SANITIZE_CONFIG = {
  FORBID_ATTR: ["style", "srcset"],
  FORBID_TAGS: [
    "audio",
    "base",
    "embed",
    "form",
    "iframe",
    "img",
    "input",
    "link",
    "meta",
    "object",
    "script",
    "source",
    "style",
    "track",
    "video",
  ],
  USE_PROFILES: { html: true },
};

export function renderMarkdownToHtml(
  markdown: string,
  windowContext: Window & typeof globalThis = window,
): string {
  if (markdown === "") return "";
  const rawHtml = markedInstance.parse(markdown) as string;
  const purify = DOMPurify(windowContext);
  return purify.sanitize(rawHtml, READ_ONLY_SANITIZE_CONFIG);
}
