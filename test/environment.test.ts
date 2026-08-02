import { describe, expect, it } from "vitest";

import { projectName } from "../src/index.js";

describe("project environment", () => {
  it("loads TypeScript source through Vitest", () => {
    expect(projectName).toBe("TaskDrop");
  });
});
