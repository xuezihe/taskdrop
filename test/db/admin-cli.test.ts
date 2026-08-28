import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runAdminCommand } from "../../src/production/admin-cli.js";
import { createPool, type Pool, withTransaction } from "../../src/production/db.js";
import {
  deriveSpaceFingerprint,
  deriveSpaceId,
  formatSpaceKey,
  parseSpaceKey,
} from "../../src/production/space-identity.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const skip = !DATABASE_URL;

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

describe.skipIf(skip)("Admin CLI", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("inspects bounded Space metadata using PostgreSQL time and UTF-8 byte totals", async () => {
    const spaceId = randomBytes(32);
    const fingerprint = await deriveSpaceFingerprint(spaceId);
    const markdown = {
      liveA1: "机密界",
      liveA2: "alpha-secret-content",
      liveB1: "beta-secret",
      expired: "[REDACTED fixture secret]",
    };
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO handoffs (space_id, code, latest_revision, expires_at)
         VALUES ($1, 'LIVEA1', 2, now() + interval '1 hour'),
                ($1, 'LIVEB1', 1, now() + interval '2 hours'),
                ($1, 'DEAD01', 1, now() - interval '1 hour')`,
        [spaceId],
      );
      await client.query(
        `INSERT INTO revisions
           (space_id, handoff_code, revision, markdown, created_at, redaction_count, origin)
         VALUES ($1, 'LIVEA1', 1, $2, now() - interval '3 hours', 0, 'mcp'),
                ($1, 'LIVEA1', 2, $3, now() - interval '2 hours', 0, 'mcp'),
                ($1, 'LIVEB1', 1, $4, now() - interval '1 hour', 0, 'mcp'),
                ($1, 'DEAD01', 1, $5, now() - interval '4 hours', 1, 'mcp')`,
        [spaceId, markdown.liveA1, markdown.liveA2, markdown.liveB1, markdown.expired],
      );
    });
    const expectedTimestamps = await pool.query<{
      code: string;
      revision_one_created_at: Date;
      expires_at: Date;
    }>(
      `SELECT h.code,
              min(r.created_at) FILTER (WHERE r.revision = 1) AS revision_one_created_at,
              h.expires_at
       FROM handoffs h
       JOIN revisions r ON r.space_id = h.space_id AND r.handoff_code = h.code
       WHERE h.space_id = $1
       GROUP BY h.code, h.expires_at
       ORDER BY h.code`,
      [spaceId],
    );

    let stdout = "";
    let stderr = "";
    try {
      const exitStatus = await runAdminCommand({
        args: ["inspect", "--space-id", toHex(spaceId)],
        databaseUrl: DATABASE_URL!,
        readSpaceKey: async () => {
          throw new Error("Space Key input was not requested");
        },
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });

      expect(exitStatus).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(`Space Fingerprint: ${fingerprint}`);
      expect(stdout).toMatch(/Database time: \d{4}-\d{2}-\d{2}T/);
      expect(stdout).toContain("Handoffs: live=2 expired=1 total=3");
      expect(stdout).toContain("Revisions: total=4");
      expect(stdout).toContain("Markdown bytes: live=40 total=65");
      expect(stdout).toMatch(/LIVEA1 \| live \| latest=2 \| revisions=2 .* markdownBytes=29/);
      expect(stdout).toMatch(/LIVEB1 \| live \| latest=1 \| revisions=1 .* markdownBytes=11/);
      expect(stdout).toMatch(/DEAD01 \| expired \| latest=1 \| revisions=1 .* markdownBytes=25/);
      expect(stdout.indexOf("LIVEA1")).toBeLessThan(stdout.indexOf("LIVEB1"));
      expect(stdout.indexOf("LIVEB1")).toBeLessThan(stdout.indexOf("DEAD01"));
      for (const timestamp of expectedTimestamps.rows) {
        const line = stdout.split("\n").find((candidate) => candidate.startsWith(timestamp.code));
        expect(line).toContain(
          `revision1CreatedAt=${timestamp.revision_one_created_at.toISOString()}`,
        );
        expect(line).toContain(`expiresAt=${timestamp.expires_at.toISOString()}`);
      }

      const completeOutput = `${stdout}\n${stderr}`;
      expect(completeOutput).not.toContain(toHex(spaceId));
      expect(completeOutput).not.toContain(DATABASE_URL!);
      for (const content of Object.values(markdown)) {
        expect(completeOutput).not.toContain(content);
      }
    } finally {
      await pool.query("DELETE FROM handoffs WHERE space_id = $1", [spaceId]);
    }
  });

  it("converges Space Key, Space ID, and stored Fingerprint inspection on one summary", async () => {
    const spaceKey = formatSpaceKey(randomBytes(32));
    const spaceId = await deriveSpaceId(parseSpaceKey(spaceKey));
    const fingerprint = await deriveSpaceFingerprint(spaceId);
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO handoffs (space_id, code, latest_revision, expires_at)
         VALUES ($1, 'PATH20', 1, now() + interval '1 hour')`,
        [spaceId],
      );
      await client.query(
        `INSERT INTO revisions
           (space_id, handoff_code, revision, markdown, created_at, redaction_count, origin)
         VALUES ($1, 'PATH20', 1, 'identity path secret', now(), 0, 'mcp')`,
        [spaceId],
      );
    });

    const invoke = async (args: string[], readSpaceKey: () => Promise<string>) => {
      let stdout = "";
      let stderr = "";
      const status = await runAdminCommand({
        args,
        databaseUrl: DATABASE_URL!,
        readSpaceKey,
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });
      return { status, stdout, stderr };
    };

    try {
      const byKey = await invoke(["inspect", "--space-key"], async () => spaceKey);
      const byId = await invoke(["inspect", "--space-id", toHex(spaceId)], async () => {
        throw new Error("Space Key input was not requested");
      });
      const byFingerprint = await invoke(
        ["inspect", "--space-fingerprint", fingerprint],
        async () => {
          throw new Error("Space Key input was not requested");
        },
      );

      expect([byKey.status, byId.status, byFingerprint.status]).toEqual([0, 0, 0]);
      expect([byKey.stderr, byId.stderr, byFingerprint.stderr]).toEqual(["", "", ""]);
      const withoutDatabaseTime = (output: string) =>
        output.replace(/Database time: .*\n/, "Database time: <db-now>\n");
      expect(withoutDatabaseTime(byKey.stdout)).toBe(withoutDatabaseTime(byId.stdout));
      expect(withoutDatabaseTime(byFingerprint.stdout)).toBe(withoutDatabaseTime(byId.stdout));
      expect(`${byKey.stdout}${byKey.stderr}`).not.toContain(spaceKey);
    } finally {
      await pool.query("DELETE FROM handoffs WHERE space_id = $1", [spaceId]);
    }
  });

  it("validates one identity before database access and reports empty or unmatched Spaces", async () => {
    const emptyKey = formatSpaceKey(randomBytes(32));
    const emptySpaceId = await deriveSpaceId(parseSpaceKey(emptyKey));
    const emptyFingerprint = await deriveSpaceFingerprint(emptySpaceId);

    const invoke = async (
      args: string[],
      databaseUrl: string | undefined,
      readSpaceKey: () => Promise<string> = async () => emptyKey,
    ) => {
      let stdout = "";
      let stderr = "";
      const status = await runAdminCommand({
        args,
        databaseUrl,
        readSpaceKey,
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });
      return { status, stdout, stderr };
    };

    const invalidInvocations = [
      [],
      ["inspect"],
      ["inspect", "--space-key", emptyKey],
      ["inspect", "--space-id", toHex(emptySpaceId), "--space-key"],
      ["inspect", "--space-id", "A".repeat(64)],
      ["stats", "unexpected-arg"],
    ];
    for (const args of invalidInvocations) {
      const result = await invoke(args, "postgres://invalid-before-db");
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Usage:");
    }

    const invalidKey = await invoke(
      ["inspect", "--space-key"],
      "postgres://invalid-before-db",
      async () => `${emptyKey} `,
    );
    expect(invalidKey.status).toBe(2);
    expect(invalidKey.stderr).toContain("invalid Space Key");

    const emptyById = await invoke(["inspect", "--space-id", toHex(emptySpaceId)], DATABASE_URL!);
    expect(emptyById.status).toBe(0);
    expect(emptyById.stdout).toContain(`Space Fingerprint: ${emptyFingerprint}`);
    expect(emptyById.stdout).toContain("Handoffs: live=0 expired=0 total=0");
    expect(emptyById.stdout).toContain("No stored Handoffs.");

    const emptyByKey = await invoke(
      ["inspect", "--space-key"],
      DATABASE_URL!,
      async () => emptyKey,
    );
    expect(emptyByKey.status).toBe(0);
    expect(emptyByKey.stdout).toContain(`Space Fingerprint: ${emptyFingerprint}`);
    expect(emptyByKey.stdout).toContain("Handoffs: live=0 expired=0 total=0");
    expect(`${emptyByKey.stdout}${emptyByKey.stderr}`).not.toContain(emptyKey);

    const noMatch = await invoke(
      ["inspect", "--space-fingerprint", emptyFingerprint],
      DATABASE_URL!,
    );
    expect(noMatch.status).toBe(0);
    expect(noMatch.stdout).toContain("No stored Space matches this Fingerprint");
    expect(noMatch.stdout).toContain("Fingerprint lookup only covers stored Handoffs");
  });

  it("runs one bounded expired-Handoff cleanup pass without draining or deleting live data", async () => {
    const expiredSpaceId = randomBytes(32);
    const liveSpaceId = randomBytes(32);
    await pool.query(
      `INSERT INTO handoffs (space_id, code, latest_revision, expires_at)
       SELECT $1, lpad(n::text, 6, '0'), 1, now() - interval '1 hour'
       FROM generate_series(1, 101) AS fixture(n)`,
      [expiredSpaceId],
    );
    await pool.query(
      `INSERT INTO revisions
         (space_id, handoff_code, revision, markdown, created_at, redaction_count, origin)
       SELECT $1, lpad(n::text, 6, '0'), 1, 'cleanup secret', now() - interval '2 hours', 0, 'mcp'
       FROM generate_series(1, 101) AS fixture(n)`,
      [expiredSpaceId],
    );
    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO handoffs (space_id, code, latest_revision, expires_at)
         VALUES ($1, 'LIVE20', 1, now() + interval '1 hour')`,
        [liveSpaceId],
      );
      await client.query(
        `INSERT INTO revisions
           (space_id, handoff_code, revision, markdown, created_at, redaction_count, origin)
         VALUES ($1, 'LIVE20', 1, 'live cleanup secret', now(), 0, 'mcp')`,
        [liveSpaceId],
      );
    });

    let stdout = "";
    let stderr = "";
    try {
      const status = await runAdminCommand({
        args: ["cleanup-expired"],
        databaseUrl: DATABASE_URL!,
        readSpaceKey: async () => {
          throw new Error("Space Key input was not requested");
        },
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });

      expect(status).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("Deleted expired Handoffs: 100");
      expect(stdout).toContain("Expired Handoffs may remain; run cleanup-expired again");

      const remaining = await pool.query<{ expired: number; live: number; revisions: number }>(
        `SELECT
           (SELECT count(*)::int FROM handoffs WHERE space_id = $1) AS expired,
           (SELECT count(*)::int FROM handoffs WHERE space_id = $2) AS live,
           (SELECT count(*)::int FROM revisions WHERE space_id = $1) AS revisions`,
        [expiredSpaceId, liveSpaceId],
      );
      expect(remaining.rows[0]).toEqual({ expired: 1, live: 1, revisions: 1 });
    } finally {
      await pool.query("DELETE FROM handoffs WHERE space_id = $1 OR space_id = $2", [
        expiredSpaceId,
        liveSpaceId,
      ]);
    }
  });

  it("returns bounded messages for database failures", async () => {
    for (const args of [
      ["inspect", "--space-id", "0".repeat(64)],
      ["cleanup-expired"],
      ["stats"],
    ]) {
      let stdout = "";
      let stderr = "";
      const status = await runAdminCommand({
        args,
        databaseUrl: "postgres://127.0.0.1:1/unavailable?connect_timeout=1",
        readSpaceKey: async () => {
          throw new Error("Space Key input was not requested");
        },
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });

      expect(status).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toBe("admin command failed\n");
      expect(stderr).not.toContain("127.0.0.1");
      expect(stderr).not.toContain("ECONNREFUSED");
    }
  });

  it("reports global database statistics with PostgreSQL time and bounded UTF-8 totals", async () => {
    const spaceA = randomBytes(32);
    const spaceB = randomBytes(32);
    const markdown = {
      liveA1: "机密界",
      liveA2: "alpha-secret-content",
      liveB1: "beta-secret",
      expiredA: "[REDACTED fixture secret]",
      liveGamma: "gamma",
    };

    const runStats = async () => {
      let stdout = "";
      let stderr = "";
      const status = await runAdminCommand({
        args: ["stats"],
        databaseUrl: DATABASE_URL!,
        readSpaceKey: async () => {
          throw new Error("Space Key input was not requested");
        },
        writeStdout: (text) => {
          stdout += text;
        },
        writeStderr: (text) => {
          stderr += text;
        },
      });
      return { status, stdout, stderr };
    };

    const parseStatsOutput = (text: string) => {
      const dbTimeMatch = text.match(/Database time: (\d{4}-\d{2}-\d{2}T[^\n]+)/);
      const spacesMatch = text.match(/Spaces with stored Handoffs: (\d+)/);
      const handoffsMatch = text.match(/Handoffs: live=(\d+) expired=(\d+) total=(\d+)/);
      const revisionsMatch = text.match(/Revisions: total=(\d+)/);
      const markdownMatch = text.match(/Markdown bytes: live=(\d+) total=(\d+)/);

      expect(dbTimeMatch).not.toBeNull();
      expect(spacesMatch).not.toBeNull();
      expect(handoffsMatch).not.toBeNull();
      expect(revisionsMatch).not.toBeNull();
      expect(markdownMatch).not.toBeNull();

      return {
        databaseTime: new Date(dbTimeMatch![1]!),
        spacesWithStoredHandoffs: Number(spacesMatch![1]),
        liveHandoffs: Number(handoffsMatch![1]),
        expiredHandoffs: Number(handoffsMatch![2]),
        totalHandoffs: Number(handoffsMatch![3]),
        totalRevisions: Number(revisionsMatch![1]),
        liveMarkdownBytes: Number(markdownMatch![1]),
        totalMarkdownBytes: Number(markdownMatch![2]),
      };
    };

    const beforeStats = await runStats();
    expect(beforeStats.status).toBe(0);
    expect(beforeStats.stderr).toBe("");
    const baseline = parseStatsOutput(beforeStats.stdout);

    const clockBefore = (await pool.query<{ now: Date }>("SELECT now()")).rows[0]!.now;

    await withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO handoffs (space_id, code, latest_revision, expires_at)
         VALUES ($1, 'LIVEA1', 2, now() + interval '1 hour'),
                ($1, 'LIVEB1', 1, now() + interval '2 hours'),
                ($1, 'DEAD01', 1, now() - interval '1 hour'),
                ($2, 'LIVEG1', 1, now() + interval '1 hour')`,
        [spaceA, spaceB],
      );
      await client.query(
        `INSERT INTO revisions
           (space_id, handoff_code, revision, markdown, created_at, redaction_count, origin)
         VALUES ($1, 'LIVEA1', 1, $3, now() - interval '3 hours', 0, 'mcp'),
                ($1, 'LIVEA1', 2, $4, now() - interval '2 hours', 0, 'mcp'),
                ($1, 'LIVEB1', 1, $5, now() - interval '1 hour', 0, 'mcp'),
                ($1, 'DEAD01', 1, $6, now() - interval '4 hours', 1, 'mcp'),
                ($2, 'LIVEG1', 1, $7, now() - interval '30 minutes', 0, 'mcp')`,
        [
          spaceA,
          spaceB,
          markdown.liveA1,
          markdown.liveA2,
          markdown.liveB1,
          markdown.expiredA,
          markdown.liveGamma,
        ],
      );
    });

    try {
      const statsResult = await runStats();
      const clockAfter = (await pool.query<{ now: Date }>("SELECT now()")).rows[0]!.now;

      expect(statsResult.status).toBe(0);
      expect(statsResult.stderr).toBe("");

      const after = parseStatsOutput(statsResult.stdout);
      expect(after.databaseTime.getTime()).toBeGreaterThanOrEqual(clockBefore.getTime());
      expect(after.databaseTime.getTime()).toBeLessThanOrEqual(clockAfter.getTime());

      expect(after.spacesWithStoredHandoffs - baseline.spacesWithStoredHandoffs).toBe(2);
      expect(after.liveHandoffs - baseline.liveHandoffs).toBe(3);
      expect(after.expiredHandoffs - baseline.expiredHandoffs).toBe(1);
      expect(after.totalHandoffs - baseline.totalHandoffs).toBe(4);
      expect(after.totalRevisions - baseline.totalRevisions).toBe(5);
      expect(after.liveMarkdownBytes - baseline.liveMarkdownBytes).toBe(45);
      expect(after.totalMarkdownBytes - baseline.totalMarkdownBytes).toBe(70);

      const completeOutput = `${statsResult.stdout}\n${statsResult.stderr}`;
      expect(completeOutput).not.toContain(toHex(spaceA));
      expect(completeOutput).not.toContain(toHex(spaceB));
      expect(completeOutput).not.toContain(DATABASE_URL!);
      expect(completeOutput).not.toContain("LIVEA1");
      expect(completeOutput).not.toContain("LIVEB1");
      expect(completeOutput).not.toContain("DEAD01");
      expect(completeOutput).not.toContain("LIVEG1");
      for (const content of Object.values(markdown)) {
        expect(completeOutput).not.toContain(content);
      }

      const rowsCount = await pool.query<{ count: number }>(
        "SELECT count(*)::int FROM handoffs WHERE space_id = $1 OR space_id = $2",
        [spaceA, spaceB],
      );
      expect(rowsCount.rows[0]!.count).toBe(4);
    } finally {
      await pool.query("DELETE FROM handoffs WHERE space_id = $1 OR space_id = $2", [
        spaceA,
        spaceB,
      ]);
    }
  });
});
