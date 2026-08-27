import { describe, expect, it } from "vitest";

import {
  formatSpaceKey,
  isCanonicalSpaceKey,
  parseSpaceKey,
} from "../src/production/space-identity.js";
import { createSpaceKey } from "../web/generate-space-key.js";
import { LANGUAGE_STORAGE_KEY, resolveLanguage } from "../web/language.js";
import { bearerMcpFields, queryMcpFields, queryCredentialUrl } from "../web/mcp-config.js";
import { DEFAULT_MCP_ORIGIN, resolveMcpOrigin } from "../web/mcp-origin.js";
import {
  emptySession,
  sessionAfterCopy,
  sessionAfterGenerate,
  shouldWarnBeforeUnload,
} from "../web/session.js";

describe("landing Space Key generation", () => {
  it("formats exactly 32 injected CSPRNG bytes into a canonical Space Key", () => {
    const entropy = new Uint8Array(32);
    for (let i = 0; i < 32; i++) entropy[i] = i;
    const key = createSpaceKey((target) => {
      target.set(entropy);
      return target;
    });
    expect(isCanonicalSpaceKey(key)).toBe(true);
    expect(Array.from(parseSpaceKey(key))).toEqual(Array.from(entropy));
    expect(key).toBe(formatSpaceKey(entropy));
  });

  it("always consumes a 32-byte buffer even if the RNG writes fewer bytes", () => {
    const key = createSpaceKey((target) => {
      target[0] = 7;
      return target.subarray(0, 1);
    });
    expect(isCanonicalSpaceKey(key)).toBe(true);
    expect(parseSpaceKey(key)[0]).toBe(7);
    expect(parseSpaceKey(key).length).toBe(32);
  });
});

describe("landing MCP origin and config fields", () => {
  const key = formatSpaceKey(new Uint8Array(32));

  it("defaults to the configured hosted origin without a path", () => {
    expect(resolveMcpOrigin(undefined)).toBe("https://taskdrop.xuezihe.com");
    expect(resolveMcpOrigin("")).toBe(DEFAULT_MCP_ORIGIN);
    expect(resolveMcpOrigin("https://taskdrop.xuezihe.com/")).toBe("https://taskdrop.xuezihe.com");
  });

  it("accepts a future MCP hostname override", () => {
    expect(resolveMcpOrigin("https://mcp.taskdrop.me")).toBe("https://mcp.taskdrop.me");
  });

  it("rejects an origin that already includes a path", () => {
    expect(() => resolveMcpOrigin("https://taskdrop.xuezihe.com/mcp")).toThrow(/origin/i);
  });

  it("builds recommended Bearer fields against origin/mcp", () => {
    const fields = bearerMcpFields("https://taskdrop.xuezihe.com", key);
    expect(fields.url).toBe("https://taskdrop.xuezihe.com/mcp");
    expect(fields.transport).toBe("http");
    expect(fields.headers.Authorization).toBe(`Bearer ${key}`);
  });

  it("builds Query fields that treat the complete URL as a credential", () => {
    const origin = "https://taskdrop.xuezihe.com";
    const url = queryCredentialUrl(origin, key);
    expect(url).toBe(`${origin}/mcp?taskdropKey=${key}`);
    const fields = queryMcpFields(origin, key);
    expect(fields.url).toBe(url);
    expect(fields.transport).toBe("http");
    expect(fields).not.toHaveProperty("headers");
  });
});

describe("landing session", () => {
  const key = formatSpaceKey(new Uint8Array(32));
  const other = formatSpaceKey(new Uint8Array(32).fill(1));

  it("starts empty with no unload warning", () => {
    const session = emptySession();
    expect(session.spaceKey).toBeNull();
    expect(session.copied).toBe(false);
    expect(shouldWarnBeforeUnload(session)).toBe(false);
  });

  it("warns before unload until the generated Key is copied", () => {
    const generated = sessionAfterGenerate(emptySession(), key);
    expect(generated.spaceKey).toBe(key);
    expect(generated.copied).toBe(false);
    expect(shouldWarnBeforeUnload(generated)).toBe(true);
    expect(shouldWarnBeforeUnload(sessionAfterCopy(generated))).toBe(false);
  });

  it("replaces Key and MCP-facing session state on regenerate", () => {
    const regenerated = sessionAfterGenerate(
      sessionAfterCopy(sessionAfterGenerate(emptySession(), key)),
      other,
    );
    expect(regenerated.spaceKey).toBe(other);
    expect(regenerated.copied).toBe(false);
    expect(shouldWarnBeforeUnload(regenerated)).toBe(true);
  });
});

describe("landing language preference", () => {
  it("uses a stored language code when it is en or zh", () => {
    expect(resolveLanguage(["en-US"], "zh")).toBe("zh");
    expect(resolveLanguage(["zh-CN"], "en")).toBe("en");
  });

  it("falls back to Chinese only when the browser language is zh*", () => {
    expect(resolveLanguage(["zh-CN", "en"], null)).toBe("zh");
    expect(resolveLanguage(["en-US"], null)).toBe("en");
    expect(resolveLanguage(["fr-FR"], "de")).toBe("en");
  });
});

describe("landing persistence boundary", () => {
  it("stores only the language preference key name, never a Space Key storage key", () => {
    expect(LANGUAGE_STORAGE_KEY).toBe("taskdrop.landing.lang");
    expect(LANGUAGE_STORAGE_KEY).not.toMatch(/key|space|tdp/i);
  });
});
