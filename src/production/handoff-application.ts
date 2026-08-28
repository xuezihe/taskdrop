import { Buffer } from "node:buffer";

import type {
  CreateHandoffStoreResult,
  GetRevisionHistoryStoreResult,
  GetHandoffStoreResult,
  HandoffStore,
  HandoffStoreResult,
} from "./handoff-store.js";
import { normalizeHandoffCode } from "./handoff-code.js";
import { MAX_MARKDOWN_BYTES } from "./handoff-limits.js";
import type { RevisionOrigin } from "./revision-origin.js";
import { redactSpaceKeys } from "./redaction.js";

export interface ContentTooLarge {
  ok: false;
  error: { code: "CONTENT_TOO_LARGE"; limitBytes: typeof MAX_MARKDOWN_BYTES };
}

export type CreateHandoffApplicationResult = CreateHandoffStoreResult | ContentTooLarge;
export type AppendRevisionApplicationResult = HandoffStoreResult | ContentTooLarge;
export type GetRevisionHistoryApplicationResult = GetRevisionHistoryStoreResult;

export interface HandoffApplication {
  createHandoff(input: {
    spaceId: Uint8Array;
    markdown: string;
    origin: RevisionOrigin;
  }): Promise<CreateHandoffApplicationResult>;
  getHandoff(input: {
    spaceId: Uint8Array;
    code: string;
    revision: number | "latest";
  }): Promise<GetHandoffStoreResult>;
  getRevisionHistory(input: {
    spaceId: Uint8Array;
    code: string;
  }): Promise<GetRevisionHistoryApplicationResult>;
  appendRevision(input: {
    spaceId: Uint8Array;
    code: string;
    baseRevision: number;
    markdown: string;
    origin: RevisionOrigin;
  }): Promise<AppendRevisionApplicationResult>;
}

export function createHandoffApplication(store: HandoffStore): HandoffApplication {
  return {
    async createHandoff({ spaceId, markdown, origin }): Promise<CreateHandoffApplicationResult> {
      const sizeError = rejectOversizedMarkdown(markdown);
      if (sizeError) return sizeError;

      const redaction = redactMarkdownForStorage(markdown);

      return store.createHandoff({
        spaceId,
        markdown: redaction.markdown,
        redactionCount: redaction.redactionCount,
        origin,
      });
    },
    getHandoff: ({ spaceId, code, revision }) =>
      store.getHandoff({
        spaceId,
        code: normalizeHandoffCode(code),
        revision,
      }),
    getRevisionHistory: ({ spaceId, code }) =>
      store.getRevisionHistory({
        spaceId,
        code: normalizeHandoffCode(code),
      }),
    async appendRevision({
      spaceId,
      code,
      baseRevision,
      markdown,
      origin,
    }): Promise<AppendRevisionApplicationResult> {
      const sizeError = rejectOversizedMarkdown(markdown);
      if (sizeError) return sizeError;

      const redaction = redactMarkdownForStorage(markdown);

      return store.appendRevision({
        spaceId,
        code: normalizeHandoffCode(code),
        baseRevision,
        markdown: redaction.markdown,
        redactionCount: redaction.redactionCount,
        origin,
      });
    },
  };
}

function rejectOversizedMarkdown(markdown: string): ContentTooLarge | null {
  if (Buffer.byteLength(markdown, "utf8") <= MAX_MARKDOWN_BYTES) return null;
  return {
    ok: false,
    error: { code: "CONTENT_TOO_LARGE", limitBytes: MAX_MARKDOWN_BYTES },
  };
}

function redactMarkdownForStorage(markdown: string) {
  const redaction = redactSpaceKeys(markdown);
  if (!redaction.ok) {
    throw new Error("redaction scan failed");
  }
  return redaction;
}
