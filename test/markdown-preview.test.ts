import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { renderMarkdownToHtml } from "../web/markdown-preview.js";

function render(markdown: string): string {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
  return renderMarkdownToHtml(markdown, dom.window as unknown as Window & typeof globalThis);
}

describe("Markdown preview rendering", () => {
  it("renders basic Markdown elements to HTML", () => {
    const html = render("# Heading\n\n**bold** and *italic*\n\n- item\n\n```js\ncode\n```");
    expect(html).toContain("<h1");
    expect(html).toContain("Heading");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<li>");
    expect(html).toContain("<code");
  });

  it("strips script tags from Markdown input", () => {
    const html = render('safe text\n\n<script>alert("xss")</script>\n\nmore text');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert");
    expect(html).toContain("safe text");
    expect(html).toContain("more text");
  });

  it("strips inline event handlers from HTML elements", () => {
    const html = render('<img src="x" onerror="alert(1)">\n\n<div onclick="steal()">click</div>');
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert");
    expect(html).not.toContain("steal");
  });

  it("strips javascript: URLs from links", () => {
    const html = render('[click me](javascript:alert(1))\n\n<a href="javascript:void(0)">link</a>');
    expect(html).not.toContain("javascript:");
  });

  it("strips iframe, object, and embed tags", () => {
    const html = render(
      '<iframe src="https://evil.com"></iframe>\n\n<object data="x"></object>\n\n<embed src="y">',
    );
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<object");
    expect(html).not.toContain("<embed");
  });

  it("does not create external-resource elements in read-only rendering", () => {
    const html = render(
      '![remote](https://evil.example/image.png "title")\n\n<div style="background: url(https://evil.example/track)">text</div>',
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("style=");
  });

  it("does not preserve external SVG resources in read-only rendering", () => {
    const html = render('<svg><image href="https://evil.example/track" /></svg>');
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("evil.example");
  });

  it("preserves safe inline HTML when present in Markdown", () => {
    const html = render("This has <em>emphasis</em> and <strong>bold</strong> inline.");
    expect(html).toContain("<em>emphasis</em>");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("returns empty string for empty input", () => {
    expect(render("")).toBe("");
  });
});
