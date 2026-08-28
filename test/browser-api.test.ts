import { createServer, type Server } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { createBrowserApiHandler } from "../src/production/browser-api.js";
import type {
  AppendRevisionApplicationResult,
  HandoffApplication,
} from "../src/production/handoff-application.js";
import type {
  GetHandoffStoreResult,
  GetRevisionHistoryStoreResult,
  HandoffStoreResult,
  RevisionHistorySnapshot,
  RevisionSnapshot,
} from "../src/production/handoff-store.js";
import { deriveSpaceId, formatSpaceKey, parseSpaceKey } from "../src/production/space-identity.js";

const SPACE_KEY = formatSpaceKey(new Uint8Array(32));
const OTHER_SPACE_KEY = formatSpaceKey(new Uint8Array(32).fill(1));

function snapshot(overrides: Partial<RevisionSnapshot> = {}): RevisionSnapshot {
  return {
    ok: true,
    code: "ABC001",
    revision: 1,
    latestRevision: 1,
    isLatest: true,
    markdown: "# Handoff",
    contentSanitized: false,
    redactionCount: 0,
    origin: "mcp",
    createdAt: "2026-08-28T08:00:00.000Z",
    expiresAt: "2026-08-29T08:00:00.000Z",
    ...overrides,
  };
}

function history(): RevisionHistorySnapshot {
  return {
    ok: true,
    code: "ABC001",
    latestRevision: 2,
    expiresAt: "2026-08-29T08:00:00.000Z",
    revisions: [
      { revision: 2, origin: "human", createdAt: "2026-08-28T09:00:00.000Z" },
      { revision: 1, origin: "mcp", createdAt: "2026-08-28T08:00:00.000Z" },
    ],
  };
}

function uncalled<T>(): () => Promise<T> {
  return async () => {
    throw new Error("unexpected Application call");
  };
}

function createApplication(overrides: Partial<HandoffApplication> = {}): HandoffApplication {
  return {
    createHandoff: uncalled<never>(),
    getHandoff: uncalled<never>(),
    getRevisionHistory: uncalled<never>(),
    appendRevision: uncalled<never>(),
    ...overrides,
  };
}

