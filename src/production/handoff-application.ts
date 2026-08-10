import { Buffer } from "node:buffer";

import type {
  CreateHandoffStoreResult,
  GetHandoffStoreResult,
  HandoffStore,
  HandoffStoreResult,
} from "./handoff-store.js";
import { MAX_MARKDOWN_BYTES } from "./handoff-limits.js";
import { redactSpaceKeys } from "./redaction.js";

export interface ContentTooLarge {
  ok: false;
  error: { code: "CONTENT_TOO_LARGE"; limitBytes: typeof MAX_MARKDOWN_BYTES };
}

export type CreateHandoffApplicationResult = CreateHandoffStoreResult | ContentTooLarge;
export type AppendRevisionApplicationResult = HandoffStoreResult | ContentTooLarge;

export interface HandoffApplication {
  createHandoff(input: {
    spaceId: Uint8Array;
    markdown: string;
  }): Promise<CreateHandoffApplicationResult>;
  getLatestHandoff(input: {
    spaceId: Uint8Array;
    code: string;
  }): Promise<GetHandoffStoreResult>;
  appendRevision(input: {
    spaceId: Uint8Array;
    code: string;
    baseRevision: number;
    markdown: string;
  }): Promise<AppendRevisionApplicationResult>;
}

export function createHandoffApplication(store: HandoffStore): HandoffApplication {
  return {
    async createHandoff({ spaceId, markdown }): Promise<CreateHandoffApplicationResult> {
      const sizeError = rejectOversizedMarkdown(markdown);
      if (sizeError) return sizeError;

      const redaction = redactMarkdownForStorage(markdown);

      return store.createHandoff({
        spaceId,
        markdown: redaction.markdown,
        redactionCount: redaction.redactionCount,
      });
    },
    getLatestHandoff: ({ spaceId, code }) =>
      store.getHandoff({ spaceId, code, revision: "latest" }),
    async appendRevision({
      spaceId,
      code,
      baseRevision,
      markdown,
    }): Promise<AppendRevisionApplicationResult> {
      const sizeError = rejectOversizedMarkdown(markdown);
      if (sizeError) return sizeError;

      const redaction = redactMarkdownForStorage(markdown);

      return store.appendRevision({
        spaceId,
        code,
        baseRevision,
        markdown: redaction.markdown,
        redactionCount: redaction.redactionCount,
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
