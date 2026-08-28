import { randomBytes } from "node:crypto";

import type { Pool, PoolClient } from "./db.js";
import { withTransaction } from "./db.js";
import { MAX_REVISIONS_PER_HANDOFF } from "./handoff-limits.js";
import type { RevisionOrigin } from "./revision-origin.js";

// Crockford Base32 excludes I, L, O, U so generated codes survive input normalization.
// O -> 0, I -> 1, L -> 1 defined by the Tool Contract.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 6;
const CODE_COLLISION_RETRIES = 5;

export const EXPIRED_HANDOFF_CLEANUP_BATCH_SIZE = 100;

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
  origin: RevisionOrigin;
  createdAt: string;
  expiresAt: string;
}

export interface RevisionHistoryItem {
  revision: number;
  origin: RevisionOrigin;
  createdAt: string;
}

export interface RevisionHistorySnapshot {
  ok: true;
  code: string;
  latestRevision: number;
  expiresAt: string;
  revisions: RevisionHistoryItem[];
}

export type HandoffStoreError =
  | { ok: false; error: { code: "HANDOFF_NOT_FOUND"; handoffCode: string } }
  | {
      ok: false;
      error: { code: "REVISION_CONFLICT"; expectedRevision: number; receivedBaseRevision: number };
    }
  | {
      ok: false;
      error: { code: "REVISION_LIMIT_REACHED"; limit: typeof MAX_REVISIONS_PER_HANDOFF };
    }
  | { ok: false; error: { code: "SPACE_QUOTA_EXCEEDED"; quota: "handoffs" | "retainedMarkdown" } };

export type HandoffStoreResult = RevisionSnapshot | HandoffStoreError;
export type SpaceQuotaExceeded = Extract<
  HandoffStoreError,
  { error: { code: "SPACE_QUOTA_EXCEEDED" } }
>;
export type HandoffNotFound = Extract<HandoffStoreError, { error: { code: "HANDOFF_NOT_FOUND" } }>;
export type CreateHandoffStoreResult = RevisionSnapshot | SpaceQuotaExceeded;
export type GetHandoffStoreResult = RevisionSnapshot | HandoffNotFound;
export type GetRevisionHistoryStoreResult = RevisionHistorySnapshot | HandoffNotFound;

export interface HandoffStore {
  cleanupExpiredHandoffs(): Promise<number>;
  createHandoff(input: {
    spaceId: Uint8Array;
    markdown: string;
    redactionCount: number;
    origin: RevisionOrigin;
  }): Promise<CreateHandoffStoreResult>;
  getHandoff(input: {
    spaceId: Uint8Array;
    code: string;
    revision: number | "latest";
  }): Promise<GetHandoffStoreResult>;
  getRevisionHistory(input: {
    spaceId: Uint8Array;
    code: string;
  }): Promise<GetRevisionHistoryStoreResult>;
  appendRevision(input: {
    spaceId: Uint8Array;
    code: string;
    baseRevision: number;
    markdown: string;
    redactionCount: number;
    origin: RevisionOrigin;
  }): Promise<HandoffStoreResult>;
}

interface RevisionRow {
  revision: number;
  markdown: string;
  redaction_count: number;
  origin: RevisionOrigin;
  created_at: Date;
}

interface HandoffRow {
  code: string;
  latest_revision: number;
  expires_at: Date;
}

type RevisionSnapshotRow = HandoffRow & RevisionRow;

interface RevisionHistoryRow extends HandoffRow {
  revision: number;
  origin: RevisionOrigin;
  created_at: Date;
}

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i]! & 31]!;
  }
  return out;
}

