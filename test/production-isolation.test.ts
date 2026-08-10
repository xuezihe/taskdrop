import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const productionRoot = join(import.meta.dirname, "..", "src", "production");
const testRoot = join(import.meta.dirname);
const prototypePathLiteral = /["'`][^"'`\r\n]*prototype[s]\/[^"'`\r\n]*["'`]/;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function findPrototypePathUsers(root: string): string[] {
  return listTsFiles(root)
    .filter((file) => prototypePathLiteral.test(readFileSync(file, "utf8")))
    .map((file) => relative(process.cwd(), file));
}

describe("production isolation", () => {
  it("no production source references the prototype runtime tree", () => {
    const files = listTsFiles(productionRoot);
    expect(files.length).toBeGreaterThan(0);
    expect(findPrototypePathUsers(productionRoot)).toEqual([]);
  });

  it("no test source references the prototype runtime tree", () => {
    expect(findPrototypePathUsers(testRoot)).toEqual([]);
  });
});
