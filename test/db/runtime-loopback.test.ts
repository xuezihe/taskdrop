import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import type { ProductionConfig } from "../../src/production/config.js";
import { startProduction } from "../../src/production/runtime.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const skip = !DATABASE_URL;

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

describe.skipIf(skip)("Production runtime listener", () => {
  it("listens on loopback and serves health there", async () => {
    const port = await reservePort();
    const config: ProductionConfig = {
      port,
      databaseUrl: DATABASE_URL!,
      retentionWindowMs: 7 * 24 * 60 * 60 * 1000,
      logLevel: "silent",
    };
    const running = await startProduction(config);

    try {
      expect(running.host).toBe("127.0.0.1");

      const health = await fetch(`http://${running.host}:${running.port}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ status: "ok" });
    } finally {
      await running.shutdown();
    }
  });
});
