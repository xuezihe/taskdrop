import { describe, expect, it } from "vitest";

import {
  createWorkingDraft,
  updateWorkingDraft,
  type CommittedRevision,
} from "../web/working-draft.js";

const committed: CommittedRevision = {
  code: "ABC001",
  revision: 3,
  markdown: "# Committed\n",
};

describe("Working Draft model", () => {
  it("lazily creates a Human Draft from the displayed committed Revision", () => {
    expect(
      createWorkingDraft(committed, "# Human edit\n", "human", "2026-08-28T08:00:00.000Z"),
    ).toEqual({
      handoffCode: "ABC001",
      baseRevision: 3,
      markdown: "# Human edit\n",
      lastModifiedVia: "human",
      contributors: ["human"],
      updatedAt: "2026-08-28T08:00:00.000Z",
    });
  });

  it("updates the existing Draft and records each surface once", () => {
    const initial = createWorkingDraft(
      committed,
      "# Human edit\n",
      "human",
      "2026-08-28T08:00:00.000Z",
    );

    const webmcpUpdate = updateWorkingDraft(
      initial,
      "# Agent edit\n",
      "webmcp",
      "2026-08-28T08:01:00.000Z",
    );
    const humanUpdate = updateWorkingDraft(
      webmcpUpdate,
      "# Final edit\n",
      "human",
      "2026-08-28T08:02:00.000Z",
    );

    expect(humanUpdate).toEqual({
      handoffCode: "ABC001",
      baseRevision: 3,
      markdown: "# Final edit\n",
      lastModifiedVia: "human",
      contributors: ["human", "webmcp"],
      updatedAt: "2026-08-28T08:02:00.000Z",
    });
  });

  it("retains an explicitly empty Draft as recoverable local state", () => {
    const draft = createWorkingDraft(committed, "", "human", "2026-08-28T08:00:00.000Z");

    expect(draft.markdown).toBe("");
    expect(draft.baseRevision).toBe(3);
  });
});
