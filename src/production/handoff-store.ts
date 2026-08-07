import { randomBytes } from "node:crypto";

import type { Pool, PoolClient } from "./db.js";
import { withTransaction } from "./db.js";

// Crockford Base32 excludes I, L, O, U so generated codes survive input normalization.
// O -> 0, I -> 1, L -> 1 defined by the Tool Contract.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;
const CODE_COLLISION_RETRIES = 5;

export interface SpaceQuotaLimits {
  maxLiveHandoffs: number;
  maxRetainedMarkdownBytes: number;
}

const DEFAULT_SPACE_QUOTA: SpaceQuotaLimits = {
  maxLiveHandoffs: 32,
  maxRetainedMarkdownBytes: 64 * 1024 * 1024,
};

export interface RevisionSnapshot {
  ok: true;
  code: string;
  revision: number;
  latestRevision: number;
  isLatest: boolean;
  markdown: string;
  contentSanitized: boolean;
  redactionCount: number;
  createdAt: string;
  expiresAt: string;
}

export type HandoffStoreError =
  | { ok: false; error: { code: "HANDOFF_NOT_FOUND"; handoffCode: string } }
  | {
      ok: false;
      error: { code: "REVISION_CONFLICT"; expectedRevision: number; receivedBaseRevision: number };
    }
  | { ok: false; error: { code: "SPACE_QUOTA_EXCEEDED"; quota: "handoffs" | "retainedMarkdown" } };

export type HandoffStoreResult = RevisionSnapshot | HandoffStoreError;
export type SpaceQuotaExceeded = Extract<
  HandoffStoreError,
  { error: { code: "SPACE_QUOTA_EXCEEDED" } }
>;
export type CreateHandoffStoreResult = RevisionSnapshot | SpaceQuotaExceeded;

export interface HandoffStore {
  createHandoff(input: {
    spaceId: Uint8Array;
    markdown: string;
    redactionCount: number;
  }): Promise<CreateHandoffStoreResult>;
  getHandoff(input: {
    spaceId: Uint8Array;
    code: string;
    revision: number | "latest";
  }): Promise<HandoffStoreResult>;
  appendRevision(input: {
    spaceId: Uint8Array;
    code: string;
    baseRevision: number;
    markdown: string;
    redactionCount: number;
  }): Promise<HandoffStoreResult>;
}

interface RevisionRow {
  revision: number;
  markdown: string;
  redaction_count: number;
  created_at: Date;
}

interface HandoffRow {
  code: string;
  latest_revision: number;
  expires_at: Date;
}

type RevisionSnapshotRow = HandoffRow & RevisionRow;

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i]! & 31]!;
  }
  return out;
}

function toSnapshot(
  handoff: HandoffRow,
  revision: RevisionRow,
): RevisionSnapshot {
  return {
    ok: true,
    code: handoff.code,
    revision: revision.revision,
    latestRevision: handoff.latest_revision,
    isLatest: revision.revision === handoff.latest_revision,
    markdown: revision.markdown,
    contentSanitized: revision.redaction_count > 0,
    redactionCount: revision.redaction_count,
    createdAt: revision.created_at.toISOString(),
    expiresAt: handoff.expires_at.toISOString(),
  };
}

// Best-effort Space quota check. Rejects when the current observed state has
// already reached the limit. Concurrent writes to different Handoffs may both
// observe the same pre-write total and temporarily overshoot; this race is
// accepted for the Beta rather than adding a coordination row.
async function checkSpaceQuota(
  client: PoolClient,
  spaceId: Uint8Array,
  limits: SpaceQuotaLimits,
  checkHandoffCount: boolean,
): Promise<SpaceQuotaExceeded | null> {
  if (checkHandoffCount) {
    const handoffCount = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM handoffs WHERE space_id = $1 AND expires_at > now()",
      [spaceId],
    );
    if (handoffCount.rows[0]!.n >= limits.maxLiveHandoffs) {
      return { ok: false, error: { code: "SPACE_QUOTA_EXCEEDED", quota: "handoffs" } };
    }
  }

  const markdownTotal = await client.query<{ total: number }>(
    `SELECT COALESCE(sum(octet_length(r.markdown)), 0)::bigint AS total
     FROM revisions r
     JOIN handoffs h
       ON h.space_id = r.space_id AND h.code = r.handoff_code
     WHERE r.space_id = $1 AND h.expires_at > now()`,
    [spaceId],
  );
  if (Number(markdownTotal.rows[0]!.total) >= limits.maxRetainedMarkdownBytes) {
    return { ok: false, error: { code: "SPACE_QUOTA_EXCEEDED", quota: "retainedMarkdown" } };
  }

  return null;
}

