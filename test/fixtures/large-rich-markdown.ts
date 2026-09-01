/**
 * One deterministic representative large Markdown document for Issue 08 Gate B.
 *
 * The fixture targets roughly 96 KiB (64–128 KiB band) and exercises every
 * construct in the supported rich-editing profile: headings, paragraphs,
 * nested lists, task lists, safe links, blockquotes, and fenced code blocks.
 * It deliberately contains no Space Key pattern and no syntax that the Step 6
 * rich-editor gate rejects.
 */

const TARGET_BYTES = 96 * 1024;
const SECTION_COUNT = 136;

const FIXTURE_START = "Large Rich Markdown Fixture Start";
const FIXTURE_END = "Large Rich Markdown Fixture End";

function section(index: number): string {
  return [
    `## Section ${index} overview`,
    "",
    `Section ${index} carries representative prose for the large Working Draft`,
    `capacity exercise. The paragraph keeps enough words to resemble a real`,
    `Handoff document rather than a synthetic block of filler characters.`,
    "",
    `- Root item ${index} with plain content`,
    `  - Nested item ${index}a under the root`,
    `    - Deeply nested item ${index}b`,
    "",
    `- [ ] Open task ${index} for the next Agent pass`,
    `- [x] Completed task ${index} verified by the Human`,
    "",
    `Reference link ${index}: [TaskDrop documentation](https://example.com/taskdrop-${index})`,
    "",
    `> Quoted context ${index}: decisions in this section must survive the`,
    `> parse, edit, and serialization round trip unchanged.`,
    "",
    "```ts",
    `export function section${index}(input: string): string {`,
    `  return \`\${input} section ${index}\`;`,
    `}`,
    "```",
    "",
  ].join("\n");
}

function buildLargeRichMarkdown(): string {
  const sections: string[] = [];
  for (let index = 1; index <= SECTION_COUNT; index += 1) {
    sections.push(section(index));
  }
  return [
    `# ${FIXTURE_START}`,
    "",
    "This document exercises the representative large Working Draft path.",
    "",
    ...sections,
    `## ${FIXTURE_END}`,
    "",
    "The fixture ends after the final representative section.",
    "",
  ].join("\n");
}

export const largeRichMarkdown: string = buildLargeRichMarkdown();

export const LARGE_RICH_MARKDOWN_START_SENTINEL = FIXTURE_START;
export const LARGE_RICH_MARKDOWN_END_SENTINEL = FIXTURE_END;
export const LARGE_RICH_MARKDOWN_MIN_BYTES = 64 * 1024;
export const LARGE_RICH_MARKDOWN_MAX_BYTES = 128 * 1024;
