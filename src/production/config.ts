export interface ProductionConfig {
  port: number;
  databaseUrl: string;
  retentionWindowMs: number;
  logLevel: string;
}

const DEFAULT_RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_RETENTION_WINDOW_MS = 60 * 60 * 1000;
const MAX_RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const defaultRetentionWindowMs = DEFAULT_RETENTION_WINDOW_MS;

export function parseRetentionWindowMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return DEFAULT_RETENTION_WINDOW_MS;
  }
  const ms = Number(raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid RETENTION_WINDOW_MS: ${raw}`);
  }
  if (ms < MIN_RETENTION_WINDOW_MS || ms > MAX_RETENTION_WINDOW_MS) {
    throw new Error(
      `RETENTION_WINDOW_MS ${ms} out of range [${MIN_RETENTION_WINDOW_MS}, ${MAX_RETENTION_WINDOW_MS}]`,
    );
  }
  return ms;
}

export function resolveConfig(env: NodeJS.ProcessEnv): ProductionConfig {
  const portRaw = env["PORT"];
  if (portRaw === undefined || portRaw === "") {
    throw new Error("PORT is required");
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PORT: ${portRaw}`);
  }
  const databaseUrl = env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    throw new Error("DATABASE_URL is required");
  }
  const logLevel = env["LOG_LEVEL"] ?? "info";
  return {
    port,
    databaseUrl,
    retentionWindowMs: parseRetentionWindowMs(env["RETENTION_WINDOW_MS"]),
    logLevel,
  };
}
