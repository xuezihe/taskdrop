/**
 * PROTOTYPE - THROW AWAY.
 *
 * One endpoint and one shared Handoff Service for the P6 cross-era contract.
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

import { resolveCredential } from "../p1-codex-mcp-smoke/credential-adapter.js";
import {
  HandoffService,
  type HandoffResult,
  type HandoffSnapshot,
} from "../p2-minimum-handoff/handoff-service.js";

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

export type P6Era = "legacy" | "modern";

export type P6RequestObservation = {
  sequence: number;
  requestedVersion: string;
  rpcMethod: string;
  requestHadSession: boolean;
  responseHadSession: boolean;
  responseStatus: number;
};

export type P6FactoryObservation = {
  sequence: number;
  era: P6Era;
  scopeHash: string;
};

export type P6ToolObservation = {
  sequence: number;
  tool: "create_handoff" | "get_handoff" | "append_revision";
  scopeHash: string;
  result: "ok" | "HANDOFF_NOT_FOUND" | "REVISION_CONFLICT";
  revision?: number;
};

export type P6Server = {
  endpoint: string;
  service: HandoffService;
  requestObservations: P6RequestObservation[];
  factoryObservations: P6FactoryObservation[];
  toolObservations: P6ToolObservation[];
  close(): Promise<void>;
};

export async function startP6Server(port: number): Promise<P6Server> {
  const host = "127.0.0.1";
  const origin = `http://${host}:${port}`;
  const service = new HandoffService();
  const requestObservations: P6RequestObservation[] = [];
  const factoryObservations: P6FactoryObservation[] = [];
  const toolObservations: P6ToolObservation[] = [];

  const mcpHandler = createMcpHandler(
    (context) => {
      const scopeHash = readScopeHash(context.authInfo);
      factoryObservations.push({
        sequence: factoryObservations.length + 1,
        era: context.era,
        scopeHash,
      });
      return createHandoffServer(service, scopeHash, toolObservations);
    },
    {
      legacy: "stateless",
      onerror() {
        // The runner reports sanitized contract failures. Never print bodies.
      },
    },
  );

  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror() {
      // The runner reports sanitized contract failures. Never print bodies.
    },
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const httpServer = createServer(async (request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;

    const requestUrl = new URL(request.url ?? "/", origin);
    if (requestUrl.pathname !== "/mcp") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const parsedBody = await readJsonBody(request, response);
    if (parsedBody === INVALID_JSON) return;

    const credential = resolveCredential({
      authorizationHeader: firstHeader(request.headers.authorization),
      queryCredential: requestUrl.searchParams.get("taskdropKey") ?? undefined,
    });
    if (!credential.ok) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="TaskDrop P6"');
      sendJson(response, 401, { error: "Authentication failed", reason: credential.reason });
      return;
    }

    const requestState = {
      requestedVersion: readRequestedVersion(request, parsedBody),
      rpcMethod: readRpcMethod(parsedBody),
      requestHadSession: Boolean(firstHeader(request.headers["mcp-session-id"])),
    };
    response.once("finish", () => {
      requestObservations.push({
        sequence: requestObservations.length + 1,
        ...requestState,
        responseHadSession: Boolean(response.getHeader("mcp-session-id")),
        responseStatus: response.statusCode,
      });
    });

    const authenticatedRequest = request as AuthenticatedRequest;
    authenticatedRequest.auth = {
      token: credential.fingerprint,
      clientId: "taskdrop-p6",
      scopes: [],
      extra: { fingerprint: credential.fingerprint },
    };
    response.setHeader("Cache-Control", "no-store");
    await nodeMcpHandler(
      authenticatedRequest as unknown as Parameters<typeof nodeMcpHandler>[0],
      response,
      parsedBody,
    );
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  return {
    endpoint: `${origin}/mcp`,
    service,
    requestObservations,
    factoryObservations,
    toolObservations,
    async close() {
      await mcpHandler.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function createHandoffServer(
  service: HandoffService,
  scopeHash: string,
  observations: P6ToolObservation[],
): McpServer {
  const server = new McpServer({ name: "taskdrop-p6", version: "0.0.0-prototype" });

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
      const result = service.createHandoff(scopeHash, markdown);
      recordTool(observations, "create_handoff", scopeHash, result);
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
      const result = service.getHandoff(scopeHash, code, revision ?? "latest");
      recordTool(observations, "get_handoff", scopeHash, result);
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
      const result = service.appendRevision(scopeHash, code, baseRevision, markdown);
      recordTool(observations, "append_revision", scopeHash, result);
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
    z.object({ code: z.literal("HANDOFF_NOT_FOUND"), handoffCode: z.string() }),
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
  if (result.ok) return successToolResult(result);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    isError: true,
  };
}

function recordTool(
  observations: P6ToolObservation[],
  tool: P6ToolObservation["tool"],
  scopeHash: string,
  result: HandoffResult,
): void {
  observations.push({
    sequence: observations.length + 1,
    tool,
    scopeHash,
    result: result.ok ? "ok" : result.error.code,
    ...(result.ok ? { revision: result.revision } : {}),
  });
}

function readScopeHash(authInfo: AuthInfo | undefined): string {
  const fingerprint = authInfo?.extra?.fingerprint;
  if (typeof fingerprint !== "string") {
    throw new Error("P6 Credential Adapter did not provide a sanitized scope");
  }
  return fingerprint;
}

const INVALID_JSON = Symbol("invalid-json");

async function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<unknown | typeof INVALID_JSON> {
  if (request.method !== "POST") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    sendJson(response, 400, { error: "Invalid JSON" });
    return INVALID_JSON;
  }
}

function readRequestedVersion(request: IncomingMessage, body: unknown): string {
  const header = firstHeader(request.headers["mcp-protocol-version"]);
  if (header) return header;
  const params = asRecord(asRecord(body)?.params);
  const initialized = params?.protocolVersion;
  if (typeof initialized === "string") return initialized;
  const meta = asRecord(params?._meta);
  const enveloped = meta?.["io.modelcontextprotocol/protocolVersion"];
  return typeof enveloped === "string" ? enveloped : "(none)";
}

function readRpcMethod(body: unknown): string {
  const method = asRecord(body)?.method;
  return typeof method === "string" ? method : "(none)";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
