import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, type Pool } from "../../src/production/db.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const skip = !DATABASE_URL;
const cliPath = join(import.meta.dirname, "..", "..", "dist", "production", "migrate.js");

function runMigrate(): string {
  return execFileSync("node", [cliPath], {
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, DATABASE_URL: DATABASE_URL! },
  });
}

describe.skipIf(skip)("migration", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates handoffs and revisions tables on a fresh database", async () => {
    runMigrate();
    const tables = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const names = tables.rows.map((r: { tablename: string }) => r.tablename);
    expect(names).toContain("handoffs");
    expect(names).toContain("revisions");
    expect(names).toContain("schema_migrations");
  });

  it("is idempotent — re-running migrate does not error and records unchanged", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    const output = runMigrate();
    expect(output).toContain("no pending migrations");
    const after = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
