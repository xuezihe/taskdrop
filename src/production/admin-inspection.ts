import type { Pool } from "./db.js";
import { deriveSpaceFingerprint } from "./space-identity.js";

interface SpaceInspectionRow {
  db_now: Date;
  code: string | null;
  latest_revision: number | null;
  expires_at: Date | null;
  is_live: boolean | null;
  revision_count: number | null;
  revision_one_created_at: Date | null;
  markdown_bytes: string | null;
}

export interface InspectedHandoff {
  code: string;
  state: "live" | "expired";
  latestRevision: number;
  revisionCount: number;
  revisionOneCreatedAt: string;
  expiresAt: string;
  markdownBytes: number;
}

export interface SpaceInspection {
  databaseTime: string;
  liveHandoffCount: number;
  expiredHandoffCount: number;
  totalHandoffCount: number;
  totalRevisionCount: number;
  liveMarkdownBytes: number;
  totalMarkdownBytes: number;
  handoffs: InspectedHandoff[];
}

export interface DatabaseStats {
  databaseTime: string;
  spacesWithStoredHandoffs: number;
  liveHandoffCount: number;
  expiredHandoffCount: number;
  totalHandoffCount: number;
  totalRevisionCount: number;
  liveMarkdownBytes: number;
  totalMarkdownBytes: number;
}

interface DatabaseStatsRow {
  db_now: Date;
  spaces_with_stored_handoffs: number;
  live_handoff_count: number;
  expired_handoff_count: number;
  total_handoff_count: number;
  total_revision_count: number;
  live_markdown_bytes: string;
  total_markdown_bytes: string;
}

export async function loadDatabaseStats(pool: Pool): Promise<DatabaseStats> {
  const result = await pool.query<DatabaseStatsRow>(
    `WITH clock AS (
       SELECT now() AS db_now
     )
     SELECT
       clock.db_now,
       (SELECT count(DISTINCT space_id)::int FROM handoffs) AS spaces_with_stored_handoffs,
       (SELECT count(*)::int FROM handoffs WHERE expires_at > clock.db_now) AS live_handoff_count,
       (SELECT count(*)::int FROM handoffs WHERE expires_at <= clock.db_now) AS expired_handoff_count,
       (SELECT count(*)::int FROM handoffs) AS total_handoff_count,
       (SELECT count(*)::int FROM revisions) AS total_revision_count,
       (SELECT COALESCE(sum(octet_length(r.markdown)), 0)::bigint
        FROM revisions r
        JOIN handoffs h
          ON h.space_id = r.space_id AND h.code = r.handoff_code
        WHERE h.expires_at > clock.db_now) AS live_markdown_bytes,
       (SELECT COALESCE(sum(octet_length(markdown)), 0)::bigint FROM revisions) AS total_markdown_bytes
     FROM clock`,
  );
  const row = result.rows[0]!;
  return {
    databaseTime: row.db_now.toISOString(),
    spacesWithStoredHandoffs: row.spaces_with_stored_handoffs,
    liveHandoffCount: row.live_handoff_count,
    expiredHandoffCount: row.expired_handoff_count,
    totalHandoffCount: row.total_handoff_count,
    totalRevisionCount: row.total_revision_count,
    liveMarkdownBytes: Number(row.live_markdown_bytes),
    totalMarkdownBytes: Number(row.total_markdown_bytes),
  };
}

export type StoredFingerprintResolution =
  | { kind: "none" }
  | { kind: "unique"; spaceId: Uint8Array }
  | { kind: "ambiguous"; matchCount: number };

export async function resolveStoredSpaceFingerprint(
  pool: Pool,
  fingerprint: string,
): Promise<StoredFingerprintResolution> {
  const candidates = await pool.query<{ space_id: Uint8Array }>(
    "SELECT DISTINCT space_id FROM handoffs",
  );
  const matches: Uint8Array[] = [];
  for (const candidate of candidates.rows) {
    if ((await deriveSpaceFingerprint(candidate.space_id)) === fingerprint) {
      matches.push(candidate.space_id);
    }
  }
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) return { kind: "ambiguous", matchCount: matches.length };
  return { kind: "unique", spaceId: matches[0]! };
}

export async function inspectSpace(pool: Pool, spaceId: Uint8Array): Promise<SpaceInspection> {
  const result = await pool.query<SpaceInspectionRow>(
    `WITH inspection_clock AS (
       SELECT now() AS db_now
     ),
     handoff_summaries AS (
       SELECT h.code, h.latest_revision, h.expires_at,
              count(r.revision)::int AS revision_count,
              min(r.created_at) FILTER (WHERE r.revision = 1) AS revision_one_created_at,
              COALESCE(sum(octet_length(r.markdown)), 0)::bigint AS markdown_bytes
       FROM handoffs h
       LEFT JOIN revisions r
         ON r.space_id = h.space_id AND r.handoff_code = h.code
       WHERE h.space_id = $1
       GROUP BY h.code, h.latest_revision, h.expires_at
     )
     SELECT clock.db_now, summary.code, summary.latest_revision, summary.expires_at,
            summary.expires_at > clock.db_now AS is_live,
            summary.revision_count, summary.revision_one_created_at, summary.markdown_bytes
     FROM inspection_clock clock
     LEFT JOIN handoff_summaries summary ON true
     ORDER BY (summary.expires_at > clock.db_now) DESC,
              summary.expires_at,
              summary.code`,
    [spaceId],
  );
  const databaseTime = result.rows[0]!.db_now;
  const handoffs = result.rows.flatMap<InspectedHandoff>((row) => {
    if (
      row.code === null ||
      row.latest_revision === null ||
      row.expires_at === null ||
      row.is_live === null ||
      row.revision_count === null ||
      row.revision_one_created_at === null ||
      row.markdown_bytes === null
    ) {
      return [];
    }
    return [
      {
        code: row.code,
        state: row.is_live ? "live" : "expired",
        latestRevision: row.latest_revision,
        revisionCount: row.revision_count,
        revisionOneCreatedAt: row.revision_one_created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        markdownBytes: Number(row.markdown_bytes),
      },
    ];
  });

  const live = handoffs.filter((handoff) => handoff.state === "live");
  return {
    databaseTime: databaseTime.toISOString(),
    liveHandoffCount: live.length,
    expiredHandoffCount: handoffs.length - live.length,
    totalHandoffCount: handoffs.length,
    totalRevisionCount: handoffs.reduce((total, handoff) => total + handoff.revisionCount, 0),
    liveMarkdownBytes: live.reduce((total, handoff) => total + handoff.markdownBytes, 0),
    totalMarkdownBytes: handoffs.reduce((total, handoff) => total + handoff.markdownBytes, 0),
    handoffs,
  };
}
