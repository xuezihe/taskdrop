import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const cliPath = join(import.meta.dirname, "..", "dist", "production", "setup-cli.js");

function runCli(): string {
  return execFileSync("node", [cliPath], { encoding: "utf-8", timeout: 10_000 });
}

describe("setup CLI output", () => {
  it("prints a valid canonical Space Key", () => {
    const output = runCli();
    const lines = output.split("\n");
    const keyLine = lines.find((l) => /^tdp_[A-Za-z0-9_-]{43}$/.test(l));
    expect(keyLine).toBeDefined();
  });

  it("tells the user to retain exact spelling", () => {
    const output = runCli().toLowerCase();
    expect(output).toMatch(/retain|exact spelling/);
  });

  it("recommends the Bearer carrier", () => {
    const output = runCli();
    expect(output).toMatch(/bearer/i);
  });

  it("warns about Query carrier URL exposure", () => {
    const output = runCli().toLowerCase();
    expect(output).toMatch(/query/);
    expect(output).toMatch(/url/);
    expect(output).toMatch(/expos|warn/);
  });

  it("does not print a clickable credential-bearing URL", () => {
    const output = runCli();
    expect(output).not.toMatch(/https?:\/\//);
  });
});
