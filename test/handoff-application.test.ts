import { describe, expect, it, vi } from "vitest";

import {
  createHandoffApplication,
  type GetRevisionHistoryApplicationResult,
} from "../src/production/handoff-application.js";
import type { HandoffStore } from "../src/production/handoff-store.js";

const spaceId = Uint8Array.from([1, 2, 3]);

function uncalled<T>(): () => Promise<T> {
  return async () => {
    throw new Error("unexpected Store call");
  };
}

describe("HandoffApplication committed-state capabilities", () => {
  it("normalizes the Handoff Code and delegates Revision history", async () => {
    const history: GetRevisionHistoryApplicationResult = {
      ok: true,
      code: "ABC001",
      latestRevision: 2,
      expiresAt: "2026-08-30T08:00:00.000Z",
      revisions: [
        { revision: 2, origin: "webmcp", createdAt: "2026-08-28T08:00:00.000Z" },
        { revision: 1, origin: "mcp", createdAt: "2026-08-27T08:00:00.000Z" },
      ],
    };
    const getRevisionHistory = vi.fn(async (input: { spaceId: Uint8Array; code: string }) => {
      expect(input.spaceId).toBe(spaceId);
      expect(input.code).toBe("ABC001");
      return history;
    });
    const store = {
      cleanupExpiredHandoffs: uncalled<number>(),
      createHandoff: uncalled<never>(),
      getHandoff: uncalled<never>(),
      appendRevision: uncalled<never>(),
      getRevisionHistory,
    } satisfies HandoffStore;

    const application = createHandoffApplication(store);

    await expect(application.getRevisionHistory({ spaceId, code: "abc0oi" })).resolves.toEqual(
      history,
    );
    expect(getRevisionHistory).toHaveBeenCalledTimes(1);
  });

  it("passes a history not-found result through without changing it", async () => {
    const notFound: GetRevisionHistoryApplicationResult = {
      ok: false,
      error: { code: "HANDOFF_NOT_FOUND", handoffCode: "ABC001" },
    };
    const store = {
      cleanupExpiredHandoffs: uncalled<number>(),
      createHandoff: uncalled<never>(),
      getHandoff: uncalled<never>(),
      appendRevision: uncalled<never>(),
      getRevisionHistory: async () => notFound,
    } satisfies HandoffStore;

    const application = createHandoffApplication(store);

    await expect(application.getRevisionHistory({ spaceId, code: "ABC001" })).resolves.toEqual(
      notFound,
    );
  });
});
