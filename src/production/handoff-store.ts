import { randomBytes } from "node:crypto";

import type { Pool, PoolClient } from "./db.js";
import { withTransaction } from "./db.js";

// Excludes I, L, O so generated codes survive the input normalization
// O -> 0, I -> 1, L -> 1 defined by the Tool Contract.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ0123456789";
const CODE_LENGTH = 6;
const CODE_COLLISION_RETRIES = 5;

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
    };

export type HandoffStoreResult = RevisionSnapshot | HandoffStoreError;

export interface HandoffStore {
  createHandoff(input: {
    spaceId: Uint8Array;
    markdown: string;
    redactionCount: number;
  }): Promise<RevisionSnapshot>;
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

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]!;
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

async function readRevision(
  client: PoolClient,
  spaceId: Uint8Array,
  code: string,
  revision: number,
): Promise<RevisionRow | null> {
  const result = await client.query<RevisionRow>(
    `SELECT revision, markdown, redaction_count, created_at
     FROM revisions
     WHERE space_id = $1 AND handoff_code = $2 AND revision = $3`,
    [spaceId, code, revision],
  );
  return result.rows[0] ?? null;
}

async function readHandoff(
  client: PoolClient,
  spaceId: Uint8Array,
  code: string,
): Promise<HandoffRow | null> {
  const result = await client.query<HandoffRow>(
    `SELECT code, latest_revision, expires_at
     FROM handoffs
     WHERE space_id = $1 AND code = $2 AND expires_at > now()`,
    [spaceId, code],
  );
  return result.rows[0] ?? null;
}

export function createHandoffStore(pool: Pool, retentionWindowMs: number): HandoffStore {
  return {
    async createHandoff({ spaceId, markdown, redactionCount }): Promise<RevisionSnapshot> {
      let lastError: unknown;
      for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt++) {
        const code = generateCode();
        try {
          return await withTransaction(pool, async (client) => {
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
      const client = await pool.connect();
      try {
        const handoff = await readHandoff(client, spaceId, code);
        if (!handoff) {
          return {
            ok: false,
            error: { code: "HANDOFF_NOT_FOUND", handoffCode: code },
          };
        }

        const targetRevision =
          revision === "latest" ? handoff.latest_revision : revision;

        const revisionRow = await readRevision(client, spaceId, code, targetRevision);
        if (!revisionRow) {
          return {
            ok: false,
            error: { code: "HANDOFF_NOT_FOUND", handoffCode: code },
          };
        }
        return toSnapshot(handoff, revisionRow);
      } finally {
        client.release();
      }
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
