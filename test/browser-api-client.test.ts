import { describe, expect, it } from "vitest";

import { formatSpaceKey } from "../src/production/space-identity.js";
import { createBrowserApiClient, type BrowserRequest } from "../web/browser-api-client.js";

const SPACE_KEY = formatSpaceKey(new Uint8Array(32));

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const revision = {
  ok: true as const,
  code: "ABC001",
  revision: 1,
  latestRevision: 1,
  isLatest: true,
  markdown: "# Current",
  contentSanitized: false,
  redactionCount: 0,
  origin: "mcp" as const,
  createdAt: "2026-08-28T08:00:00.000Z",
  expiresAt: "2026-08-29T08:00:00.000Z",
};

describe("Browser API client", () => {
  it("loads the current Revision through a relative same-origin URL", async () => {
    const requests: Array<{ path: string; init: RequestInit | undefined }> = [];
    const request: BrowserRequest = async (path, init) => {
      requests.push({ path, init });
      return response(revision);
    };
    const client = createBrowserApiClient(SPACE_KEY, request);

    await expect(client.getCurrent("abc0oi")).resolves.toEqual(revision);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe("/api/handoffs/abc0oi");
    expect(requests[0]!.init?.method).toBeUndefined();
    expect(new Headers(requests[0]!.init?.headers).get("authorization")).toBe(
      `Bearer ${SPACE_KEY}`,
    );
    expect(requests[0]!.path).not.toContain(SPACE_KEY);
  });

  it("sends the exact Browser append contract and preserves the returned Revision", async () => {
    let capturedPath = "";
    let capturedInit: RequestInit | undefined;
    const request: BrowserRequest = async (path, init) => {
      capturedPath = path;
      capturedInit = init;
      return response({ ...revision, revision: 2, latestRevision: 2, origin: "human" });
    };
    const client = createBrowserApiClient(SPACE_KEY, request);

    await expect(
      client.appendRevision({
        code: "ABC001",
        baseRevision: 1,
        markdown: "# Human",
        origin: "human",
      }),
    ).resolves.toMatchObject({ revision: 2, origin: "human" });

    expect(capturedPath).toBe("/api/handoffs/ABC001/revisions");
    expect(capturedInit?.method).toBe("POST");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe(`Bearer ${SPACE_KEY}`);
    expect(new Headers(capturedInit?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(capturedInit?.body)) as unknown).toEqual({
      baseRevision: 1,
      markdown: "# Human",
      origin: "human",
    });
  });

  it("returns structured domain errors from non-2xx responses", async () => {
    const request: BrowserRequest = async () =>
      response(
        {
          ok: false,
          error: { code: "REVISION_CONFLICT", expectedRevision: 2, receivedBaseRevision: 1 },
        },
        409,
      );
    const client = createBrowserApiClient(SPACE_KEY, request);

    await expect(
      client.appendRevision({
        code: "ABC001",
        baseRevision: 1,
        markdown: "# Stale",
        origin: "human",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "REVISION_CONFLICT", expectedRevision: 2, receivedBaseRevision: 1 },
    });
  });

  it("maps network and malformed response failures without exposing exception text", async () => {
    const networkClient = createBrowserApiClient(SPACE_KEY, async () => {
      throw new Error(`secret ${SPACE_KEY}`);
    });
    await expect(networkClient.getCurrent("ABC001")).resolves.toEqual({
      ok: false,
      error: { code: "NETWORK_ERROR" },
    });

    const invalidClient = createBrowserApiClient(
      SPACE_KEY,
      async () => new Response("not-json", { status: 200 }),
    );
    await expect(invalidClient.getCurrent("ABC001")).resolves.toEqual({
      ok: false,
      error: { code: "INVALID_RESPONSE" },
    });
  });
});
