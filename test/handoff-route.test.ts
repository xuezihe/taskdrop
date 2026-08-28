import { describe, expect, it } from "vitest";

import { parseHandoffPath } from "../web/handoff-route.js";

describe("Handoff page route", () => {
  it("extracts a six-character Handoff Code from the top-level route", () => {
    expect(parseHandoffPath("/handoff/abc0oi")).toBe("abc0oi");
  });

  it("rejects paths that are not exactly /handoff/:code", () => {
    for (const path of ["/", "/handoff", "/handoff/", "/handoff/ABC001/extra", "/other/ABC001"]) {
      expect(parseHandoffPath(path)).toBeNull();
    }
  });

  it("rejects malformed Codes and encoded path separators", () => {
    expect(parseHandoffPath("/handoff/short")).toBeNull();
    expect(parseHandoffPath("/handoff/ABC00!")).toBeNull();
    expect(parseHandoffPath("/handoff/ABC%2F01")).toBeNull();
  });
});
