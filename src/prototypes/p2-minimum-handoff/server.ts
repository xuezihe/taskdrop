/**
 * PROTOTYPE - THROW AWAY.
 *
 * Question: is create -> get latest -> append -> get latest a sufficient and
 * coherent minimum Handoff contract for TaskDrop?
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
} from "../p1-codex-mcp-smoke/credential-adapter.js";
import { HandoffService, type HandoffResult, type HandoffSnapshot } from "./handoff-service.js";

const PORT = Number.parseInt(process.env.TASKDROP_P2_PORT ?? "4320", 10);
const HOST = "127.0.0.1";

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

type Operation = {
  sequence: number;
  tool: "create_handoff" | "get_handoff" | "append_revision";
  credentialCarrier: CredentialCarrier;
  scopeHash: string;
  handoffCode: string;
  result: "ok" | "HANDOFF_NOT_FOUND" | "REVISION_CONFLICT";
  revision?: number;
};

const service = new HandoffService();
const operations: Operation[] = [];
let operationSequence = 0;

const mcpHandler = createMcpHandler((context) => createHandoffServer(context), {
  legacy: "stateless",
  onerror() {
    renderState("SDK error observed; details suppressed to protect credentials");
  },
});

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
    response.setHeader("WWW-Authenticate", 'Bearer realm="TaskDrop P2"');
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

  const authenticatedRequest = request as AuthenticatedRequest;
  authenticatedRequest.auth = {
    token: credential.fingerprint,
    clientId: "taskdrop-p2",
    scopes: [],
    extra: {
      carrier: credential.carrier,
      fingerprint: credential.fingerprint,
    },
  };

  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");

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

function createHandoffServer(context: McpRequestContext): McpServer {
  const auth = readSanitizedAuth(context.authInfo);
  const server = new McpServer({ name: "taskdrop-p2", version: "0.0.0-prototype" });

  server.registerTool(
    "create_handoff",
    {
      description:
        "Create a temporary Handoff with immutable Revision 1. TaskDrop Space Keys in Markdown are automatically redacted.",
      inputSchema: z.object({ markdown: z.string().min(1) }),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ markdown }) => {
      const result = service.createHandoff(auth.scopeHash, markdown);
      recordOperation("create_handoff", auth, result);
      return toolResult(result);
    },
  );

  server.registerTool(
    "get_handoff",
    {
      description: "Read the latest or a numeric immutable Handoff Revision.",
      inputSchema: z.object({
        code: handoffCodeSchema,
        revision: z.union([z.number().int().positive(), z.literal("latest")]).optional(),
      }),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true },
    },
    async ({ code, revision }) => {
      const result = service.getHandoff(auth.scopeHash, code, revision ?? "latest");
      recordOperation("get_handoff", auth, result);
      return toolResult(result);
    },
  );

  server.registerTool(
    "append_revision",
    {
      description:
        "Append a complete Markdown snapshot when baseRevision is still latest. TaskDrop Space Keys in Markdown are automatically redacted.",
      inputSchema: z.object({
        code: handoffCodeSchema,
        baseRevision: z.number().int().positive(),
        markdown: z.string().min(1),
      }),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ code, baseRevision, markdown }) => {
      const result = service.appendRevision(auth.scopeHash, code, baseRevision, markdown);
      recordOperation("append_revision", auth, result);
      return toolResult(result);
    },
  );

  return server;
}

const handoffCodeSchema = z
  .string()
  .length(6)
  .regex(/^[0-9A-Z]+$/i);

const successSchema = z.object({
  ok: z.literal(true),
  code: z.string(),
  revision: z.number().int().positive(),
  latestRevision: z.number().int().positive(),
  isLatest: z.boolean(),
  markdown: z.string(),
  contentSanitized: z.boolean(),
  redactionCount: z.number().int().nonnegative(),
});

const failureSchema = z.object({
  ok: z.literal(false),
  error: z.discriminatedUnion("code", [
    z.object({
      code: z.literal("HANDOFF_NOT_FOUND"),
      handoffCode: z.string(),
    }),
    z.object({
      code: z.literal("REVISION_CONFLICT"),
      expectedRevision: z.number().int().positive(),
      receivedBaseRevision: z.number().int().positive(),
    }),
  ]),
});

const resultSchema = z.discriminatedUnion("ok", [successSchema, failureSchema]);

function successToolResult(result: HandoffSnapshot) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolResult(result: HandoffResult) {
  if (result.ok) {
    return successToolResult(result);
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    isError: true,
  };
}

function recordOperation(
  tool: Operation["tool"],
  auth: { carrier: CredentialCarrier; scopeHash: string },
  result: HandoffResult,
): void {
  operations.push({
    sequence: ++operationSequence,
    tool,
    credentialCarrier: auth.carrier,
    scopeHash: auth.scopeHash,
    handoffCode: result.ok ? result.code : readFailureCode(result),
    result: result.ok ? "ok" : result.error.code,
    ...(result.ok ? { revision: result.revision } : {}),
  });
  renderState(`${tool} completed`);
}

function readFailureCode(result: Exclude<HandoffResult, HandoffSnapshot>): string {
  return result.error.code === "HANDOFF_NOT_FOUND" ? result.error.handoffCode : "(unchanged)";
}

function readSanitizedAuth(authInfo: AuthInfo | undefined): {
  carrier: CredentialCarrier;
  scopeHash: string;
} {
  const carrier = authInfo?.extra?.carrier;
  const fingerprint = authInfo?.extra?.fingerprint;

  if (
    (carrier !== "bearer" && carrier !== "query" && carrier !== "both") ||
    typeof fingerprint !== "string"
  ) {
    throw new Error("Credential Adapter did not provide sanitized auth context");
  }

  return { carrier, scopeHash: fingerprint };
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

  console.log("TASKDROP P2 - PROTOTYPE / THROW AWAY");
  console.log(`State: ${message}`);
  console.log(`Endpoint: http://${HOST}:${PORT}/mcp (query intentionally omitted)`);
  console.log("In-memory Handoff state (Markdown bodies omitted):");
  console.log(JSON.stringify(service.visibleState(), null, 2));
  console.log("Operations (sanitized):");
  console.log(JSON.stringify(operations, null, 2));
  console.log("Press Ctrl+C to stop.");
}
