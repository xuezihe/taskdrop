import http, { type Server } from "node:http";

import type { ProductionConfig } from "./config.js";
import { createPool } from "./db.js";
import { createHandoffApplication } from "./handoff-application.js";
import { createHandoffStore } from "./handoff-store.js";
import { createMcpEndpoint } from "./mcp-endpoint.js";
import { createMcpHttpAuthenticationHandler } from "./mcp-http-auth.js";

export interface RunningServer {
  readonly port: number;
  shutdown(): Promise<void>;
}

const SHUTDOWN_DRAIN_MS = 5_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;

const HEALTH_OK_BODY = JSON.stringify({ status: "ok" });
const HEALTH_UNAVAILABLE_BODY = JSON.stringify({ status: "unavailable" });

export async function startProduction(config: ProductionConfig): Promise<RunningServer> {
  const pool = createPool(config.databaseUrl);
  const store = createHandoffStore(pool, config.retentionWindowMs);
  const application = createHandoffApplication(store);
  const mcpEndpoint = createMcpEndpoint(application);
  const authenticateMcp = createMcpHttpAuthenticationHandler(
    (authentication, request, response) =>
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
      await mcpEndpoint.close();
      await pool.end();
    })();
    return shutdownPromise;
  };

  return { port: config.port, shutdown };
}

export type { Server };
