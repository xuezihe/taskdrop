import type {
  CreateHandoffStoreResult,
  GetHandoffStoreResult,
  HandoffStore,
  HandoffStoreResult,
} from "./handoff-store.js";
import { redactSpaceKeys } from "./redaction.js";

export interface HandoffApplication {
  createHandoff(input: {
    spaceId: Uint8Array;
    markdown: string;
  }): Promise<CreateHandoffStoreResult>;
  getLatestHandoff(input: {
    spaceId: Uint8Array;
    code: string;
  }): Promise<GetHandoffStoreResult>;
  appendRevision(input: {
    spaceId: Uint8Array;
    code: string;
    baseRevision: number;
    markdown: string;
  }): Promise<HandoffStoreResult>;
}

export function createHandoffApplication(store: HandoffStore): HandoffApplication {
  return {
    async createHandoff({ spaceId, markdown }): Promise<CreateHandoffStoreResult> {
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
    }): Promise<HandoffStoreResult> {
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

function redactMarkdownForStorage(markdown: string) {
  const redaction = redactSpaceKeys(markdown);
  if (!redaction.ok) {
    throw new Error("redaction scan failed");
  }
  return redaction;
}
