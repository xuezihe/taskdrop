import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  LARGE_RICH_MARKDOWN_END_SENTINEL,
  LARGE_RICH_MARKDOWN_MAX_BYTES,
  LARGE_RICH_MARKDOWN_MIN_BYTES,
  LARGE_RICH_MARKDOWN_START_SENTINEL,
  largeRichMarkdown,
} from "../fixtures/large-rich-markdown.js";
import {
  checkRichWorkingDraftMarkdown,
  type RichWorkingDraftBlocker,
} from "../../web/rich-working-draft-gate.js";

const knownBlockers: readonly {
  name: string;
  markdown: string;
  blocker: RichWorkingDraftBlocker;
}[] = [
  {
    name: "raw HTML",
    markdown: '<script>alert("xss")</script>',
    blocker: "raw-html",
  },
  {
    name: "Markdown image",
    markdown: "![remote image](https://example.com/image.png)",
    blocker: "image",
  },
  {
    name: "GFM table",
    markdown: "| Name | Value |\n| --- | --- |\n| one | two |",
    blocker: "table",
  },
  {
    name: "unsafe link protocol",
    markdown: "[run](javascript:alert(1))",
    blocker: "unsafe-link",
  },
];

describe("rich Working Draft Markdown gate", () => {
  it.each(knownBlockers)("rejects known $name", ({ markdown, blocker }) => {
    expect(checkRichWorkingDraftMarkdown(markdown)).toEqual({
      allowed: false,
      blocker,
    });
  });

  it("allows the supported semantic editing profile", () => {
    expect(
      checkRichWorkingDraftMarkdown(
        [
          "# Heading",
          "",
          "- [ ] nested task",
          "  - child",
          "",
          "> quoted",
          "",
          "[safe link](https://example.com)",
          "",
          "<https://example.com>",
          "",
          "```html",
          "<script>this is code, not executable Markdown</script>",
          "```",
        ].join("\n"),
      ),
    ).toEqual({ allowed: true });
  });

  it("does not classify inline code as a raw HTML or unsafe URL construct", () => {
    expect(
      checkRichWorkingDraftMarkdown(
        "Use `<script>` or `[run](javascript:alert(1))` as literal examples.",
      ),
    ).toEqual({ allowed: true });
  });

  it("does not classify a horizontal rule as a table", () => {
    expect(checkRichWorkingDraftMarkdown("---")).toEqual({ allowed: true });
  });

  it("accepts the representative large rich Markdown fixture inside the 64–128 KiB band", () => {
    const bytes = Buffer.byteLength(largeRichMarkdown, "utf8");
    expect(bytes).toBeGreaterThanOrEqual(LARGE_RICH_MARKDOWN_MIN_BYTES);
    expect(bytes).toBeLessThanOrEqual(LARGE_RICH_MARKDOWN_MAX_BYTES);
    expect(checkRichWorkingDraftMarkdown(largeRichMarkdown)).toEqual({ allowed: true });
  });

  it("contains the expected representative Markdown structures", () => {
    expect(largeRichMarkdown).toContain(`# ${LARGE_RICH_MARKDOWN_START_SENTINEL}`);
    expect(largeRichMarkdown).toContain(`## ${LARGE_RICH_MARKDOWN_END_SENTINEL}`);
    expect(largeRichMarkdown).toContain("## Section 1 overview");
    expect(largeRichMarkdown).toContain("## Section 136 overview");
    expect(largeRichMarkdown).toContain(
      "Section 1 carries representative prose for the large Working Draft",
    );
    expect(largeRichMarkdown).toContain("- Root item 1 with plain content");
    expect(largeRichMarkdown).toContain("  - Nested item 1a under the root");
    expect(largeRichMarkdown).toContain("- [ ] Open task 1 for the next Agent pass");
    expect(largeRichMarkdown).toContain("[TaskDrop documentation](https://example.com/taskdrop-1)");
    expect(largeRichMarkdown).toContain("> Quoted context 1:");
    expect(largeRichMarkdown).toContain("```ts");
  });
});
