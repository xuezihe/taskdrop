import { createHash } from "node:crypto";

export type CredentialCarrier = "bearer" | "query" | "both";

export type CredentialInput = {
  authorizationHeader?: string | undefined;
  queryCredential?: string | undefined;
};

export type CredentialResult =
  | {
      ok: true;
      carrier: CredentialCarrier;
      fingerprint: string;
    }
  | {
      ok: false;
      reason: "missing" | "malformed-authorization" | "invalid-format" | "conflicting";
    };

// PROTOTYPE ASSUMPTION: 32 random bytes encoded as unpadded Base64URL, with a
// visible TaskDrop prefix. P1 tests transport behavior, not the final prefix.
const SPACE_KEY_PATTERN = /^tdp_[A-Za-z0-9_-]{43}$/;

export function resolveCredential(input: CredentialInput): CredentialResult {
  const bearer = readBearer(input.authorizationHeader);

  if (bearer === "malformed") {
    return { ok: false, reason: "malformed-authorization" };
  }

  const query = input.queryCredential;

  if (bearer && query && bearer !== query) {
    return { ok: false, reason: "conflicting" };
  }

  const credential = bearer ?? query;

  if (!credential) {
    return { ok: false, reason: "missing" };
  }

  if (!SPACE_KEY_PATTERN.test(credential)) {
    return { ok: false, reason: "invalid-format" };
  }

  return {
    ok: true,
    carrier: bearer && query ? "both" : bearer ? "bearer" : "query",
    fingerprint: fingerprintCredential(credential),
  };
}

function readBearer(authorizationHeader: string | undefined): string | "malformed" | undefined {
  if (!authorizationHeader) {
    return undefined;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorizationHeader);
  return match?.[1] ?? "malformed";
}

function fingerprintCredential(credential: string): string {
  return createHash("sha256").update(credential).digest("base64url").slice(0, 12);
}
