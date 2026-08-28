import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withTransaction, type Pool } from "../../src/production/db.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const skip = !DATABASE_URL;

describe.skipIf(skip)("schema constraints", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  const validSpaceId = randomBytes(32);
  const validCode = "ABC123";
  const now = new Date();
  const future = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  it("FK cascade deletes revisions when handoff is deleted", async () => {
    const spaceId = randomBytes(32);
    const code = "FKT001";

    await withTransaction(pool, async (client) => {
      await client.query(
        "INSERT INTO handoffs (space_id, code, latest_revision, expires_at) VALUES ($1, $2, 1, $3)",
        [spaceId, code, future],
      );
      await client.query(
        "INSERT INTO revisions (space_id, handoff_code, revision, markdown, created_at, redaction_count, origin) VALUES ($1, $2, 1, $3, $4, 0, 'mcp')",
        [spaceId, code, "hello", now],
      );
    });

    await pool.query("DELETE FROM handoffs WHERE space_id = $1 AND code = $2", [spaceId, code]);

    const revisions = await pool.query(
      "SELECT count(*)::int AS n FROM revisions WHERE space_id = $1 AND handoff_code = $2",
      [spaceId, code],
    );
    expect(revisions.rows[0].n).toBe(0);
  });

  it("rejects space_id not exactly 32 bytes", async () => {
    const badId = randomBytes(16);
    await expect(
      pool.query(
        "INSERT INTO handoffs (space_id, code, latest_revision, expires_at) VALUES ($1, $2, 1, $3)",
        [badId, validCode, future],
      ),
    ).rejects.toThrow();
  });

  it("rejects lowercase or non-6-char handoff code", async () => {
    for (const badCode of ["abc123", "AB12", "ABCDEFG"]) {
      await expect(
        pool.query(
          "INSERT INTO handoffs (space_id, code, latest_revision, expires_at) VALUES ($1, $2, 1, $3)",
          [validSpaceId, badCode, future],
        ),
      ).rejects.toThrow();
    }
  });

  it("rejects revision out of range [1, 25]", async () => {
    const spaceId = randomBytes(32);
    const code = "RVR001";

    await pool.query(
      "INSERT INTO handoffs (space_id, code, latest_revision, expires_at) VALUES ($1, $2, 1, $3)",
      [spaceId, code, future],
    );

    for (const badRevision of [0, 26]) {
      await expect(
        pool.query(
          "INSERT INTO revisions (space_id, handoff_code, revision, markdown, created_at, redaction_count, origin) VALUES ($1, $2, $3, $4, $5, 0, 'mcp')",
          [spaceId, code, badRevision, "x", now],
        ),
      ).rejects.toThrow();
    }

    await pool.query("DELETE FROM handoffs WHERE space_id = $1 AND code = $2", [spaceId, code]);
  });

  it("rejects negative redaction_count", async () => {
    const spaceId = randomBytes(32);
    const code = "RDN001";

    await pool.query(
      "INSERT INTO handoffs (space_id, code, latest_revision, expires_at) VALUES ($1, $2, 1, $3)",
      [spaceId, code, future],
    );

    await expect(
      pool.query(
        "INSERT INTO revisions (space_id, handoff_code, revision, markdown, created_at, redaction_count, origin) VALUES ($1, $2, 1, $3, $4, -1, 'mcp')",
        [spaceId, code, "x", now],
      ),
    ).rejects.toThrow();

    await pool.query("DELETE FROM handoffs WHERE space_id = $1 AND code = $2", [spaceId, code]);
  });

  it("rejects a revision origin outside the allowed set", async () => {
    const spaceId = randomBytes(32);
    const code = "ORG001";

    await pool.query(
      "INSERT INTO handoffs (space_id, code, latest_revision, expires_at) VALUES ($1, $2, 1, $3)",
      [spaceId, code, future],
    );

    await expect(
      pool.query(
        "INSERT INTO revisions (space_id, handoff_code, revision, markdown, created_at, redaction_count, origin) VALUES ($1, $2, 1, $3, $4, 0, 'agent')",
        [spaceId, code, "x", now],
      ),
    ).rejects.toThrow();

    await expect(
      pool.query(
        "INSERT INTO revisions (space_id, handoff_code, revision, markdown, created_at, redaction_count, origin) VALUES ($1, $2, 1, $3, $4, 0, NULL)",
        [spaceId, code, "x", now],
      ),
    ).rejects.toThrow();

    await pool.query("DELETE FROM handoffs WHERE space_id = $1 AND code = $2", [spaceId, code]);
  });
});
