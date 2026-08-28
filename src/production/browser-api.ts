import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import { z } from "zod";

import {
  authenticateBrowserCredential,
  type AuthenticatedSpace,
  type BrowserCredentialRequest,
} from "./credential.js";
import type {
  AppendRevisionApplicationResult,
  GetHandoffApplicationResult,
  GetRevisionHistoryApplicationResult,
  HandoffApplication,
} from "./handoff-application.js";
import { MAX_MARKDOWN_BYTES } from "./handoff-limits.js";

const BROWSER_API_PREFIX = "/api/";
const HANDOFF_CODE_PATTERN = /^[0-9A-TV-Za-tv-z]{6}$/;
const MAX_BROWSER_BODY_BYTES = MAX_MARKDOWN_BYTES * 8;

type ApplicationResult =
  | AppendRevisionApplicationResult
  | GetHandoffApplicationResult
  | GetRevisionHistoryApplicationResult;
type ApplicationErrorResult = Extract<ApplicationResult, { ok: false }>;
type BrowserApiErrorResult =
  | { ok: false; error: { code: "UNAUTHORIZED" } }
  | { ok: false; error: { code: "INVALID_REQUEST" } }
  | { ok: false; error: { code: "EMPTY_MARKDOWN" } }
  | { ok: false; error: { code: "METHOD_NOT_ALLOWED" } }
  | { ok: false; error: { code: "NOT_FOUND" } }
  | { ok: false; error: { code: "INTERNAL_ERROR"; requestId: string } }
  | ApplicationErrorResult;
type BrowserApiSuccess = Extract<ApplicationResult, { ok: true }>;
type BrowserApiResult = BrowserApiSuccess | BrowserApiErrorResult;

const INVALID_REQUEST: BrowserApiErrorResult = {
  ok: false,
  error: { code: "INVALID_REQUEST" },
};
const EMPTY_MARKDOWN: BrowserApiErrorResult = {
  ok: false,
  error: { code: "EMPTY_MARKDOWN" },
};
const METHOD_NOT_ALLOWED: BrowserApiErrorResult = {
  ok: false,
  error: { code: "METHOD_NOT_ALLOWED" },
};
const NOT_FOUND: BrowserApiErrorResult = {
  ok: false,
  error: { code: "NOT_FOUND" },
};
const UNAUTHORIZED: BrowserApiErrorResult = {
  ok: false,
  error: { code: "UNAUTHORIZED" },
};

const appendBodySchema = z
  .object({
    baseRevision: z.number().int().positive().refine(Number.isSafeInteger),
    markdown: z.string(),
    origin: z.enum(["human", "webmcp"]),
  })
  .strict();

type BrowserRoute =
  | { kind: "current"; code: string }
  | { kind: "collection"; code: string }
  | { kind: "historical"; code: string; revision: number };

type RouteParseResult =
  | { kind: "route"; route: BrowserRoute }
  | { kind: "invalid" }
  | { kind: "not-found" };

export function createBrowserApiHandler(application: HandoffApplication): RequestListener {
  return async (request, response): Promise<void> => {
    try {
      const parsedRoute = parseRoute(request.url);
      if (parsedRoute.kind === "not-found") {
        sendJson(response, 404, NOT_FOUND);
        return;
      }
      if (parsedRoute.kind === "invalid") {
        sendJson(response, 400, INVALID_REQUEST);
        return;
      }

      const authentication = await authenticateBrowserCredential(browserCredentialRequest(request));
      if (authentication.kind === "unauthenticated") {
        sendJson(response, 401, UNAUTHORIZED);
        return;
      }

      const route = resolveMethod(parsedRoute.route, request.method);
      if (route.kind === "method-not-allowed") {
        sendJson(response, 405, METHOD_NOT_ALLOWED);
        return;
      }

      const result =
        route.kind === "current"
          ? await application.getHandoff({
              spaceId: authentication.authentication.spaceId,
              code: route.code,
              revision: "latest",
            })
          : route.kind === "historical"
            ? await application.getHandoff({
                spaceId: authentication.authentication.spaceId,
                code: route.code,
                revision: route.revision,
              })
            : route.kind === "history"
              ? await application.getRevisionHistory({
                  spaceId: authentication.authentication.spaceId,
                  code: route.code,
                })
              : await appendRevision(application, authentication.authentication, route, request);

      sendResult(response, result);
    } catch {
      sendJson(response, 500, {
        ok: false,
        error: { code: "INTERNAL_ERROR", requestId: randomUUID() },
      });
    }
  };
}

export function isBrowserApiPath(url: string | undefined): boolean {
  try {
    return new URL(url ?? "/", "http://taskdrop.invalid").pathname.startsWith(BROWSER_API_PREFIX);
  } catch {
    return false;
  }
}

function browserCredentialRequest(request: IncomingMessage): BrowserCredentialRequest {
  return { url: request.url, headers: request.headers };
}

