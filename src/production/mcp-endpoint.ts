import type { ServerResponse } from "node:http";

import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  type AuthInfo,
  type McpRequestContext,
} from "@modelcontextprotocol/server";

import type { HandoffApplication } from "./handoff-application.js";
import type {
  AuthenticatedSpace,
  SanitizedMcpRequest,
} from "./mcp-http-auth.js";
import {
  createProtocolServer,
  type ProtocolToolHandlers,
} from "./protocol-adapter.js";

const AUTHENTICATED_TOKEN_PLACEHOLDER = "taskdrop-credential-removed";

export interface McpEndpoint {
  dispatch(
    authentication: AuthenticatedSpace,
    request: SanitizedMcpRequest,
    response: ServerResponse,
  ): Promise<void>;
  close(): Promise<void>;
}

export function createMcpEndpoint(application: HandoffApplication): McpEndpoint {
  const handler = createMcpHandler(
    (context) => createRequestProtocolServer(context, application),
    { legacy: "stateless" },
  );
  const nodeHandler = toNodeHandler(handler);

  return {
    async dispatch(authentication, request, response): Promise<void> {
      const auth: AuthInfo = {
        token: AUTHENTICATED_TOKEN_PLACEHOLDER,
        clientId: "taskdrop",
        scopes: [],
        extra: { authenticatedSpace: authentication },
      };
      await nodeHandler(
        {
          ...(request.method === undefined ? {} : { method: request.method }),
          url: request.url,
          headers: request.headers,
          auth,
          [Symbol.asyncIterator](): AsyncIterator<unknown> {
            return request[Symbol.asyncIterator]();
          },
        },
        response,
      );
    },
    close: () => handler.close(),
  };
}

function createRequestProtocolServer(
  context: McpRequestContext,
  application: HandoffApplication,
) {
  const authentication = readAuthenticatedSpace(context.authInfo);
  const notImplemented = async (): Promise<never> => {
    throw new Error("tool is not implemented in the current production slice");
  };
  const handlers: ProtocolToolHandlers = {
    createHandoff: ({ markdown }) =>
      application.createHandoff({
        spaceId: authentication.spaceId,
        markdown,
      }),
    getHandoff: notImplemented,
    appendRevision: notImplemented,
  };
  return createProtocolServer(handlers);
}

function readAuthenticatedSpace(authInfo: AuthInfo | undefined): AuthenticatedSpace {
  const value = authInfo?.extra?.authenticatedSpace;
  if (
    typeof value !== "object" ||
    value === null ||
    !("spaceId" in value) ||
    !(value.spaceId instanceof Uint8Array) ||
    !("spaceFingerprint" in value) ||
    typeof value.spaceFingerprint !== "string" ||
    !("carrier" in value) ||
    (value.carrier !== "bearer" && value.carrier !== "query" && value.carrier !== "both")
  ) {
    throw new Error("authenticated Space context is missing");
  }
  return value as AuthenticatedSpace;
}
