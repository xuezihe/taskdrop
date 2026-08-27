/**
 * PROTOTYPE - THROW AWAY.
 *
 * Question: can a local Setup Page, the TaskDrop Skill, Devin Desktop,
 * and Codex complete one realistic Handoff without copying Markdown?
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";

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
import {
  HandoffService,
  type HandoffResult,
  type HandoffSnapshot,
} from "../p2-minimum-handoff/handoff-service.js";
import { AcceptanceRecorder, type AcceptanceStage } from "./acceptance-recorder.js";
import { createSetupPage } from "./setup-page.js";

const PORT = Number.parseInt(process.env.TASKDROP_P5_PORT ?? "4340", 10);
const HOST = "127.0.0.1";
const ORIGIN = `http://${HOST}:${PORT}`;
const MCP_ENDPOINT = `${ORIGIN}/mcp`;

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

const service = new HandoffService();
const recorder = new AcceptanceRecorder();
let lastPrintedSequence = 0;
let shuttingDown = false;

const mcpHandler = createMcpHandler((context) => createHandoffServer(context), {
  legacy: "stateless",
  onerror() {
    console.error("[mcp] SDK error observed; sensitive details suppressed");
  },
});

const nodeMcpHandler = toNodeHandler(mcpHandler, {
  onerror() {
    console.error("[mcp] Node adapter error observed; sensitive details suppressed");
  },
});

const validateHost = localhostHostValidation();
const validateOrigin = localhostOriginValidation();

const httpServer = createServer(async (request, response) => {
  if (!validateHost(request, response)) return;

  const requestUrl = new URL(request.url ?? "/", ORIGIN);
  if (request.method === "GET" && requestUrl.pathname === "/") {
    sendSetupPage(response);
    return;
  }
  if (request.method === "GET" && requestUrl.pathname === "/healthz") {
    sendJson(response, 200, { ok: true, prototype: "p5" });
    return;
  }
  if (requestUrl.pathname !== "/mcp") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  if (!validateOrigin(request, response)) return;

  const parsedBody = await readJsonBody(request, response);
  if (parsedBody === INVALID_JSON) return;

  const credential = resolveCredential({
    authorizationHeader: firstHeader(request.headers.authorization),
    queryCredential: requestUrl.searchParams.get("taskdropKey") ?? undefined,
  });
  const requestState = {
    rpcMethod: readRpcMethod(parsedBody),
    ...readOptionalToolName(parsedBody),
    authentication: credential.ok ? "accepted" : credential.reason,
    ...(credential.ok
      ? {
          credentialCarrier: credential.carrier,
          scopeHash: credential.fingerprint,
        }
      : {}),
    declaredProtocolVersion: readProtocolVersion(request, parsedBody),
    requestHadSession: Boolean(firstHeader(request.headers["mcp-session-id"])),
  };

  response.once("finish", () => {
    recorder.record({
      ...requestState,
      responseStatus: response.statusCode,
      responseHadSession: Boolean(response.getHeader("mcp-session-id")),
    });
    printNewObservations();
  });

  if (!credential.ok) {
    response.setHeader("WWW-Authenticate", 'Bearer realm="TaskDrop P5"');
    sendJson(response, 401, {
      error: "Authentication failed",
      reason: credential.reason,
    });
    return;
  }

  const authenticatedRequest = request as AuthenticatedRequest;
  authenticatedRequest.auth = {
    token: credential.fingerprint,
    clientId: "taskdrop-p5",
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

await new Promise<void>((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(PORT, HOST, () => {
    httpServer.off("error", reject);
    resolve();
  });
});

console.log("TASKDROP P5 - PROTOTYPE / THROW AWAY");
console.log(`Setup Page: ${ORIGIN}/`);
console.log(`MCP endpoint: ${MCP_ENDPOINT}`);
console.log("State: memory only; stopping this process destroys all Handoffs");
console.log("Logs: credentials and Markdown omitted");
console.log("");
console.log("Commands (type one letter, then Return):");
console.log("  d  Devin readiness");
console.log("  s  Devin realistic source Handoff");
console.log("  c  Codex continuation and append");
console.log("  r  Devin reads the new latest");
console.log("  q  Stop and destroy in-memory state");

if (process.stdin.isTTY) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  terminal.on("line", (line) => void handleCommand(line));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(0));
}

function createHandoffServer(context: McpRequestContext): McpServer {
  const auth = readSanitizedAuth(context.authInfo);
  const server = new McpServer({ name: "taskdrop-p5", version: "0.0.0-prototype" });

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
      printHandoffResult("create_handoff", auth.scopeHash, result);
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
      printHandoffResult("get_handoff", auth.scopeHash, result);
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
      printHandoffResult("append_revision", auth.scopeHash, result);
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
  if (result.ok) return successToolResult(result);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    isError: true,
  };
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

function printHandoffResult(tool: string, scopeHash: string, result: HandoffResult): void {
  if (result.ok) {
    console.log(
      `[handoff] stage=${recorder.stage} tool=${tool} scope=${scopeHash} code=${result.code} revision=${result.revision} latest=${result.latestRevision} markdownLength=${result.markdown.length} sanitized=${result.contentSanitized} redactions=${result.redactionCount}`,
    );
    return;
  }
  console.log(
    `[handoff] stage=${recorder.stage} tool=${tool} scope=${scopeHash} result=${result.error.code}`,
  );
}

function printNewObservations(): void {
  for (const observation of recorder.snapshot().observations) {
    if (observation.sequence <= lastPrintedSequence) continue;
    lastPrintedSequence = observation.sequence;
    console.log(
      `[mcp] #${observation.sequence} stage=${observation.stage} rpc=${observation.rpcMethod}${observation.toolName ? ` tool=${observation.toolName}` : ""} auth=${observation.authentication}${observation.credentialCarrier ? ` carrier=${observation.credentialCarrier}` : ""}${observation.scopeHash ? ` scope=${observation.scopeHash}` : ""} protocol=${observation.declaredProtocolVersion} session=${observation.requestHadSession || observation.responseHadSession} status=${observation.responseStatus}`,
    );
  }
}

async function handleCommand(input: string): Promise<void> {
  const command = input.trim().toLowerCase();
  const stages: Partial<Record<string, Exclude<AcceptanceStage, "setup">>> = {
    d: "devin-readiness",
    s: "devin-source",
    c: "codex-continuation",
    r: "devin-resume",
  };
  const stage = stages[command];
  if (stage) {
    recorder.setStage(stage);
    console.log(`[stage] ${stage}`);
    return;
  }
  if (command === "q") await shutdown(0);
}

function sendSetupPage(response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  response.end(createSetupPage(MCP_ENDPOINT));
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

function readRpcMethod(body: unknown): string {
  const method = asRecord(body)?.method;
  return typeof method === "string" ? method : "(none)";
}

function readOptionalToolName(body: unknown): { toolName?: string } {
  const bodyRecord = asRecord(body);
  if (bodyRecord?.method !== "tools/call") return {};
  const name = asRecord(bodyRecord.params)?.name;
  return typeof name === "string" ? { toolName: name } : {};
}

function readProtocolVersion(request: IncomingMessage, body: unknown): string {
  const header = firstHeader(request.headers["mcp-protocol-version"]);
  if (header) return header;
  const bodyRecord = asRecord(body);
  if (bodyRecord?.method !== "initialize") return "(none)";
  const version = asRecord(bodyRecord.params)?.protocolVersion;
  return typeof version === "string" ? version : "(none)";
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

async function shutdown(exitCode: number): Promise<never> {
  if (shuttingDown) process.exit(exitCode);
  shuttingDown = true;
  console.log("[shutdown] closing Server and destroying in-memory Handoffs");
  await mcpHandler.close().catch(() => undefined);
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  process.exit(exitCode);
}