export function createHandoffStore(
  pool: Pool,
  retentionWindowMs: number,
  quota: SpaceQuotaLimits = DEFAULT_SPACE_QUOTA,
): HandoffStore {
  return {
    async createHandoff({ spaceId, markdown, redactionCount }): Promise<CreateHandoffStoreResult> {
      let lastError: unknown;
      for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt++) {
        const code = generateCode();
        try {
          return await withTransaction(pool, async (client) => {
            const quotaError = await checkSpaceQuota(client, spaceId, quota, true);
            if (quotaError) return quotaError;

            const now = await client.query<{ created_at: Date }>(
              "SELECT now() AS created_at",
            );
            const createdAt = now.rows[0]!.created_at;
            const expiresAt = new Date(createdAt.getTime() + retentionWindowMs);

            await client.query(
              `INSERT INTO handoffs (space_id, code, latest_revision, expires_at)
               VALUES ($1, $2, 1, $3)`,
              [spaceId, code, expiresAt],
            );
            await client.query(
              `INSERT INTO revisions (space_id, handoff_code, revision, markdown, created_at, redaction_count)
               VALUES ($1, $2, 1, $3, $4, $5)`,
              [spaceId, code, markdown, createdAt, redactionCount],
            );

            return toSnapshot(
              { code, latest_revision: 1, expires_at: expiresAt },
              { revision: 1, markdown, redaction_count: redactionCount, created_at: createdAt },
            );
          });
        } catch (err) {
          lastError = err;
          const isUniqueViolation =
            err instanceof Error &&
            "code" in err &&
            (err as { code?: string }).code === "23505";
          if (!isUniqueViolation) throw err;
        }
      }
      throw lastError;
    },

    async getHandoff({ spaceId, code, revision }): Promise<HandoffStoreResult> {
      const targetRevision = revision === "latest" ? null : revision;
      const result = await pool.query<RevisionSnapshotRow>(
        `SELECT h.code, h.latest_revision, h.expires_at,
                r.revision, r.markdown, r.redaction_count, r.created_at
         FROM handoffs h
         JOIN revisions r
           ON r.space_id = h.space_id
          AND r.handoff_code = h.code
          AND r.revision = COALESCE($3::smallint, h.latest_revision)
         WHERE h.space_id = $1 AND h.code = $2 AND h.expires_at > now()`,
        [spaceId, code, targetRevision],
      );
      const row = result.rows[0];
      if (!row) {
        return {
          ok: false,
          error: { code: "HANDOFF_NOT_FOUND", handoffCode: code },
        };
      }
      return toSnapshot(row, row);
    },

    async appendRevision({ spaceId, code, baseRevision, markdown, redactionCount }): Promise<HandoffStoreResult> {
      return withTransaction(pool, async (client) => {
        const handoffResult = await client.query<HandoffRow>(
          `SELECT code, latest_revision, expires_at
           FROM handoffs
           WHERE space_id = $1 AND code = $2 AND expires_at > now()
           FOR UPDATE`,
          [spaceId, code],
        );
        const handoff = handoffResult.rows[0];
        if (!handoff) {
          return {
            ok: false,
            error: { code: "HANDOFF_NOT_FOUND", handoffCode: code },
          };
        }

        if (baseRevision !== handoff.latest_revision) {
          return {
            ok: false,
            error: {
              code: "REVISION_CONFLICT",
              expectedRevision: handoff.latest_revision,
              receivedBaseRevision: baseRevision,
            },
          };
        }

        const quotaError = await checkSpaceQuota(client, spaceId, quota, false);
        if (quotaError) return quotaError;

        const now = await client.query<{ created_at: Date }>(
          "SELECT now() AS created_at",
        );
        const createdAt = now.rows[0]!.created_at;
        const expiresAt = new Date(createdAt.getTime() + retentionWindowMs);
        const nextRevision = handoff.latest_revision + 1;

        await client.query(
          `INSERT INTO revisions (space_id, handoff_code, revision, markdown, created_at, redaction_count)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [spaceId, code, nextRevision, markdown, createdAt, redactionCount],
        );
        await client.query(
          `UPDATE handoffs SET latest_revision = $3, expires_at = $4
           WHERE space_id = $1 AND code = $2`,
          [spaceId, code, nextRevision, expiresAt],
        );

        return toSnapshot(
          { code: handoff.code, latest_revision: nextRevision, expires_at: expiresAt },
          { revision: nextRevision, markdown, redaction_count: redactionCount, created_at: createdAt },
        );
      });
    },
  };
}
