import type {
  CreateHandoffStoreResult,
  GetHandoffStoreResult,
  HandoffStore,
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
}

export function createHandoffApplication(store: HandoffStore): HandoffApplication {
  return {
    async createHandoff({ spaceId, markdown }): Promise<CreateHandoffStoreResult> {
      const redaction = redactSpaceKeys(markdown);
      if (!redaction.ok) {
        throw new Error("redaction scan failed");
      }

      return store.createHandoff({
        spaceId,
        markdown: redaction.markdown,
        redactionCount: redaction.redactionCount,
      });
    },
    getLatestHandoff: ({ spaceId, code }) =>
      store.getHandoff({ spaceId, code, revision: "latest" }),
  };
}
