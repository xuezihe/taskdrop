import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, type Pool } from "../../src/production/db.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const skip = !DATABASE_URL;
const cliPath = join(import.meta.dirname, "..", "..", "dist", "production", "migrate.js");
const initialMigrationPath = join(
  import.meta.dirname,
  "..",
  "..",
  "src",
  "production",
  "migrations",
  "001-initial.sql",
);

function runMigrate(databaseUrl: string): string {
  return execFileSync("node", [cliPath], {
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

function preOriginDatabaseUrl(): string {
  return DATABASE_URL!.replace(/(\/)([^/?]+)([?#]|$)/, "$1taskdrop_preorigin$3");
}

describe.skipIf(skip)("migration", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
    runMigrate(DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates handoffs and revisions tables on a fresh database", async () => {
    const tables = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const names = tables.rows.map((r: { tablename: string }) => r.tablename);
    expect(names).toContain("handoffs");
    expect(names).toContain("revisions");
    expect(names).toContain("schema_migrations");
  });

  it("creates a non-null, constrained origin column on a fresh database", async () => {
    const column = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'revisions' AND column_name = 'origin'`,
    );
    expect(column.rows).toHaveLength(1);
    expect(column.rows[0]!.is_nullable).toBe("NO");
  });

  it("is idempotent — re-running migrate does not error and records unchanged", async () => {
    const before = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    const output = runMigrate(DATABASE_URL!);
    expect(output).toContain("no pending migrations");
    const after = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("backfills existing pre-origin revisions as mcp when applying the origin migration", async () => {
    const preOriginUrl = preOriginDatabaseUrl();
    const preOriginPool = createPool(preOriginUrl);
    const spaceId = Buffer.from("a".repeat(32), "ascii");
    const code = "ABC123";
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    try {
      await preOriginPool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await preOriginPool.query("CREATE SCHEMA public");
      await preOriginPool.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version text NOT NULL PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );

      const initialSql = readFileSync(initialMigrationPath, "utf-8");
      await preOriginPool.query(initialSql);

      await preOriginPool.query(
        "INSERT INTO handoffs (space_id, code, latest_revision, expires_at) VALUES ($1, $2, 1, $3)",
        [spaceId, code, future],
      );
      await preOriginPool.query(
        `INSERT INTO revisions
           (space_id, handoff_code, revision, markdown, created_at, redaction_count)
         VALUES ($1, $2, 1, $3, now(), 0)`,
        [spaceId, code, "pre-origin revision"],
      );
      await preOriginPool.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
        "001-initial",
      ]);

      const output = runMigrate(preOriginUrl);
      expect(output).toContain("002-revision-origin");

      const migrated = await preOriginPool.query<{ origin: string }>(
        "SELECT origin FROM revisions WHERE space_id = $1 AND handoff_code = $2",
        [spaceId, code],
      );
      expect(migrated.rows).toEqual([{ origin: "mcp" }]);

      const migrationRecord = await preOriginPool.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = '002-revision-origin'",
      );
      expect(migrationRecord.rows).toEqual([{ version: "002-revision-origin" }]);
    } finally {
      await preOriginPool.end();
    }
  });
});
