import { createServer, type Server } from "node:http";

import { describe, expect, it } from "vitest";

import {
  createMcpHttpAuthenticationHandler,
  type AuthenticatedSpace,
  type SanitizedMcpRequest,
} from "../src/production/mcp-http-auth.js";
import { formatSpaceKey } from "../src/production/space-identity.js";

const SPACE_KEY = formatSpaceKey(new Uint8Array(32));
const OTHER_SPACE_KEY = formatSpaceKey(new Uint8Array(32).fill(1));
const ZERO_SPACE_ID = "181d0758ffa73f59cb5ba396e9f057f5256f9c9df754494441cfa8792aaa0fc5";
const ZERO_SPACE_FINGERPRINT = "-o-8vzjhQgZ_";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function withAuthenticatedServer(
  run: (
    endpoint: string,
    dispatched: AuthenticatedSpace[],
    requests: SanitizedMcpRequest[],
    bodies: string[],
  ) => Promise<void>,
): Promise<void> {
  const dispatched: AuthenticatedSpace[] = [];
  const requests: SanitizedMcpRequest[] = [];
  const bodies: string[] = [];
  const server = createServer(
    createMcpHttpAuthenticationHandler(async (authentication, request, response) => {
      dispatched.push(authentication);
      requests.push(request);
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(204);
      response.end();
    }),
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("test server did not bind a TCP port");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`, dispatched, requests, bodies);
  } finally {
    await closeServer(server);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("MCP HTTP authentication boundary", () => {
  it("accepts the carrier matrix and rejects missing, malformed, conflicting, and non-canonical credentials before dispatch", async () => {
    await withAuthenticatedServer(async (endpoint, dispatched, requests) => {
      const successfulCarriers = [
        {
          url: `${endpoint}/mcp`,
          init: { headers: { authorization: `Bearer ${SPACE_KEY}` } },
          carrier: "bearer",
        },
        {
          url: `${endpoint}/mcp?taskdropKey=${SPACE_KEY}`,
          init: {},
          carrier: "query",
        },
        {
          url: `${endpoint}/mcp?taskdropKey=${SPACE_KEY}`,
          init: { headers: { authorization: `Bearer ${SPACE_KEY}` } },
          carrier: "both",
        },
      ] as const;

      for (const testCase of successfulCarriers) {
        const response = await fetch(testCase.url, testCase.init);
        expect(response.status).toBe(204);
      }

      expect(dispatched.map(({ carrier }) => carrier)).toEqual(["bearer", "query", "both"]);
      expect(dispatched.map(({ spaceId }) => toHex(spaceId))).toEqual([
        ZERO_SPACE_ID,
        ZERO_SPACE_ID,
        ZERO_SPACE_ID,
      ]);
      expect(dispatched.map(({ spaceFingerprint }) => spaceFingerprint)).toEqual([
        ZERO_SPACE_FINGERPRINT,
        ZERO_SPACE_FINGERPRINT,
        ZERO_SPACE_FINGERPRINT,
      ]);
      expect(requests.map(({ url }) => url)).toEqual(["/mcp", "/mcp", "/mcp"]);
      expect(requests.map(({ headers }) => headers.authorization)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);

      const rejectedRequests = [
        { url: `${endpoint}/mcp`, init: {} },
        {
          url: `${endpoint}/mcp`,
          init: { headers: { authorization: `Basic ${SPACE_KEY}` } },
        },
        {
          url: `${endpoint}/mcp?taskdropKey=${SPACE_KEY}`,
          init: { headers: { authorization: `Bearer ${OTHER_SPACE_KEY}` } },
        },
        { url: `${endpoint}/mcp?taskdropKey=${SPACE_KEY}=`, init: {} },
      ];

      const rejectedResponses = await Promise.all(
        rejectedRequests.map(({ url, init }) => fetch(url, init)),
      );

      expect(rejectedResponses.map(({ status }) => status)).toEqual([401, 401, 401, 401]);
      await expect(
        Promise.all(rejectedResponses.map((response) => response.text())),
      ).resolves.toEqual([
        '{"error":"unauthorized"}',
        '{"error":"unauthorized"}',
        '{"error":"unauthorized"}',
        '{"error":"unauthorized"}',
      ]);
      expect(dispatched).toHaveLength(3);
    });
  });

  it("reads query credentials only at the exact endpoint, never redirects, and passes no raw key downstream", async () => {
    await withAuthenticatedServer(async (endpoint, dispatched, requests, bodies) => {
      const body = JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 1 });
      const exactEndpoint = await fetch(`${endpoint}/mcp?taskdropKey=${SPACE_KEY}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "get_handoff",
          "x-untrusted-header": "must-not-cross-auth-boundary",
        },
        body,
      });
      const trailingSlash = await fetch(`${endpoint}/mcp/?taskdropKey=${SPACE_KEY}`);
      const otherPath = await fetch(`${endpoint}/other?taskdropKey=${SPACE_KEY}`);

      expect(exactEndpoint.status).toBe(204);
      expect(trailingSlash.status).toBe(404);
      expect(otherPath.status).toBe(404);
      expect(trailingSlash.headers.get("location")).toBeNull();
      expect(otherPath.headers.get("location")).toBeNull();

      expect(dispatched).toHaveLength(1);
      const authenticatedSpace = dispatched[0]!;
      expect(Object.keys(authenticatedSpace).sort()).toEqual([
        "carrier",
        "spaceFingerprint",
        "spaceId",
      ]);
      expect(JSON.stringify(authenticatedSpace)).not.toContain(SPACE_KEY);
      expect(authenticatedSpace.carrier).toBe("query");
      expect(toHex(authenticatedSpace.spaceId)).toBe(ZERO_SPACE_ID);
      expect(authenticatedSpace.spaceFingerprint).toBe(ZERO_SPACE_FINGERPRINT);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("/mcp");
      expect(requests[0]?.headers.authorization).toBeUndefined();
      expect(requests[0]?.headers["mcp-protocol-version"]).toBe("2026-07-28");
      expect(requests[0]?.headers["mcp-method"]).toBe("tools/call");
      expect(requests[0]?.headers["mcp-name"]).toBe("get_handoff");
      expect(requests[0]?.headers["x-untrusted-header"]).toBeUndefined();
      expect(bodies).toEqual([body]);
    });
  });
});
