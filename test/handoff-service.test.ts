import { describe, expect, it } from "vitest";

import { HandoffService } from "../src/prototypes/p2-minimum-handoff/handoff-service.js";

const SPACE_KEY = `tdp_${"A".repeat(43)}`;
const REDACTION = "[REDACTED TASKDROP SPACE KEY]";

describe("HandoffService sensitive-content guard", () => {
  it("redacts TaskDrop Space Keys before creating a Handoff", () => {
    const service = new HandoffService();

    const result = service.createHandoff(
      "scope-a",
      `Configured with TASKDROP_P5_SPACE_KEY=${SPACE_KEY}`,
    );

    expect(result).toMatchObject({
      ok: true,
      revision: 1,
      latestRevision: 1,
      markdown: `Configured with TASKDROP_P5_SPACE_KEY=${REDACTION}`,
      contentSanitized: true,
      redactionCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain(SPACE_KEY);
  });

  it("stores an appended Revision only after redacting every TaskDrop Space Key", () => {
    const service = new HandoffService();
    const created = service.createHandoff("scope-a", "Safe Revision 1");
    if (!created.ok) throw new Error("Expected the safe Handoff to be created");

    const result = service.appendRevision(
      "scope-a",
      created.code,
      created.revision,
      `first=${SPACE_KEY}\nsecond=${SPACE_KEY}`,
    );

    expect(result).toMatchObject({
      ok: true,
      revision: 2,
      latestRevision: 2,
      markdown: `first=${REDACTION}\nsecond=${REDACTION}`,
      contentSanitized: true,
      redactionCount: 2,
    });
    expect(service.getHandoff("scope-a", created.code, "latest")).toMatchObject({
      ok: true,
      revision: 2,
      latestRevision: 2,
      markdown: `first=${REDACTION}\nsecond=${REDACTION}`,
      contentSanitized: true,
      redactionCount: 2,
    });
    expect(service.getHandoff("scope-a", created.code, 1)).toMatchObject({
      ok: true,
      revision: 1,
      latestRevision: 2,
      markdown: "Safe Revision 1",
      contentSanitized: false,
      redactionCount: 0,
    });
  });

  it("does not reject ordinary references to the Space Key concept", () => {
    const service = new HandoffService();

    const result = service.createHandoff(
      "scope-a",
      "The Space Key is configured through TASKDROP_P5_SPACE_KEY and is redacted.",
    );

    expect(result).toMatchObject({
      ok: true,
      contentSanitized: false,
      redactionCount: 0,
    });
  });
});
