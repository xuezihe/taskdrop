import type { IncomingHttpHeaders } from "node:http";

import { deriveSpaceFingerprint, deriveSpaceId, parseSpaceKey } from "./space-identity.js";

export type CredentialCarrier = "bearer" | "query" | "both";

export interface AuthenticatedSpace {
  readonly spaceId: Uint8Array;
  readonly spaceFingerprint: string;
  readonly carrier: CredentialCarrier;
}

export type McpCredentialRequest = {
  readonly url?: string | undefined;
  readonly headers: IncomingHttpHeaders;
};

export type McpCredentialOutcome =
  | { readonly kind: "not-mcp-path" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "authenticated"; readonly authentication: AuthenticatedSpace };

export async function authenticateMcpCredential(
  request: McpCredentialRequest,
): Promise<McpCredentialOutcome> {
  const requestUrl = new URL(request.url ?? "/", "http://taskdrop.invalid");
  if (requestUrl.pathname !== "/mcp") {
    return { kind: "not-mcp-path" };
  }

  const bearer = readBearer(request.headers.authorization);
  const query = readQueryCredential(requestUrl);
  if (bearer === "malformed" || query === "malformed") {
    return { kind: "unauthenticated" };
  }
  if (bearer && query && bearer !== query) {
    return { kind: "unauthenticated" };
  }

  const credential = bearer ?? query;
  if (!credential) {
    return { kind: "unauthenticated" };
  }

  try {
    const keyBytes = parseSpaceKey(credential);
    const spaceId = await deriveSpaceId(keyBytes);
    const spaceFingerprint = await deriveSpaceFingerprint(spaceId);
    return {
      kind: "authenticated",
      authentication: {
        spaceId,
        spaceFingerprint,
        carrier: bearer && query ? "both" : bearer ? "bearer" : "query",
      },
    };
  } catch {
    return { kind: "unauthenticated" };
  }
}

function readBearer(value: string | string[] | undefined): string | "malformed" | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return "malformed";
  const match = /^Bearer ([^\s]+)$/i.exec(value);
  return match?.[1] ?? "malformed";
}

function readQueryCredential(url: URL): string | "malformed" | undefined {
  const values = url.searchParams.getAll("taskdropKey");
  if (values.length === 0) return undefined;
  if (values.length !== 1) return "malformed";
  return values[0] ?? "malformed";
}
