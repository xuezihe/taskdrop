import http, { type Server } from "node:http";

import type { ProductionConfig } from "./config.js";
import { createPool } from "./db.js";
import { startExpiredHandoffCleanup, type CleanupObservation } from "./expired-handoff-cleanup.js";
import { createHandoffApplication } from "./handoff-application.js";
import { createHandoffStore } from "./handoff-store.js";
import { createBrowserApiHandler, isBrowserApiPath } from "./browser-api.js";
import { createMcpEndpoint } from "./mcp-endpoint.js";
import { createMcpHttpAuthenticationHandler } from "./mcp-http-auth.js";

export interface RunningServer {
  readonly host: string;
  readonly port: number;
  shutdown(): Promise<void>;
}

const PRODUCTION_HOST = "127.0.0.1";
const SHUTDOWN_DRAIN_MS = 5_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

const HEALTH_OK_BODY = JSON.stringify({ status: "ok" });
const HEALTH_UNAVAILABLE_BODY = JSON.stringify({ status: "unavailable" });

export async function startProduction(config: ProductionConfig): Promise<RunningServer> {
  const pool = createPool(config.databaseUrl);
  const store = createHandoffStore(pool, config.retentionWindowMs);
  const application = createHandoffApplication(store);
  const browserApi = createBrowserApiHandler(application);
  const mcpEndpoint = createMcpEndpoint(application);
  const authenticateMcp = createMcpHttpAuthenticationHandler((authentication, request, response) =>
    mcpEndpoint.dispatch(authentication, request, response),
  );

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
      if (isBrowserApiPath(req.url)) {
        void browserApi(req, res);
        return;
      }
      void authenticateMcp(req, res);
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
    server.listen(config.port, PRODUCTION_HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const listenerAddress = server.address();
  if (!listenerAddress || typeof listenerAddress === "string") {
    server.close();
    await pool.end();
    throw new Error("production listener did not expose a TCP address");
  }

  const observeCleanup = (observation: CleanupObservation): void => {
    if (config.logLevel === "silent") return;
    const destination = "outcome" in observation ? process.stderr : process.stdout;
    destination.write(`${JSON.stringify(observation)}\n`);
  };
  const cleanup = startExpiredHandoffCleanup({
    cleanupPass: () => store.cleanupExpiredHandoffs(),
    observe: observeCleanup,
  });

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      shuttingDown = true;
      const cleanupStopped = cleanup.stop();
      server.close();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
        server.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await mcpEndpoint.close();
      await cleanupStopped;
      await pool.end();
    })();
    return shutdownPromise;
  };

  return {
    host: listenerAddress.address,
    port: listenerAddress.port,
    shutdown,
  };
}

export type { Server };
