import { isCanonicalSpaceKey } from "./space-identity.js";

export const REDACTED_SPACE_KEY_PLACEHOLDER = "[REDACTED TASKDROP SPACE KEY]";

export interface RedactionSuccess {
  ok: true;
  markdown: string;
  redactionCount: number;
}

export interface RedactionFailure {
  ok: false;
  error: { code: "REDACTION_SCAN_FAILED" };
}

export type RedactionResult = RedactionSuccess | RedactionFailure;

// Boundary-aware scan: the tdp_ prefix must not be preceded by, and the
// 43-char body must not be followed by, another base64url character. This
// prevents matching a canonical key embedded inside a longer base64url run.
// Lookbehind/lookahead are supported on Node 24 (ES2024 target).
const SPACE_KEY_CANDIDATE =
  /(?<![A-Za-z0-9_-])tdp_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;

// Redacts every canonical TaskDrop Space Key in the input Markdown by
// replacing it with a fixed placeholder and counting the replacements.
//
// Non-canonical lookalikes (e.g. a 43-char base64url run whose final char's
// low bits are dropped on decode, breaking the round-trip invariant) are left
// in place. The caller derives contentSanitized from redactionCount > 0; this
// module does not persist or compute it.
//
// On any unexpected condition the function returns a RedactionFailure with no
// markdown field, so the caller can never store unverified Markdown. The
// failure carries no raw key material.
export function redactSpaceKeys(input: string): RedactionResult {
  if (typeof input !== "string") {
    return { ok: false, error: { code: "REDACTION_SCAN_FAILED" } };
  }

  try {
    let redactionCount = 0;
    const markdown = input.replace(SPACE_KEY_CANDIDATE, (candidate) => {
      if (!isCanonicalSpaceKey(candidate)) return candidate;
      redactionCount += 1;
      return REDACTED_SPACE_KEY_PLACEHOLDER;
    });
    return { ok: true, markdown, redactionCount };
  } catch {
    return { ok: false, error: { code: "REDACTION_SCAN_FAILED" } };
  }
}
