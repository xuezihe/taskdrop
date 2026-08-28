import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import {
  createProtocolServer,
  type ProtocolToolHandlers,
  type ToolResult,
} from "../src/production/protocol-adapter.js";

const UNEXPECTED_HANDLER_REQUEST_ID = "00000000-0000-4000-8000-000000000000";
const unexpectedHandlerResult = {
  ok: false,
  error: { code: "INTERNAL_ERROR", requestId: UNEXPECTED_HANDLER_REQUEST_ID },
} as const satisfies ToolResult;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonSchema = {
  anyOf?: JsonSchema[];
  const?: unknown;
  enum?: unknown[];
  exclusiveMinimum?: number;
  format?: string;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  type?: string;
};

function asJsonSchema(value: unknown): JsonSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON Schema object");
  }
  return value as JsonSchema;
}

function outputVariants(value: unknown) {
  const variants = asJsonSchema(value).anyOf;
  if (!variants) throw new Error("Expected an output-schema union");

  return variants.map((variant) => {
    const properties = asJsonSchema(variant).properties ?? {};
    const errorProperties = properties.error
      ? (asJsonSchema(properties.error).properties ?? {})
      : {};

    return {
      ok: properties.ok?.const,
      fields: Object.keys(properties).sort(),
      errorCode: errorProperties.code?.const,
      errorFields: Object.keys(errorProperties).sort(),
    };
  });
}

function errorProperties(value: unknown, code: string): Record<string, JsonSchema> {
  const variant = asJsonSchema(value).anyOf?.find((candidate) => {
    const error = asJsonSchema(candidate).properties?.error;
    return error && asJsonSchema(error).properties?.code?.const === code;
  });
  if (!variant) throw new Error(`Expected ${code} output variant`);

  return asJsonSchema(asJsonSchema(variant).properties?.error).properties ?? {};
}

function createHandlers(overrides: Partial<ProtocolToolHandlers>): ProtocolToolHandlers {
  const unexpectedHandler = async () => unexpectedHandlerResult;

  return {
    createHandoff: unexpectedHandler,
    getHandoff: unexpectedHandler,
    appendRevision: unexpectedHandler,
    ...overrides,
  };
}

