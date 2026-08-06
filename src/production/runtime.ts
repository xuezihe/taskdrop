import http, { type Server } from "node:http";
import pg from "pg";

import type { ProductionConfig } from "./config.js";

export interface RunningServer {
  readonly port: number;
  shutdown(): Promise<void>;
}

const SHUTDOWN_DRAIN_MS = 5_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

const HEALTH_OK_BODY = JSON.stringify({ status: "ok" });
const HEALTH_UNAVAILABLE_BODY = JSON.stringify({ status: "unavailable" });

export async function startProduction(config: ProductionConfig): Promise<RunningServer> {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  let shuttingDown = false;

  const probeHealth = async (): Promise<boolean> => {
    let client;
    try {
      client = await pool.connect();
      const probe = client.query("SELECT 1");
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("health probe timeout")), HEALTH_PROBE_TIMEOUT_MS),
      );
      await Promise.race([probe, timeout]);
      return true;
    } catch {
      return false;
    } finally {
      if (client) client.release();
    }
  };

  const server = http.createServer((req, res) => {
    if (req.url !== "/health" || req.method !== "GET") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (shuttingDown) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(HEALTH_UNAVAILABLE_BODY);
      return;
    }
    void probeHealth()
      .then((ok) => {
        res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
        res.end(ok ? HEALTH_OK_BODY : HEALTH_UNAVAILABLE_BODY);
      })
      .catch(() => {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(HEALTH_UNAVAILABLE_BODY);
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      shuttingDown = true;
      server.close();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
        server.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await pool.end();
    })();
    return shutdownPromise;
  };

  return { port: config.port, shutdown };
}

export type { Server };
