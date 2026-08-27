import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withTransaction, type Pool } from "../../src/production/db.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const skip = !DATABASE_URL;

describe.skipIf(skip)("pool and transaction helper", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  it("commits data when withTransaction succeeds", async () => {
    const spaceId = randomBytes(32);
    const code = "TXC001";

    await withTransaction(pool, async (client) => {
      await client.query(
        "INSERT INTO handoffs (space_id, code, latest_revision, expires_at) VALUES ($1, $2, 1, $3)",
        [spaceId, code, future],
      );
    });

    const result = await pool.query("SELECT code FROM handoffs WHERE space_id = $1 AND code = $2", [
      spaceId,
      code,
    ]);
    expect(result.rows).toHaveLength(1);

    await pool.query("DELETE FROM handoffs WHERE space_id = $1 AND code = $2", [spaceId, code]);
  });

  it("rolls back data when withTransaction throws", async () => {
    const spaceId = randomBytes(32);
    const code = "TXR001";

    await expect(
      withTransaction(pool, async (client) => {
        await client.query(
          "INSERT INTO handoffs (space_id, code, latest_revision, expires_at) VALUES ($1, $2, 1, $3)",
          [spaceId, code, future],
        );
        throw new Error("deliberate failure");
      }),
    ).rejects.toThrow("deliberate failure");

    const result = await pool.query("SELECT code FROM handoffs WHERE space_id = $1 AND code = $2", [
      spaceId,
      code,
    ]);
    expect(result.rows).toHaveLength(0);
  });
});
