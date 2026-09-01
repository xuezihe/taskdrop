import { describe, expect, it } from "vitest";

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
});
