import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPool, withTransaction, type Pool } from "./db.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

interface MigrationFile {
  version: string;
  sql: string;
}

function listMigrationFiles(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((f) => ({
    version: f.replace(/\.sql$/, ""),
    sql: readFileSync(join(MIGRATIONS_DIR, f), "utf-8"),
  }));
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        NOT NULL PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedVersions(pool: Pool): Promise<Set<string>> {
  const result = await pool.query("SELECT version FROM schema_migrations");
  return new Set(result.rows.map((r: { version: string }) => r.version));
}

async function migrate(databaseUrl: string): Promise<void> {
  const pool = createPool(databaseUrl);
  try {
    await ensureMigrationsTable(pool);
    const applied = await getAppliedVersions(pool);
    const files = listMigrationFiles();
    const pending = files.filter((f) => !applied.has(f.version));

    if (pending.length === 0) {
      process.stdout.write("no pending migrations\n");
      return;
    }

    for (const file of pending) {
      await withTransaction(pool, async (client) => {
        await client.query(file.sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
          file.version,
        ]);
      });
      process.stdout.write(`applied: ${file.version}\n`);
    }
  } finally {
    await pool.end();
  }
}

function main(): void {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    process.stderr.write("DATABASE_URL is required\n");
    process.exit(1);
  }
  migrate(databaseUrl).catch((err) => {
    process.stderr.write(`migration failed: ${String(err)}\n`);
    process.exit(1);
  });
}

main();
