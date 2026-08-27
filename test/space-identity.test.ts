import { describe, expect, it } from "vitest";

import {
  deriveSpaceFingerprint,
  deriveSpaceId,
  formatSpaceKey,
  isCanonicalSpaceKey,
  parseSpaceId,
  parseSpaceKey,
} from "../src/production/space-identity.js";

describe("space identity known-answer", () => {
  it("derives the exact Space ID for 32 zero bytes", async () => {
    const keyBytes = new Uint8Array(32);
    const spaceId = await deriveSpaceId(keyBytes);
    const hex = Array.from(spaceId, (b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe("181d0758ffa73f59cb5ba396e9f057f5256f9c9df754494441cfa8792aaa0fc5");
  });

  it("derives the exact 12-character Space Fingerprint for the known Space ID", async () => {
    const spaceIdHex = "181d0758ffa73f59cb5ba396e9f057f5256f9c9df754494441cfa8792aaa0fc5";
    const spaceId = new Uint8Array(spaceIdHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const fingerprint = await deriveSpaceFingerprint(spaceId);
    expect(fingerprint).toBe("-o-8vzjhQgZ_");
  });

  it("proves the Fingerprint is not a prefix of the Space ID", async () => {
    const spaceIdHex = "181d0758ffa73f59cb5ba396e9f057f5256f9c9df754494441cfa8792aaa0fc5";
    const spaceId = new Uint8Array(spaceIdHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    const fingerprint = await deriveSpaceFingerprint(spaceId);
    expect(spaceIdHex.startsWith(fingerprint)).toBe(false);
  });
});

describe("space key format and round trip", () => {
  it("formats 32 bytes to tdp_ prefix + 43 unpadded Base64URL chars and round-trips", () => {
    const entropy = new Uint8Array(32);
    for (let i = 0; i < 32; i++) entropy[i] = i;
    const key = formatSpaceKey(entropy);
    expect(key).toMatch(/^tdp_[A-Za-z0-9_-]{43}$/);
    expect(key).not.toContain("=");
    const decoded = parseSpaceKey(key);
    expect(Array.from(decoded)).toEqual(Array.from(entropy));
  });
});

describe("input validation boundaries", () => {
  const validKey = formatSpaceKey(new Uint8Array(32));

  const invalidSpaceKeys: Array<[string, string]> = [
    [` ${validKey}`, "leading whitespace"],
    [`${validKey} `, "trailing whitespace"],
    [`${validKey}\n`, "trailing newline"],
    [`${validKey}=`, "padding"],
    [`TDP_${validKey.slice(4)}`, "uppercase prefix"],
    [`tdp_${"A".repeat(42)}`, "too short"],
    [`tdp_${"A".repeat(44)}`, "too long"],
    [`x_${validKey.slice(4)}`, "wrong prefix"],
    ["", "empty"],
  ];

  for (const [input, reason] of invalidSpaceKeys) {
    it(`rejects Space Key with ${reason}`, () => {
      expect(isCanonicalSpaceKey(input)).toBe(false);
      expect(() => parseSpaceKey(input)).toThrow();
    });
  }

  it("accepts a canonical Space Key", () => {
    expect(isCanonicalSpaceKey(validKey)).toBe(true);
    expect(parseSpaceKey(validKey).length).toBe(32);
  });

  const invalidSpaceIds: Array<[string, string]> = [
    ["", "empty"],
    ["abc", "too short"],
    ["xyz".repeat(22), "non-hex characters"],
    ["0".repeat(63), "63 chars"],
    ["0".repeat(65), "65 chars"],
  ];

  for (const [input, reason] of invalidSpaceIds) {
    it(`rejects Space ID with ${reason}`, () => {
      expect(() => parseSpaceId(input)).toThrow();
    });
  }

  it("accepts a 64-char hex Space ID", () => {
    const hex = "0".repeat(64);
    expect(parseSpaceId(hex).length).toBe(32);
  });
});
