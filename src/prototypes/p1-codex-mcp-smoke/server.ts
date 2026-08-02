/**
 * PROTOTYPE — THROW AWAY.
 *
 * Question: can current Codex call one Streamable HTTP MCP tool when the same
 * Space Key arrives through either a Bearer Header or the taskdropKey query,
 * and what protocol lifecycle does Codex actually use?
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { z } from "zod";

import {
  resolveCredential,
  type CredentialCarrier,
} from "./credential-adapter.js";

const PORT = Number.parseInt(process.env.TASKDROP_P1_PORT ?? "4310", 10);
const HOST = "127.0.0.1";

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

type Observation = {
  sequence: number;
  httpMethod: string;
  path: "/mcp";
  rpcMethod: string;
  credentialCarrier: CredentialCarrier;
  credentialFingerprint: string;
  declaredProtocolVersion: string;
  requestHadSession: boolean;
  responseStatus: number;
  responseHadSession: boolean;
};

const observations: Observation[] = [];
let requestSequence = 0;

const mcpHandler = createMcpHandler(
  (context) => createProbeServer(context),
  {
    legacy: "stateless",
    onerror() {
      renderState("SDK error observed; details suppressed to protect credentials");
    },
  },
);

const nodeMcpHandler = toNodeHandler(mcpHandler, {
  onerror() {
    renderState("Node adapter error observed; details suppressed to protect credentials");
  },
});

const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createServer(async (request, response) => {
  if (!validateHost(request, response) || !validateOrigin(request, response)) {
    return;
  }

  const requestUrl = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);

  if (requestUrl.pathname !== "/mcp") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  const credential = resolveCredential({
    authorizationHeader: firstHeader(request.headers.authorization),
    queryCredential: requestUrl.searchParams.get("taskdropKey") ?? undefined,
  });

  if (!credential.ok) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="TaskDrop P1"');
    sendJson(response, 401, {
      error: "Authentication failed",
      reason: credential.reason,
    });
    renderState(`Rejected authentication: ${credential.reason}`);
    return;
  }

  const parsedBody = await readJsonBody(request, response);
  if (parsedBody === INVALID_JSON) {
    return;
  }

  const sequence = ++requestSequence;
  const startedObservation = {
    sequence,
    httpMethod: request.method ?? "UNKNOWN",
    path: "/mcp" as const,
    rpcMethod: readRpcMethod(parsedBody),
    credentialCarrier: credential.carrier,
    credentialFingerprint: credential.fingerprint,
    declaredProtocolVersion: readProtocolVersion(request, parsedBody),
    requestHadSession: Boolean(firstHeader(request.headers["mcp-session-id"])),
  };

  const authenticatedRequest = request as AuthenticatedRequest;
  authenticatedRequest.auth = {
    // The raw Space Key stops at the Credential Adapter. The SDK receives only
    // the irreversible fingerprint and sanitized carrier metadata.
    token: credential.fingerprint,
    clientId: "taskdrop-p1",
    scopes: [],
    extra: {
      carrier: credential.carrier,
      fingerprint: credential.fingerprint,
    },
  };

  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.once("finish", () => {
    observations.push({
      ...startedObservation,
      responseStatus: response.statusCode,
      responseHadSession: Boolean(response.getHeader("mcp-session-id")),
    });
    renderState("Request completed");
  });

  // The adapter intentionally accepts an IncomingMessage-shaped object. Its
  // structural type spells optional fields more narrowly than Node's own type
  // under exactOptionalPropertyTypes, so keep the conversion at this boundary.
  await nodeMcpHandler(
    authenticatedRequest as unknown as Parameters<typeof nodeMcpHandler>[0],
    response,
    parsedBody,
  );
});

httpServer.listen(PORT, HOST, () => {
  renderState(`Listening on http://${HOST}:${PORT}/mcp`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void mcpHandler.close().finally(() => httpServer.close());
  });
}

function createProbeServer(context: McpRequestContext): McpServer {
  const auth = readSanitizedAuth(context.authInfo);
  const server = new McpServer({ name: "taskdrop-p1", version: "0.0.0-prototype" });

  const outputSchema = z.object({
    ok: z.literal(true),
    credentialFingerprint: z.string(),
    carrier: z.enum(["bearer", "query", "both"]),
    era: z.enum(["legacy", "modern"]),
  });

  server.registerTool(
    "probe",
    {
      description: "Report sanitized TaskDrop P1 MCP and credential state.",
      inputSchema: z.object({}),
      outputSchema,
      annotations: { readOnlyHint: true },
    },
    async () => {
      const result = {
        ok: true as const,
        credentialFingerprint: auth.fingerprint,
        carrier: auth.carrier,
        era: context.era,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}

function readSanitizedAuth(authInfo: AuthInfo | undefined): {
  carrier: CredentialCarrier;
  fingerprint: string;
} {
  const carrier = authInfo?.extra?.carrier;
  const fingerprint = authInfo?.extra?.fingerprint;

  if (
    (carrier !== "bearer" && carrier !== "query" && carrier !== "both") ||
    typeof fingerprint !== "string"
  ) {
    throw new Error("Credential Adapter did not provide sanitized auth context");
  }

  return { carrier, fingerprint };
}

const INVALID_JSON = Symbol("invalid-json");

async function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<unknown | typeof INVALID_JSON> {
  if (request.method !== "POST") {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) {
    return undefined;
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    sendJson(response, 400, { error: "Invalid JSON" });
    return INVALID_JSON;
  }
}

function readRpcMethod(body: unknown): string {
  const record = asRecord(body);
  if (typeof record?.method === "string") {
    return record.method;
  }

  const request = asRecord(record?.request);
  return typeof request?.method === "string" ? request.method : "(none)";
}

function readProtocolVersion(request: IncomingMessage, body: unknown): string {
  const headerVersion = firstHeader(request.headers["mcp-protocol-version"]);
  if (headerVersion) {
    return headerVersion;
  }

  const record = asRecord(body);
  const params = asRecord(record?.params);
  if (typeof params?.protocolVersion === "string") {
    return params.protocolVersion;
  }

  const meta = asRecord(record?._meta);
  return typeof meta?.protocolVersion === "string" ? meta.protocolVersion : "(not declared)";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function renderState(message: string): void {
  if (process.stdout.isTTY) {
    console.clear();
  }

  console.log("TASKDROP P1 — PROTOTYPE / THROW AWAY");
  console.log(`State: ${message}`);
  console.log(`Endpoint: http://${HOST}:${PORT}/mcp (query intentionally omitted)`);
  console.log("Credential format: tdp_ + 43 Base64URL characters");
  console.log("Observations (sanitized):");
  console.log(JSON.stringify(observations, null, 2));
  console.log("Press Ctrl+C to stop.");
}
