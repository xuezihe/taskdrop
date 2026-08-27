import type {
  IncomingHttpHeaders,
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";

import { authenticateMcpCredential, type AuthenticatedSpace } from "./credential.js";

export type { AuthenticatedSpace } from "./credential.js";

export interface SanitizedMcpRequest extends AsyncIterable<unknown> {
  readonly method?: string;
  readonly url: "/mcp";
  readonly headers: IncomingHttpHeaders;
}

export type AuthenticatedMcpDispatch = (
  authentication: AuthenticatedSpace,
  request: SanitizedMcpRequest,
  response: ServerResponse,
) => Promise<void> | void;

const UNAUTHORIZED_BODY = JSON.stringify({ error: "unauthorized" });
const NOT_FOUND_BODY = JSON.stringify({ error: "not_found" });

export function createMcpHttpAuthenticationHandler(
  dispatch: AuthenticatedMcpDispatch,
): RequestListener {
  return async (request, response) => {
    const outcome = await authenticateMcpCredential(request);
    if (outcome.kind === "not-mcp-path") {
      sendJson(response, 404, NOT_FOUND_BODY);
      return;
    }
    if (outcome.kind === "unauthenticated") {
      sendJson(response, 401, UNAUTHORIZED_BODY);
      return;
    }
    await dispatch(outcome.authentication, sanitizeMcpRequest(request), response);
  };
}

const MCP_HEADER_ALLOWLIST = [
  "host",
  "content-type",
  "content-length",
  "accept",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "mcp-session-id",
  "last-event-id",
] as const;

function sanitizeMcpRequest(request: IncomingMessage): SanitizedMcpRequest {
  const headers: Record<string, string | string[] | undefined> = {};
  for (const name of MCP_HEADER_ALLOWLIST) {
    const value = request.headers[name];
    if (value !== undefined) headers[name] = value;
  }

  return {
    ...(request.method === undefined ? {} : { method: request.method }),
    url: "/mcp",
    headers,
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return request[Symbol.asyncIterator]();
    },
  };
}

function sendJson(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}
