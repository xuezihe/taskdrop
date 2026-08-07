import { describe, expect, it } from "vitest";

import { redactSpaceKeys, REDACTED_SPACE_KEY_PLACEHOLDER } from "../src/production/redaction.js";
import { formatSpaceKey } from "../src/production/space-identity.js";

function makeKey(seed: number): string {
  const entropy = new Uint8Array(32);
  for (let i = 0; i < 32; i++) entropy[i] = (seed + i) & 0xff;
  return formatSpaceKey(entropy);
}

describe("redaction contract", () => {
  it("redacts every canonical Space Key in a mixed payload and leaves other content untouched", () => {
    const keyA = makeKey(1);
    const keyB = makeKey(100);
    // Non-canonical lookalike: 43 base64url chars where the final char has
    // non-zero low 2 bits, so decode drops them and the encode round-trip
    // fails isCanonicalSpaceKey. "A"=0 ... "B"=1 (low 2 bits set).
    const lookalike = `tdp_${"A".repeat(42)}B`;

    const input = [
      "## Handoff notes",
      `Bearer ${keyA}`,
      `Same key again: ${keyA}`,
      `Different key: ${keyB}`,
      "The Space Key is configured via TASKDROP_SPACE_KEY and is redacted.",
      `Lookalike: ${lookalike}`,
    ].join("\n");

    const result = redactSpaceKeys(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.redactionCount).toBe(3); // keyA, keyA, keyB
    expect(result.markdown).toContain(`Bearer ${REDACTED_SPACE_KEY_PLACEHOLDER}`);
    expect(result.markdown).toContain(`Same key again: ${REDACTED_SPACE_KEY_PLACEHOLDER}`);
    expect(result.markdown).toContain(`Different key: ${REDACTED_SPACE_KEY_PLACEHOLDER}`);
    // Prose preserved verbatim, including the bare concept name.
    expect(result.markdown).toContain(
      "The Space Key is configured via TASKDROP_SPACE_KEY and is redacted.",
    );
    // Non-canonical lookalike left in place and not counted.
    expect(result.markdown).toContain(`Lookalike: ${lookalike}`);
    // Raw canonical keys never appear in the output.
    expect(result.markdown).not.toContain(keyA);
    expect(result.markdown).not.toContain(keyB);
  });

  it("returns the input unchanged with count 0 when no Space Key is present", () => {
    const input = [
      "# Project plan",
      "",
      "No credentials here. Just ordinary Markdown.",
      "A long line of prose that mentions tdp_ only as a concept, not a key.",
      "",
      "Empty payload below:",
    ].join("\n");

    const result = redactSpaceKeys(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.redactionCount).toBe(0);
    expect(result.markdown).toBe(input);
  });

  it("returns REDACTION_SCAN_FAILED without markdown on non-string input, and the failure carries no raw key", () => {
    const realKey = makeKey(7);
    // A non-string value whose string form would contain the raw key. The
    // failure path must reject it before any scanning and must not echo the
    // value in the error detail.
    const badInput = { leak: realKey } as unknown as string;

    const result = redactSpaceKeys(badInput);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("REDACTION_SCAN_FAILED");
    expect("markdown" in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain(realKey);

    // Sanity: the well-formed key alone would have been redacted.
    const ok = redactSpaceKeys(`Bearer ${realKey}`);
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.redactionCount).toBe(1);
  });

  it("does not expose contentSanitized on its success result", () => {
    const result = redactSpaceKeys("plain text without any key");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // Runtime check: the field is absent.
    expect("contentSanitized" in result).toBe(false);
    // Compile-time check: assigning contentSanitized must not type-check.
    // (Modelled as a type-level assertion; if the type ever grows the field,
    // the assignment below becomes valid and the test's intent is violated.)
    type SuccessShape = Exclude<typeof result, { ok: false }>;
    const _typeCheck: SuccessShape extends { contentSanitized: unknown } ? "fail" : "pass" = "pass";
    expect(_typeCheck).toBe("pass");
  });
});