function toSnapshot(handoff: HandoffRow, revision: RevisionRow): RevisionSnapshot {
  return {
    ok: true,
    code: handoff.code,
    revision: revision.revision,
    latestRevision: handoff.latest_revision,
    isLatest: revision.revision === handoff.latest_revision,
    markdown: revision.markdown,
    contentSanitized: revision.redaction_count > 0,
    redactionCount: revision.redaction_count,
    origin: revision.origin,
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
    async cleanupExpiredHandoffs(): Promise<number> {
      const result = await pool.query<{ deleted_handoffs: number }>(
        `WITH expired_batch AS (
           SELECT space_id, code
           FROM handoffs
           WHERE expires_at <= now()
           ORDER BY expires_at, space_id, code
           FOR UPDATE SKIP LOCKED
           LIMIT ${EXPIRED_HANDOFF_CLEANUP_BATCH_SIZE}
         ),
         deleted AS (
           DELETE FROM handoffs AS handoff
           USING expired_batch
           WHERE handoff.space_id = expired_batch.space_id
             AND handoff.code = expired_batch.code
           RETURNING handoff.space_id, handoff.code
         )
         SELECT count(*)::int AS deleted_handoffs FROM deleted`,
      );
      return result.rows[0]!.deleted_handoffs;
    },

    async createHandoff({
      spaceId,
      markdown,
      redactionCount,
      origin,
    }): Promise<CreateHandoffStoreResult> {
      let lastError: unknown;
      for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt++) {
        const code = generateCode();
        try {
          return await withTransaction(pool, async (client) => {
            const quotaError = await checkSpaceQuota(client, spaceId, quota, true);
            if (quotaError) return quotaError;

            const now = await client.query<{ created_at: Date }>("SELECT now() AS created_at");
            const createdAt = now.rows[0]!.created_at;
            const expiresAt = new Date(createdAt.getTime() + retentionWindowMs);

            await client.query(
              `INSERT INTO handoffs (space_id, code, latest_revision, expires_at)
               VALUES ($1, $2, 1, $3)`,
              [spaceId, code, expiresAt],
            );
            await client.query(
              `INSERT INTO revisions
                 (space_id, handoff_code, revision, markdown, created_at, redaction_count, origin)
               VALUES ($1, $2, 1, $3, $4, $5, $6)`,
              [spaceId, code, markdown, createdAt, redactionCount, origin],
            );

            return toSnapshot(
              { code, latest_revision: 1, expires_at: expiresAt },
              {
                revision: 1,
                markdown,
                redaction_count: redactionCount,
                origin,
                created_at: createdAt,
              },
            );
          });
        } catch (err) {
          lastError = err;
          const isUniqueViolation =
            err instanceof Error && "code" in err && (err as { code?: string }).code === "23505";
          if (!isUniqueViolation) throw err;
        }
      }
      throw lastError;
    },

    async getHandoff({ spaceId, code, revision }): Promise<GetHandoffStoreResult> {
      const targetRevision = revision === "latest" ? null : revision;
      const result = await pool.query<RevisionSnapshotRow>(
        `SELECT h.code, h.latest_revision, h.expires_at,
                r.revision, r.markdown, r.redaction_count, r.origin, r.created_at
         FROM handoffs h
         JOIN revisions r
           ON r.space_id = h.space_id
          AND r.handoff_code = h.code
          AND r.revision = COALESCE($3::numeric, h.latest_revision)
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

    async getRevisionHistory({ spaceId, code }): Promise<GetRevisionHistoryStoreResult> {
      const result = await pool.query<RevisionHistoryRow>(
        `SELECT h.code, h.latest_revision, h.expires_at,
                r.revision, r.origin, r.created_at
         FROM handoffs h
         JOIN revisions r
           ON r.space_id = h.space_id
          AND r.handoff_code = h.code
         WHERE h.space_id = $1 AND h.code = $2 AND h.expires_at > now()
         ORDER BY r.revision DESC`,
        [spaceId, code],
      );
      const firstRow = result.rows[0];
      if (!firstRow) {
        return {
          ok: false,
          error: { code: "HANDOFF_NOT_FOUND", handoffCode: code },
        };
      }
      return {
        ok: true,
        code: firstRow.code,
        latestRevision: firstRow.latest_revision,
        expiresAt: firstRow.expires_at.toISOString(),
        revisions: result.rows.map((row) => ({
          revision: row.revision,
          origin: row.origin,
          createdAt: row.created_at.toISOString(),
        })),
      };
    },

    async appendRevision({
      spaceId,
      code,
      baseRevision,
      markdown,
      redactionCount,
      origin,
    }): Promise<HandoffStoreResult> {
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

        if (handoff.latest_revision >= MAX_REVISIONS_PER_HANDOFF) {
          return {
            ok: false,
            error: {
              code: "REVISION_LIMIT_REACHED",
              limit: MAX_REVISIONS_PER_HANDOFF,
            },
          };
        }

        const quotaError = await checkSpaceQuota(client, spaceId, quota, false);
        if (quotaError) return quotaError;

        const now = await client.query<{ created_at: Date }>("SELECT now() AS created_at");
        const createdAt = now.rows[0]!.created_at;
        const expiresAt = new Date(createdAt.getTime() + retentionWindowMs);
        const nextRevision = handoff.latest_revision + 1;

        await client.query(
          `INSERT INTO revisions
             (space_id, handoff_code, revision, markdown, created_at, redaction_count, origin)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [spaceId, code, nextRevision, markdown, createdAt, redactionCount, origin],
        );
        await client.query(
          `UPDATE handoffs SET latest_revision = $3, expires_at = $4
           WHERE space_id = $1 AND code = $2`,
          [spaceId, code, nextRevision, expiresAt],
        );

        return toSnapshot(
          { code: handoff.code, latest_revision: nextRevision, expires_at: expiresAt },
          {
            revision: nextRevision,
            markdown,
            redaction_count: redactionCount,
            origin,
            created_at: createdAt,
          },
        );
      });
    },
  };
}
