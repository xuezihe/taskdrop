import type { RequestListener, ServerResponse } from "node:http";

import {
  authenticateMcpCredential,
  type AuthenticatedSpace,
} from "./credential.js";

export type { AuthenticatedSpace } from "./credential.js";

export type AuthenticatedMcpDispatch = (
  authentication: AuthenticatedSpace,
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
    await dispatch(outcome.authentication, response);
  };
}

function sendJson(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(body);
}
