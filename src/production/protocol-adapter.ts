import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const HANDOFF_CODE_INPUT = z.string().length(6).regex(/^[0-9A-Za-z]{6}$/);
const HANDOFF_CODE_OUTPUT = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{6}$/);
const POSITIVE_INTEGER = z.number().int().positive();

const revisionSnapshotSchema = z.object({
  ok: z.literal(true),
  code: HANDOFF_CODE_OUTPUT,
  revision: POSITIVE_INTEGER,
  latestRevision: POSITIVE_INTEGER,
  isLatest: z.boolean(),
  markdown: z.string(),
  contentSanitized: z.boolean(),
  redactionCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: false }),
  expiresAt: z.string().datetime({ offset: false }),
});

const handoffNotFoundSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.literal("HANDOFF_NOT_FOUND"),
    handoffCode: HANDOFF_CODE_OUTPUT,
  }),
});

const revisionConflictSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.literal("REVISION_CONFLICT"),
    expectedRevision: POSITIVE_INTEGER,
    receivedBaseRevision: POSITIVE_INTEGER,
  }),
});

const revisionLimitReachedSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.literal("REVISION_LIMIT_REACHED"),
    limit: z.literal(25),
  }),
});

const spaceQuotaExceededSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.literal("SPACE_QUOTA_EXCEEDED"),
    quota: z.enum(["handoffs", "retainedMarkdown"]),
  }),
});

const contentTooLargeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.literal("CONTENT_TOO_LARGE"),
    limitBytes: z.literal(262144),
  }),
});

const rateLimitedSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.literal("RATE_LIMITED"),
    retryAfterSeconds: POSITIVE_INTEGER,
  }),
});

const internalErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.literal("INTERNAL_ERROR"),
    requestId: z.string().min(1),
  }),
});

const createHandoffResultSchema = z.union([
  revisionSnapshotSchema,
  spaceQuotaExceededSchema,
  contentTooLargeSchema,
  rateLimitedSchema,
  internalErrorSchema,
]);

const getHandoffResultSchema = z.union([
  revisionSnapshotSchema,
  handoffNotFoundSchema,
  rateLimitedSchema,
  internalErrorSchema,
]);

const appendRevisionResultSchema = z.union([
  revisionSnapshotSchema,
  handoffNotFoundSchema,
  revisionConflictSchema,
  revisionLimitReachedSchema,
  spaceQuotaExceededSchema,
  contentTooLargeSchema,
  rateLimitedSchema,
  internalErrorSchema,
]);

const createHandoffInputSchema = z.object({ markdown: z.string().min(1) });
const getHandoffInputSchema = z.object({
  code: HANDOFF_CODE_INPUT,
  revision: z.union([POSITIVE_INTEGER, z.literal("latest")]).default("latest"),
});
const appendRevisionInputSchema = z.object({
  code: HANDOFF_CODE_INPUT,
  baseRevision: POSITIVE_INTEGER,
  markdown: z.string().min(1),
});

export type CreateHandoffResult = z.infer<typeof createHandoffResultSchema>;
export type GetHandoffResult = z.infer<typeof getHandoffResultSchema>;
export type AppendRevisionResult = z.infer<typeof appendRevisionResultSchema>;
export type ToolResult = CreateHandoffResult | GetHandoffResult | AppendRevisionResult;

export interface ProtocolToolHandlers {
  createHandoff(input: z.output<typeof createHandoffInputSchema>): Promise<CreateHandoffResult>;
  getHandoff(input: z.output<typeof getHandoffInputSchema>): Promise<GetHandoffResult>;
  appendRevision(input: z.output<typeof appendRevisionInputSchema>): Promise<AppendRevisionResult>;
}

function encodeToolResult<Result extends ToolResult>(result: Result) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    ...(result.ok ? {} : { isError: true as const }),
  };
}

export function createProtocolServer(handlers: ProtocolToolHandlers): McpServer {
  const server = new McpServer({ name: "taskdrop", version: "0.0.0" });

  server.registerTool(
    "create_handoff",
    {
      inputSchema: createHandoffInputSchema,
      outputSchema: createHandoffResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (input) => encodeToolResult(await handlers.createHandoff(input)),
  );

  server.registerTool(
    "get_handoff",
    {
      inputSchema: getHandoffInputSchema,
      outputSchema: getHandoffResultSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => encodeToolResult(await handlers.getHandoff(input)),
  );

  server.registerTool(
    "append_revision",
    {
      inputSchema: appendRevisionInputSchema,
      outputSchema: appendRevisionResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (input) => encodeToolResult(await handlers.appendRevision(input)),
  );

  return server;
}
