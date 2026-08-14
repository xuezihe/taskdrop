import { fileURLToPath } from "node:url";

import {
  inspectSpace,
  loadDatabaseStats,
  resolveStoredSpaceFingerprint,
  type DatabaseStats,
  type SpaceInspection,
} from "./admin-inspection.js";
import { defaultRetentionWindowMs } from "./config.js";
import { createPool } from "./db.js";
import {
  createHandoffStore,
  EXPIRED_HANDOFF_CLEANUP_BATCH_SIZE,
} from "./handoff-store.js";
import {
  deriveSpaceFingerprint,
  deriveSpaceId,
  parseSpaceId,
  parseSpaceKey,
} from "./space-identity.js";

const USAGE = `Usage:
  taskdrop admin inspect --space-key
  taskdrop admin inspect --space-id <64-char-lowercase-hex>
  taskdrop admin inspect --space-fingerprint <12-char-fingerprint>
  taskdrop admin cleanup-expired
  taskdrop admin stats
`;

export interface AdminCommandInput {
  args: readonly string[];
  databaseUrl: string | undefined;
  readSpaceKey(): Promise<string>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

type ParsedCommand =
  | { kind: "cleanup-expired" }
  | { kind: "stats" }
  | { kind: "inspect-space-key" }
  | { kind: "inspect-space-id"; spaceId: Uint8Array }
  | { kind: "inspect-fingerprint"; fingerprint: string };

function parseCommand(args: readonly string[]): ParsedCommand | null {
  if (args.length === 1 && args[0] === "cleanup-expired") {
    return { kind: "cleanup-expired" };
  }
  if (args.length === 1 && args[0] === "stats") {
    return { kind: "stats" };
  }
  if (args.length === 2 && args[0] === "inspect" && args[1] === "--space-key") {
    return { kind: "inspect-space-key" };
  }
  if (args.length === 3 && args[0] === "inspect" && args[1] === "--space-id") {
    try {
      return { kind: "inspect-space-id", spaceId: parseSpaceId(args[2]!) };
    } catch {
      return null;
    }
  }
  if (
    args.length === 3 &&
    args[0] === "inspect" &&
    args[1] === "--space-fingerprint" &&
    /^[A-Za-z0-9_-]{12}$/.test(args[2]!)
  ) {
    return { kind: "inspect-fingerprint", fingerprint: args[2]! };
  }
  return null;
}

interface AggregateSummary {
  liveHandoffCount: number;
  expiredHandoffCount: number;
  totalHandoffCount: number;
  totalRevisionCount: number;
  liveMarkdownBytes: number;
  totalMarkdownBytes: number;
}

function formatAggregateLines(summary: AggregateSummary): string[] {
  return [
    `Handoffs: live=${summary.liveHandoffCount} expired=${summary.expiredHandoffCount} total=${summary.totalHandoffCount}`,
    `Revisions: total=${summary.totalRevisionCount}`,
    `Markdown bytes: live=${summary.liveMarkdownBytes} total=${summary.totalMarkdownBytes}`,
  ];
}

function formatInspection(fingerprint: string, inspection: SpaceInspection): string {
  const lines = [
    `Space Fingerprint: ${fingerprint}`,
    `Database time: ${inspection.databaseTime}`,
    ...formatAggregateLines(inspection),
  ];
  if (inspection.handoffs.length === 0) {
    lines.push("No stored Handoffs.");
  } else {
    lines.push("", "Stored Handoffs:");
    for (const handoff of inspection.handoffs) {
      lines.push(
        `${handoff.code} | ${handoff.state} | latest=${handoff.latestRevision} | revisions=${handoff.revisionCount} | revision1CreatedAt=${handoff.revisionOneCreatedAt} | expiresAt=${handoff.expiresAt} | markdownBytes=${handoff.markdownBytes}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatStats(stats: DatabaseStats): string {
  return [
    `Database time: ${stats.databaseTime}`,
    `Spaces with stored Handoffs: ${stats.spacesWithStoredHandoffs}`,
    ...formatAggregateLines(stats),
  ].join("\n") + "\n";
}

export async function runAdminCommand(input: AdminCommandInput): Promise<number> {
  const command = parseCommand(input.args);
  if (!command) {
    input.writeStderr(USAGE);
    return 2;
  }

  let exactSpaceId: Uint8Array | undefined;
  if (command.kind === "inspect-space-id") {
    exactSpaceId = command.spaceId;
  } else if (command.kind === "inspect-space-key") {
    try {
      const keyBytes = parseSpaceKey(await input.readSpaceKey());
      try {
        exactSpaceId = await deriveSpaceId(keyBytes);
      } finally {
        keyBytes.fill(0);
      }
    } catch {
      input.writeStderr(`invalid Space Key\n${USAGE}`);
      return 2;
    }
  }

  if (!input.databaseUrl) {
    input.writeStderr("DATABASE_URL is required\n");
    return 1;
  }

  const pool = createPool(input.databaseUrl);
  try {
    if (command.kind === "stats") {
      const stats = await loadDatabaseStats(pool);
      input.writeStdout(formatStats(stats));
      return 0;
    }
    if (command.kind === "cleanup-expired") {
      const store = createHandoffStore(pool, defaultRetentionWindowMs);
      const deletedHandoffs = await store.cleanupExpiredHandoffs();
      input.writeStdout(`Deleted expired Handoffs: ${deletedHandoffs}\n`);
      if (deletedHandoffs === EXPIRED_HANDOFF_CLEANUP_BATCH_SIZE) {
        input.writeStdout(
          "Expired Handoffs may remain; run cleanup-expired again.\n",
        );
      }
      return 0;
    }
    if (command.kind === "inspect-fingerprint") {
      const resolution = await resolveStoredSpaceFingerprint(pool, command.fingerprint);
      if (resolution.kind === "none") {
        input.writeStdout(
          "No stored Space matches this Fingerprint. Fingerprint lookup only covers stored Handoffs.\n",
        );
        return 0;
      }
      if (resolution.kind === "ambiguous") {
        input.writeStderr(
          `Space Fingerprint is ambiguous: ${resolution.matchCount} stored matches\n`,
        );
        return 2;
      }
      exactSpaceId = resolution.spaceId;
    }
    const fingerprint = await deriveSpaceFingerprint(exactSpaceId!);
    const inspection = await inspectSpace(pool, exactSpaceId!);
    input.writeStdout(formatInspection(fingerprint, inspection));
    return 0;
  } catch {
    input.writeStderr("admin command failed\n");
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function readSpaceKeyFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return new Promise<string>((resolve, reject) => {
      let value = "";
      const wasRaw = process.stdin.isRaw;
      const finish = (outcome: { value: string } | { error: Error }): void => {
        process.stdin.off("data", onData);
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
        process.stderr.write("\n");
        if ("error" in outcome) reject(outcome.error);
        else resolve(outcome.value);
      };
      const onData = (chunk: string): void => {
        for (const character of chunk) {
          if (character === "\r" || character === "\n") {
            finish({ value });
            return;
          }
          if (character === "\u0003") {
            finish({ error: new Error("Space Key input cancelled") });
            return;
          }
          if (character === "\u007f" || character === "\b") {
            value = value.slice(0, -1);
            continue;
          }
          value += character;
        }
      };

      process.stderr.write("Space Key: ");
      process.stdin.setEncoding("utf8");
      process.stdin.setRawMode(true);
      process.stdin.on("data", onData);
      process.stdin.resume();
    });
  }

  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input.replace(/\r?\n$/, "");
}

async function main(): Promise<void> {
  const status = await runAdminCommand({
    args: process.argv.slice(2),
    databaseUrl: process.env["DATABASE_URL"],
    readSpaceKey: readSpaceKeyFromStdin,
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  });
  process.exitCode = status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write("admin command failed\n");
    process.exitCode = 1;
  });
}