async function withProtocolClient(
  overrides: Partial<ProtocolToolHandlers>,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const server = createProtocolServer(createHandlers(overrides));
  const client = new Client({ name: "protocol-adapter-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await run(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

describe("Production MCP protocol adapter", () => {
  it("keeps schema-invalid arguments in the SDK validation result, not a domain result", async () => {
    await withProtocolClient({}, async (client) => {
      for (const request of [
        { name: "create_handoff", arguments: {} },
        { name: "create_handoff", arguments: { markdown: "" } },
        { name: "get_handoff", arguments: { code: "ABCDE" } },
        { name: "get_handoff", arguments: { code: "ABCDEF", revision: "current" } },
        {
          name: "append_revision",
          arguments: { code: "ABCDEF", baseRevision: 0, markdown: "valid Markdown" },
        },
      ]) {
        const result = await client.callTool(request);

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(result.content).toEqual([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Input validation error"),
          }),
        ]);
        expect(JSON.stringify(result)).not.toContain(UNEXPECTED_HANDLER_REQUEST_ID);
      }
    });
  });

  it("lists the authoritative three-tool contract", async () => {
    await withProtocolClient({}, async (client) => {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      expect([...byName.keys()].sort()).toEqual([
        "append_revision",
        "create_handoff",
        "get_handoff",
      ]);
      expect(byName.get("create_handoff")).toMatchObject({
        inputSchema: {
          properties: { markdown: { type: "string", minLength: 1 } },
          required: ["markdown"],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      });
      expect(byName.get("get_handoff")).toMatchObject({
        inputSchema: {
          properties: {
            code: { type: "string", minLength: 6, maxLength: 6, pattern: "^[0-9A-TV-Za-tv-z]{6}$" },
            revision: {
              default: "latest",
              anyOf: [
                { type: "integer", exclusiveMinimum: 0 },
                { type: "string", const: "latest" },
              ],
            },
          },
          required: ["code"],
        },
        annotations: { readOnlyHint: true },
      });
      expect(byName.get("append_revision")).toMatchObject({
        inputSchema: {
          properties: {
            code: { type: "string", minLength: 6, maxLength: 6, pattern: "^[0-9A-TV-Za-tv-z]{6}$" },
            baseRevision: { type: "integer", exclusiveMinimum: 0 },
            markdown: { type: "string", minLength: 1 },
          },
          required: ["code", "baseRevision", "markdown"],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
        },
      });

      const successVariant = {
        ok: true,
        fields: [
          "code",
          "contentSanitized",
          "createdAt",
          "expiresAt",
          "isLatest",
          "latestRevision",
          "markdown",
          "ok",
          "origin",
          "redactionCount",
          "revision",
        ],
        errorCode: undefined,
        errorFields: [],
      };
      const errorVariant = (errorCode: string, errorFields: string[]) => ({
        ok: false,
        fields: ["error", "ok"],
        errorCode,
        errorFields,
      });

      expect(outputVariants(byName.get("create_handoff")?.outputSchema)).toEqual([
        successVariant,
        errorVariant("SPACE_QUOTA_EXCEEDED", ["code", "quota"]),
        errorVariant("CONTENT_TOO_LARGE", ["code", "limitBytes"]),
        errorVariant("RATE_LIMITED", ["code", "retryAfterSeconds"]),
        errorVariant("INTERNAL_ERROR", ["code", "requestId"]),
      ]);
      expect(outputVariants(byName.get("get_handoff")?.outputSchema)).toEqual([
        successVariant,
        errorVariant("HANDOFF_NOT_FOUND", ["code", "handoffCode"]),
        errorVariant("RATE_LIMITED", ["code", "retryAfterSeconds"]),
        errorVariant("INTERNAL_ERROR", ["code", "requestId"]),
      ]);
      expect(outputVariants(byName.get("append_revision")?.outputSchema)).toEqual([
        successVariant,
        errorVariant("HANDOFF_NOT_FOUND", ["code", "handoffCode"]),
        errorVariant("REVISION_CONFLICT", ["code", "expectedRevision", "receivedBaseRevision"]),
        errorVariant("REVISION_LIMIT_REACHED", ["code", "limit"]),
        errorVariant("SPACE_QUOTA_EXCEEDED", ["code", "quota"]),
        errorVariant("CONTENT_TOO_LARGE", ["code", "limitBytes"]),
        errorVariant("RATE_LIMITED", ["code", "retryAfterSeconds"]),
        errorVariant("INTERNAL_ERROR", ["code", "requestId"]),
      ]);

      const successSchema = asJsonSchema(
        asJsonSchema(byName.get("create_handoff")?.outputSchema).anyOf?.[0],
      );
      expect(successSchema.properties).toMatchObject({
        code: { type: "string", pattern: "^[0-9A-HJKMNP-TV-Z]{6}$" },
        revision: { type: "integer", exclusiveMinimum: 0 },
        latestRevision: { type: "integer", exclusiveMinimum: 0 },
        isLatest: { type: "boolean" },
        markdown: { type: "string" },
        contentSanitized: { type: "boolean" },
        redactionCount: { type: "integer", minimum: 0 },
        origin: { type: "string", enum: ["mcp", "human", "webmcp"] },
        createdAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
      });
      expect(
        errorProperties(byName.get("get_handoff")?.outputSchema, "HANDOFF_NOT_FOUND"),
      ).toMatchObject({
        handoffCode: { type: "string", pattern: "^[0-9A-HJKMNP-TV-Z]{6}$" },
      });
      expect(
        errorProperties(byName.get("append_revision")?.outputSchema, "REVISION_CONFLICT"),
      ).toMatchObject({
        expectedRevision: { type: "integer", exclusiveMinimum: 0 },
        receivedBaseRevision: { type: "integer", exclusiveMinimum: 0 },
      });
      expect(
        errorProperties(byName.get("append_revision")?.outputSchema, "REVISION_LIMIT_REACHED"),
      ).toMatchObject({
        limit: { type: "number", const: 25 },
      });
      expect(
        errorProperties(byName.get("create_handoff")?.outputSchema, "SPACE_QUOTA_EXCEEDED"),
      ).toMatchObject({
        quota: { type: "string", enum: ["handoffs", "retainedMarkdown"] },
      });
      expect(
        errorProperties(byName.get("create_handoff")?.outputSchema, "CONTENT_TOO_LARGE"),
      ).toMatchObject({
        limitBytes: { type: "number", const: 262144 },
      });
      expect(
        errorProperties(byName.get("get_handoff")?.outputSchema, "RATE_LIMITED"),
      ).toMatchObject({
        retryAfterSeconds: { type: "integer", exclusiveMinimum: 0 },
      });
      expect(
        errorProperties(byName.get("append_revision")?.outputSchema, "INTERNAL_ERROR"),
      ).toMatchObject({
        requestId: { type: "string", format: "uuid" },
      });
    });
  });

  it("routes an omitted revision as the latest selector and encodes a success twice", async () => {
    const success = {
      ok: true as const,
      code: "7Q3K9F",
      revision: 2,
      latestRevision: 2,
      isLatest: true,
      markdown: "# Current handoff",
      contentSanitized: false,
      redactionCount: 0,
      origin: "mcp" as const,
      createdAt: "2026-08-07T08:00:00Z",
      expiresAt: "2026-08-14T08:00:00Z",
    };
    await withProtocolClient(
      {
        getHandoff: async ({ revision }) =>
          revision === "latest" ? success : unexpectedHandlerResult,
      },
      async (client) => {
        const result = await client.callTool({
          name: "get_handoff",
          arguments: { code: "7Q3K9F" },
        });

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual(success);
        expect(result.content).toEqual([
          {
            type: "text",
            text: JSON.stringify(success),
          },
        ]);
      },
    );
  });

  it("encodes a domain failure as an isError tool result", async () => {
    const conflict = {
      ok: false as const,
      error: {
        code: "REVISION_CONFLICT" as const,
        expectedRevision: 3,
        receivedBaseRevision: 2,
      },
    };
    await withProtocolClient({ appendRevision: async () => conflict }, async (client) => {
      const result = await client.callTool({
        name: "append_revision",
        arguments: {
          code: "7Q3K9F",
          baseRevision: 2,
          markdown: "# A competing revision",
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual(conflict);
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify(conflict),
        },
      ]);
    });
  });

  it("maps independent unexpected handler failures to opaque INTERNAL_ERROR results", async () => {
    const createFailureMarker = "create database failure: SELECT secret_value";
    const appendFailureMarker = "append redaction failure with private cause";

    await withProtocolClient(
      {
        createHandoff: async () => {
          throw new Error(createFailureMarker);
        },
        appendRevision: async () => {
          throw new Error(appendFailureMarker, {
            cause: new Error("private nested cause"),
          });
        },
      },
      async (client) => {
        const results = [
          await client.callTool({
            name: "create_handoff",
            arguments: { markdown: "# Valid create" },
          }),
          await client.callTool({
            name: "append_revision",
            arguments: {
              code: "7Q3K9F",
              baseRevision: 1,
              markdown: "# Valid append",
            },
          }),
        ];

        const requestIds = results.map((result) => {
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toEqual({
            ok: false,
            error: {
              code: "INTERNAL_ERROR",
              requestId: expect.stringMatching(UUID_PATTERN),
            },
          });
          expect(JSON.stringify(result)).not.toContain(createFailureMarker);
          expect(JSON.stringify(result)).not.toContain(appendFailureMarker);
          expect(JSON.stringify(result)).not.toContain("private nested cause");

          return (
            result.structuredContent as {
              error: { requestId: string };
            }
          ).error.requestId;
        });

        expect(new Set(requestIds).size).toBe(2);
      },
    );
  });
});