function parseRoute(url: string | undefined): RouteParseResult {
  let pathname: string;
  try {
    pathname = new URL(url ?? "/", "http://taskdrop.invalid").pathname;
  } catch {
    return { kind: "not-found" };
  }
  if (!pathname.startsWith(BROWSER_API_PREFIX)) return { kind: "not-found" };

  const segments = pathname.split("/");
  if (segments[1] !== "api" || segments[2] !== "handoffs") {
    return { kind: "not-found" };
  }

  const code = decodePathSegment(segments[3]);
  if (code === null || !HANDOFF_CODE_PATTERN.test(code)) return { kind: "invalid" };
  if (segments.length === 4) return { kind: "route", route: { kind: "current", code } };
  if (segments.length === 5 && segments[4] === "revisions") {
    return { kind: "route", route: { kind: "collection", code } };
  }
  if (segments.length !== 6 || segments[4] !== "revisions") return { kind: "not-found" };

  const revisionSegment = decodePathSegment(segments[5]);
  if (revisionSegment === null || !/^[1-9][0-9]*$/.test(revisionSegment)) {
    return { kind: "invalid" };
  }
  const revision = Number(revisionSegment);
  if (!Number.isSafeInteger(revision)) return { kind: "invalid" };
  return { kind: "route", route: { kind: "historical", code, revision } };
}

function decodePathSegment(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

type ResolvedRoute =
  | { kind: "current"; code: string }
  | { kind: "history"; code: string }
  | { kind: "historical"; code: string; revision: number }
  | { kind: "append"; code: string }
  | { kind: "method-not-allowed" };

function resolveMethod(route: BrowserRoute, method: string | undefined): ResolvedRoute {
  const normalizedMethod = method?.toUpperCase();
  if (route.kind === "current") {
    return normalizedMethod === "GET" ? route : { kind: "method-not-allowed" };
  }
  if (route.kind === "historical") {
    return normalizedMethod === "GET" ? route : { kind: "method-not-allowed" };
  }
  if (normalizedMethod === "GET") return { kind: "history", code: route.code };
  if (normalizedMethod === "POST") return { kind: "append", code: route.code };
  return { kind: "method-not-allowed" };
}

async function appendRevision(
  application: HandoffApplication,
  authentication: AuthenticatedSpace,
  route: { kind: "append"; code: string },
  request: IncomingMessage,
): Promise<AppendRevisionApplicationResult | BrowserApiErrorResult> {
  const parsedBody = await parseAppendBody(request);
  if (!parsedBody.ok) return parsedBody;
  return application.appendRevision({
    spaceId: authentication.spaceId,
    code: route.code,
    baseRevision: parsedBody.value.baseRevision,
    markdown: parsedBody.value.markdown,
    origin: parsedBody.value.origin,
  });
}

type AppendBody = z.infer<typeof appendBodySchema>;
type ParsedAppendBody = { ok: true; value: AppendBody } | BrowserApiErrorResult;

async function parseAppendBody(request: IncomingMessage): Promise<ParsedAppendBody> {
  if (!isJsonContentType(request.headers["content-type"])) return INVALID_REQUEST;

  const body = await readBody(request);
  if (body === "too-large") {
    return {
      ok: false,
      error: { code: "CONTENT_TOO_LARGE", limitBytes: MAX_MARKDOWN_BYTES },
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return INVALID_REQUEST;
  }

  const parsed = appendBodySchema.safeParse(value);
  if (!parsed.success) return INVALID_REQUEST;
  if (parsed.data.markdown.length === 0) return EMPTY_MARKDOWN;
  return { ok: true, value: parsed.data };
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  if (typeof value !== "string") return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function readBody(request: IncomingMessage): Promise<string | "too-large"> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_BROWSER_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(bytes);
  }
  if (tooLarge) return "too-large";
  return Buffer.concat(chunks).toString("utf8");
}

function sendResult(response: ServerResponse, result: BrowserApiResult): void {
  sendJson(response, result.ok ? 200 : statusForError(result), result);
}

function statusForError(result: BrowserApiErrorResult): number {
  switch (result.error.code) {
    case "UNAUTHORIZED":
      return 401;
    case "INVALID_REQUEST":
      return 400;
    case "EMPTY_MARKDOWN":
      return 422;
    case "HANDOFF_NOT_FOUND":
      return 404;
    case "REVISION_CONFLICT":
    case "REVISION_LIMIT_REACHED":
    case "SPACE_QUOTA_EXCEEDED":
      return 409;
    case "CONTENT_TOO_LARGE":
      return 413;
    case "METHOD_NOT_ALLOWED":
      return 405;
    case "NOT_FOUND":
      return 404;
    case "INTERNAL_ERROR":
      return 500;
  }
}

function sendJson(response: ServerResponse, status: number, result: object): void {
  const body = JSON.stringify(result);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}
