/**
 * The rich Working Draft path has a deliberately small admission policy.
 *
 * This is not a Markdown parser. It only recognizes constructs that the
 * current editor configuration is known not to handle safely or faithfully.
 * New rules require a reproducing fixture before they are added here.
 */

export type RichWorkingDraftBlocker = "raw-html" | "image" | "table" | "unsafe-link";

export type RichWorkingDraftGateResult =
  | { allowed: true }
  | { allowed: false; blocker: RichWorkingDraftBlocker };

const FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})/;
const RAW_HTML_PATTERN = /<!--[\s\S]*?-->|<![A-Za-z]|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[\s\S]*?|\/?>)/;
const IMAGE_PATTERN = /!\[[^\]]*\]\s*(?:\([^\n)]*\)|\[[^\n\]]*\])/;
const UNSAFE_LINK_PATTERN =
  /(?:javascript|vbscript)\s*:|data\s*:\s*(?:text\/html|application\/xhtml\+xml)/i;

/**
 * Decide whether Markdown may enter the current rich Working Draft path.
 *
 * Code spans and fenced code are masked before the bounded checks so examples
 * in a document do not become false positives. Everything else is intentionally
 * left to the selected Markdown editor and its own runtime safety controls.
 */
export function checkRichWorkingDraftMarkdown(markdown: string): RichWorkingDraftGateResult {
  const masked = maskCode(markdown);

  if (RAW_HTML_PATTERN.test(masked)) return { allowed: false, blocker: "raw-html" };
  if (IMAGE_PATTERN.test(masked)) return { allowed: false, blocker: "image" };
  if (UNSAFE_LINK_PATTERN.test(masked)) {
    return { allowed: false, blocker: "unsafe-link" };
  }

  for (const line of masked.split("\n")) {
    if (isTableDelimiter(line)) return { allowed: false, blocker: "table" };
  }

  return { allowed: true };
}

function maskCode(markdown: string): string {
  const lines = markdown.split("\n");
  const maskedLines: string[] = [];
  let fence: { character: "`" | "~"; length: number } | null = null;

  for (const line of lines) {
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fence) {
      maskedLines.push(" ".repeat(line.length));
      if (
        fenceMatch &&
        fenceMatch[2]?.[0] === fence.character &&
        fenceMatch[2].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }

    if (fenceMatch) {
      const marker = fenceMatch[2];
      const character = marker?.[0];
      if (marker && (character === "`" || character === "~")) {
        fence = { character, length: marker.length };
      }
      maskedLines.push(" ".repeat(line.length));
      continue;
    }

    maskedLines.push(maskInlineCode(line));
  }

  return maskedLines.join("\n");
}

function maskInlineCode(line: string): string {
  const characters = [...line];
  let index = 0;

  while (index < characters.length) {
    if (characters[index] !== "`") {
      index += 1;
      continue;
    }

    const start = index;
    while (index < characters.length && characters[index] === "`") index += 1;
    const delimiterLength = index - start;
    const closing = characters.join("").indexOf("`".repeat(delimiterLength), index);
    const end = closing === -1 ? characters.length : closing + delimiterLength;
    for (let cursor = start; cursor < end; cursor += 1) characters[cursor] = " ";
    index = end;
  }

  return characters.join("");
}

function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;

  const withoutOuterPipes = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = withoutOuterPipes.split("|").map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}