async function withServer(
  application: HandoffApplication,
  run: (endpoint: string) => Promise<void>,
): Promise<void> {
  const server = createServer(createBrowserApiHandler(application));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("test server did not bind a TCP port");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await closeServer(server);
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function readResponse(response: Response): Promise<unknown> {
  return response.json();
}

function bearerHeaders(spaceKey = SPACE_KEY): HeadersInit {
  return { authorization: `Bearer ${spaceKey}` };
}

describe("Browser API HTTP adapter", () => {
  it("dispatches all committed-state routes through the Application seam", async () => {
    const current = snapshot();
    const historical = snapshot({
      revision: 1,
      latestRevision: 2,
      isLatest: false,
      markdown: "# Original",
    });
    const revisionHistory = history();
    const getHandoff = vi.fn(
      async (
        input: Parameters<HandoffApplication["getHandoff"]>[0],
      ): Promise<GetHandoffStoreResult> => {
        expect(input.spaceId).toEqual(await expectSpaceId());
        expect(input.code).toBe("abc0oi");
        return input.revision === "latest" ? current : historical;
      },
    );
    const getRevisionHistory = vi.fn(
      async (
        input: Parameters<HandoffApplication["getRevisionHistory"]>[0],
      ): Promise<GetRevisionHistoryStoreResult> => {
        expect(input.spaceId).toEqual(await expectSpaceId());
        expect(input.code).toBe("abc0oi");
        return revisionHistory;
      },
    );
    const appendRevision = vi.fn(
      async (
        input: Parameters<HandoffApplication["appendRevision"]>[0],
      ): Promise<HandoffStoreResult> => {
        expect(input.spaceId).toEqual(await expectSpaceId());
        expect(input.code).toBe("abc0oi");
        expect(input.baseRevision).toBe(1);
        expect(input.markdown).toBe("# Updated");
        expect(input.origin).toBe("human");
        return snapshot({ revision: 2, latestRevision: 2, markdown: "# Updated", origin: "human" });
      },
    );
    const application = createApplication({ getHandoff, getRevisionHistory, appendRevision });

    await withServer(application, async (endpoint) => {
      const currentResponse = await fetch(`${endpoint}/api/handoffs/abc0oi`, {
        headers: bearerHeaders(),
      });
      expect(currentResponse.status).toBe(200);
      await expect(readResponse(currentResponse)).resolves.toEqual(current);

      const historyResponse = await fetch(`${endpoint}/api/handoffs/abc0oi/revisions`, {
        headers: bearerHeaders(),
      });
      expect(historyResponse.status).toBe(200);
      await expect(readResponse(historyResponse)).resolves.toEqual(revisionHistory);

      const historicalResponse = await fetch(`${endpoint}/api/handoffs/abc0oi/revisions/1`, {
        headers: bearerHeaders(),
      });
      expect(historicalResponse.status).toBe(200);
      await expect(readResponse(historicalResponse)).resolves.toEqual(historical);

      const appendResponse = await fetch(`${endpoint}/api/handoffs/abc0oi/revisions`, {
        method: "POST",
        headers: { ...bearerHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 1, markdown: "# Updated", origin: "human" }),
      });
      expect(appendResponse.status).toBe(200);
      await expect(readResponse(appendResponse)).resolves.toEqual(
        snapshot({ revision: 2, latestRevision: 2, markdown: "# Updated", origin: "human" }),
      );

      for (const response of [
        currentResponse,
        historyResponse,
        historicalResponse,
        appendResponse,
      ]) {
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(response.headers.get("content-type")).toMatch(/^application\/json/);
      }
    });

    expect(getHandoff).toHaveBeenCalledTimes(2);
    expect(getRevisionHistory).toHaveBeenCalledTimes(1);
    expect(appendRevision).toHaveBeenCalledTimes(1);
  });

  it("rejects missing, malformed, invalid, and query-carried credentials before dispatch", async () => {
    const getHandoff = vi.fn(async (): Promise<GetHandoffStoreResult> => snapshot());
    const application = createApplication({ getHandoff });

    await withServer(application, async (endpoint) => {
      const requests = [
        fetch(`${endpoint}/api/handoffs/ABC001`),
        fetch(`${endpoint}/api/handoffs/ABC001`, {
          headers: { authorization: `Basic ${SPACE_KEY}` },
        }),
        fetch(`${endpoint}/api/handoffs/ABC001`, {
          headers: { authorization: "Bearer not-a-space-key" },
        }),
        fetch(`${endpoint}/api/handoffs/ABC001?taskdropKey=${SPACE_KEY}`),
        fetch(`${endpoint}/api/handoffs/ABC001?taskdropKey=${SPACE_KEY}`, {
          headers: bearerHeaders(),
        }),
        fetch(`${endpoint}/api/handoffs/ABC001?taskdropKey=${OTHER_SPACE_KEY}`, {
          headers: bearerHeaders(),
        }),
        fetch(`${endpoint}/api/handoffs/ABC001?localSpaceId=derived-locally`, {
          headers: bearerHeaders(),
        }),
      ];
      const responses = await Promise.all(requests);
      expect(responses.map(({ status }) => status)).toEqual([401, 401, 401, 401, 401, 401, 401]);
      const bodies = await Promise.all(responses.map((response) => response.text()));
      for (const body of bodies) {
        expect(JSON.parse(body) as unknown).toEqual({
          ok: false,
          error: { code: "UNAUTHORIZED" },
        });
        expect(body).not.toContain(SPACE_KEY);
      }
    });

    expect(getHandoff).not.toHaveBeenCalled();
  });

  it("returns stable validation results without dispatching invalid requests", async () => {
    const getHandoff = vi.fn(async (): Promise<GetHandoffStoreResult> => snapshot());
    const appendRevision = vi.fn(async (): Promise<HandoffStoreResult> => snapshot());
    const application = createApplication({ getHandoff, appendRevision });
    const validAppend = {
      baseRevision: 1,
      markdown: "# Updated",
      origin: "human",
    };

    await withServer(application, async (endpoint) => {
      const invalidRequests: Array<{
        response: Promise<Response>;
        status: number;
        result: unknown;
      }> = [
        {
          response: fetch(`${endpoint}/api/handoffs/ABC01`, { headers: bearerHeaders() }),
          status: 400,
          result: { ok: false, error: { code: "INVALID_REQUEST" } },
        },
        {
          response: fetch(`${endpoint}/api/handoffs/ABC001/revisions/0`, {
            headers: bearerHeaders(),
          }),
          status: 400,
          result: { ok: false, error: { code: "INVALID_REQUEST" } },
        },
        {
          response: fetch(`${endpoint}/api/handoffs/ABC001/revisions`, {
            method: "DELETE",
            headers: bearerHeaders(),
          }),
          status: 405,
          result: { ok: false, error: { code: "METHOD_NOT_ALLOWED" } },
        },
        {
          response: fetch(`${endpoint}/api/handoffs/ABC001/revisions`, {
            method: "POST",
            headers: bearerHeaders(),
            body: "not json",
          }),
          status: 400,
          result: { ok: false, error: { code: "INVALID_REQUEST" } },
        },
        {
          response: fetch(`${endpoint}/api/handoffs/ABC001/revisions`, {
            method: "POST",
            headers: { ...bearerHeaders(), "content-type": "text/plain" },
            body: JSON.stringify(validAppend),
          }),
          status: 400,
          result: { ok: false, error: { code: "INVALID_REQUEST" } },
        },
        {
          response: fetch(`${endpoint}/api/handoffs/ABC001/revisions`, {
            method: "POST",
            headers: { ...bearerHeaders(), "content-type": "application/json" },
            body: JSON.stringify({ ...validAppend, markdown: "" }),
          }),
          status: 422,
          result: { ok: false, error: { code: "EMPTY_MARKDOWN" } },
        },
        {
          response: fetch(`${endpoint}/api/handoffs/ABC001/revisions`, {
            method: "POST",
            headers: { ...bearerHeaders(), "content-type": "application/json" },
            body: JSON.stringify({ ...validAppend, origin: "mcp" }),
          }),
          status: 400,
          result: { ok: false, error: { code: "INVALID_REQUEST" } },
        },
        {
          response: fetch(`${endpoint}/api/handoffs/ABC001/revisions`, {
            method: "POST",
            headers: { ...bearerHeaders(), "content-type": "application/json" },
            body: JSON.stringify({ ...validAppend, localSpaceId: "must-be-rejected" }),
          }),
          status: 400,
          result: { ok: false, error: { code: "INVALID_REQUEST" } },
        },
        {
          response: fetch(`${endpoint}/api/unknown`, { headers: bearerHeaders() }),
          status: 404,
          result: { ok: false, error: { code: "NOT_FOUND" } },
        },
      ];

      for (const invalid of invalidRequests) {
        const response = await invalid.response;
        expect(response.status).toBe(invalid.status);
        await expect(readResponse(response)).resolves.toEqual(invalid.result);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    });

    expect(getHandoff).not.toHaveBeenCalled();
    expect(appendRevision).not.toHaveBeenCalled();
  });

  it.each([
    {
      code: "HANDOFF_NOT_FOUND",
      status: 404,
      result: {
        ok: false,
        error: { code: "HANDOFF_NOT_FOUND", handoffCode: "ABC001" },
      },
    },
    {
      code: "REVISION_CONFLICT",
      status: 409,
      result: {
        ok: false,
        error: { code: "REVISION_CONFLICT", expectedRevision: 2, receivedBaseRevision: 1 },
      },
    },
    {
      code: "REVISION_LIMIT_REACHED",
      status: 409,
      result: { ok: false, error: { code: "REVISION_LIMIT_REACHED", limit: 25 } },
    },
    {
      code: "SPACE_QUOTA_EXCEEDED",
      status: 409,
      result: { ok: false, error: { code: "SPACE_QUOTA_EXCEEDED", quota: "retainedMarkdown" } },
    },
    {
      code: "CONTENT_TOO_LARGE",
      status: 413,
      result: { ok: false, error: { code: "CONTENT_TOO_LARGE", limitBytes: 262_144 } },
    },
  ] as const)("preserves the structured $code Application result", async ({ status, result }) => {
    const appendRevision = vi.fn(async (): Promise<AppendRevisionApplicationResult> => result);
    const application = createApplication({ appendRevision });

    await withServer(application, async (endpoint) => {
      const response = await fetch(`${endpoint}/api/handoffs/ABC001/revisions`, {
        method: "POST",
        headers: { ...bearerHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ baseRevision: 1, markdown: "# Updated", origin: "webmcp" }),
      });
      expect(response.status).toBe(status);
      await expect(readResponse(response)).resolves.toEqual(result);
    });
  });

  it("hides unexpected Application failures behind an opaque request id", async () => {
    const application = createApplication({
      getHandoff: async () => {
        throw new Error("database password must not cross the boundary");
      },
    });

    await withServer(application, async (endpoint) => {
      const response = await fetch(`${endpoint}/api/handoffs/ABC001`, {
        headers: bearerHeaders(),
      });
      expect(response.status).toBe(500);
      const result = await readResponse(response);
      expect(result).toEqual({
        ok: false,
        error: {
          code: "INTERNAL_ERROR",
          requestId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        },
      });
      expect(JSON.stringify(result)).not.toContain("database password");
    });
  });
});

async function expectSpaceId(): Promise<Uint8Array> {
  return deriveSpaceId(parseSpaceKey(SPACE_KEY));
}
