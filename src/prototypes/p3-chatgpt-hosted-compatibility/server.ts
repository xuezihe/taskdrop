/**
 * PROTOTYPE - THROW AWAY.
 *
 * Hosted diagnostic shell for deciding whether ChatGPT preserves TaskDrop's
 * query credential and can invoke the validated P2 Handoff contract.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
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
import {
  LifecycleRecorder,
  type AuthenticationOutcome,
} from "./lifecycle-recorder.js";

type AuthenticatedRequest = IncomingMessage & { auth?: AuthInfo };

type StartOptions = {
  port: number;
  expectedFingerprint: string;
  onStateChanged: () => void;
};

export type P3Server = {
  localOrigin: string;
  recorder: LifecycleRecorder;
  allowPublicHost(hostname: string): void;
  snapshot(): {
    handoffs: ReturnType<HandoffService["visibleState"]>;
    lifecycle: ReturnType<LifecycleRecorder["snapshot"]>;
  };
  close(): Promise<void>;
};

export async function startP3Server(options: StartOptions): Promise<P3Server> {
  const host = "127.0.0.1";
  const localOrigin = `http://${host}:${options.port}`;
  const allowedHostnames = new Set([host, "localhost"]);
  const recorder = new LifecycleRecorder();
  const service = new HandoffService();

  const mcpHandler = createMcpHandler(
    (context) => createHandoffServer(context, service, options.onStateChanged),
    {
      legacy: "stateless",
      onerror() {
        options.onStateChanged();
      },
    },
  );

  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror() {
      options.onStateChanged();
    },
  });

  const httpServer = createServer(async (request, response) => {
    if (!isAllowedRequestOrigin(request, allowedHostnames)) {
      sendJson(response, 403, { error: "Request host or origin is not allowed" });
      return;
    }

    const requestUrl = new URL(request.url ?? "/", localOrigin);
    if (requestUrl.pathname !== "/mcp") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    const parsedBody = await readJsonBody(request, response);
    if (parsedBody === INVALID_JSON) {
      return;
    }

    const credential = resolveCredential({
      authorizationHeader: firstHeader(request.headers.authorization),
      queryCredential: requestUrl.searchParams.get("taskdropKey") ?? undefined,
    });

    const authentication: AuthenticationOutcome = credential.ok
      ? "accepted"
      : credential.reason;
    const requestState = {
      httpMethod: request.method ?? "UNKNOWN",
      path: "/mcp" as const,
      rpcMethod: readRpcMethod(parsedBody),
      ...readOptionalToolName(parsedBody),
      authentication,
      ...(credential.ok
        ? {
            credentialCarrier: credential.carrier,
            credentialFingerprint: credential.fingerprint,
          }
        : {}),
      credentialMatchedExpected:
        credential.ok && credential.fingerprint === options.expectedFingerprint,
      declaredProtocolVersion: readProtocolVersion(request, parsedBody),
      requestHadSession: Boolean(firstHeader(request.headers["mcp-session-id"])),
    };

    response.once("finish", () => {
      recorder.record({
        ...requestState,
        responseStatus: response.statusCode,
        responseHadSession: Boolean(response.getHeader("mcp-session-id")),
      });
      options.onStateChanged();
    });

    if (!credential.ok) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="TaskDrop P3"');
      sendJson(response, 401, {
        error: "Authentication failed",
        reason: credential.reason,
      });
      return;
    }

    const authenticatedRequest = request as AuthenticatedRequest;
    authenticatedRequest.auth = {
      token: credential.fingerprint,
      clientId: "taskdrop-p3",
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
    httpServer.listen(options.port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  return {
    localOrigin,
    recorder,
    allowPublicHost(hostname) {
      allowedHostnames.add(hostname.toLowerCase());
    },
    snapshot() {
      return {
        handoffs: service.visibleState(),
        lifecycle: recorder.snapshot(),
      };
    },
    async close() {
      await mcpHandler.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function createHandoffServer(
  context: McpRequestContext,
  service: HandoffService,
  onStateChanged: () => void,
): McpServer {
  const auth = readSanitizedAuth(context.authInfo);
  const server = new McpServer({ name: "taskdrop-p3", version: "0.0.0-prototype" });

  server.registerTool(
    "create_handoff",
    {
      description: "Create a temporary Handoff with immutable Revision 1.",
      inputSchema: z.object({ markdown: z.string().min(1) }),
      outputSchema: successSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ markdown }) => {
      const result = service.createHandoff(auth.scopeHash, markdown);
      onStateChanged();
      return successToolResult(result);
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
      onStateChanged();
      return toolResult(result);
    },
  );

  server.registerTool(
    "append_revision",
    {
      description:
        "Append a complete Markdown snapshot when baseRevision is still latest.",
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
      onStateChanged();
      return toolResult(result);
    },
  );

  return server;
}

const handoffCodeSchema = z.string().length(6).regex(/^[0-9A-Z]+$/i);

const successSchema = z.object({
  ok: z.literal(true),
  code: z.string(),
  revision: z.number().int().positive(),
  latestRevision: z.number().int().positive(),
  isLatest: z.boolean(),
  markdown: z.string(),
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

function isAllowedRequestOrigin(
  request: IncomingMessage,
  allowedHostnames: ReadonlySet<string>,
): boolean {
  const hostHeader = firstHeader(request.headers.host);
  if (!hostHeader) {
    return false;
  }

  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }

  if (!allowedHostnames.has(hostname)) {
    return false;
  }

  const originHeader = firstHeader(request.headers.origin);
  if (!originHeader) {
    return true;
  }

  try {
    return allowedHostnames.has(new URL(originHeader).hostname.toLowerCase());
  } catch {
    return false;
  }
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

function readOptionalToolName(body: unknown): { toolName?: string } {
  const params = asRecord(asRecord(body)?.params);
  return typeof params?.name === "string" ? { toolName: params.name } : {};
}

function readProtocolVersion(request: IncomingMessage, body: unknown): string {
  const headerVersion = firstHeader(request.headers["mcp-protocol-version"]);
  if (headerVersion) {
    return headerVersion;
  }

  const params = asRecord(asRecord(body)?.params);
  return typeof params?.protocolVersion === "string"
    ? params.protocolVersion
    : "(not declared)";
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
