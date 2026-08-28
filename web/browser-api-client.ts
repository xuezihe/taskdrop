import { z } from "zod";

import type { EditSurface } from "./working-draft.js";

const revisionSnapshotSchema = z
  .object({
    ok: z.literal(true),
    code: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{6}$/),
    revision: z.number().int().positive().refine(Number.isSafeInteger),
    latestRevision: z.number().int().positive().refine(Number.isSafeInteger),
    isLatest: z.boolean(),
    markdown: z.string(),
    contentSanitized: z.boolean(),
    redactionCount: z.number().int().nonnegative().refine(Number.isSafeInteger),
    origin: z.enum(["mcp", "human", "webmcp"]),
    createdAt: z.string().datetime({ offset: false }),
    expiresAt: z.string().datetime({ offset: false }),
  })
  .strict();

const browserApiErrorSchema = z.union([
  z.object({ code: z.literal("UNAUTHORIZED") }).strict(),
  z.object({ code: z.literal("INVALID_REQUEST") }).strict(),
  z.object({ code: z.literal("EMPTY_MARKDOWN") }).strict(),
  z.object({ code: z.literal("HANDOFF_NOT_FOUND"), handoffCode: z.string() }).strict(),
  z
    .object({
      code: z.literal("REVISION_CONFLICT"),
      expectedRevision: z.number().int().positive().refine(Number.isSafeInteger),
      receivedBaseRevision: z.number().int().positive().refine(Number.isSafeInteger),
    })
    .strict(),
  z
    .object({
      code: z.literal("REVISION_LIMIT_REACHED"),
      limit: z.number().int().positive().refine(Number.isSafeInteger),
    })
    .strict(),
  z
    .object({
      code: z.literal("SPACE_QUOTA_EXCEEDED"),
      quota: z.enum(["handoffs", "retainedMarkdown"]),
    })
    .strict(),
  z
    .object({
      code: z.literal("CONTENT_TOO_LARGE"),
      limitBytes: z.number().int().positive().refine(Number.isSafeInteger),
    })
    .strict(),
  z.object({ code: z.literal("METHOD_NOT_ALLOWED") }).strict(),
  z.object({ code: z.literal("NOT_FOUND") }).strict(),
  z.object({ code: z.literal("INTERNAL_ERROR"), requestId: z.string().uuid() }).strict(),
]);

const browserApiResultSchema = z.union([
  revisionSnapshotSchema,
  z.object({ ok: z.literal(false), error: browserApiErrorSchema }).strict(),
]);

export type BrowserRevision = z.infer<typeof revisionSnapshotSchema>;
export type BrowserApiError = z.infer<typeof browserApiErrorSchema>;
export type BrowserApiResult = z.infer<typeof browserApiResultSchema>;
export type BrowserRequest = (path: string, init?: RequestInit) => Promise<Response>;

export type BrowserClientError = { code: "NETWORK_ERROR" } | { code: "INVALID_RESPONSE" };

export type BrowserClientResult = BrowserApiResult | { ok: false; error: BrowserClientError };

export interface BrowserApiClient {
  getCurrent(code: string): Promise<BrowserClientResult>;
  appendRevision(input: {
    code: string;
    baseRevision: number;
    markdown: string;
    origin: EditSurface;
  }): Promise<BrowserClientResult>;
}

const defaultRequest: BrowserRequest = (path, init) => globalThis.fetch(path, init);

export function createBrowserApiClient(
  spaceKey: string,
  request: BrowserRequest = defaultRequest,
): BrowserApiClient {
  const authenticatedRequest = (path: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${spaceKey}`);
    return request(path, { ...init, headers });
  };

  return {
    getCurrent: (code) =>
      readResult(authenticatedRequest(`/api/handoffs/${encodeURIComponent(code)}`)),
    appendRevision: ({ code, baseRevision, markdown, origin }) =>
      readResult(
        authenticatedRequest(`/api/handoffs/${encodeURIComponent(code)}/revisions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseRevision, markdown, origin }),
        }),
      ),
  };
}

async function readResult(responsePromise: Promise<Response>): Promise<BrowserClientResult> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    return { ok: false, error: { code: "NETWORK_ERROR" } };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: { code: "INVALID_RESPONSE" } };
  }

  const parsed = browserApiResultSchema.safeParse(body);
  return parsed.success ? parsed.data : { ok: false, error: { code: "INVALID_RESPONSE" } };
}
