/**
 * PROTOTYPE - THROW AWAY.
 *
 * Automated visible contract matrix for P6.
 */

import { randomBytes } from "node:crypto";

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import { startP6Server, type P6Server } from "./server.js";

const PORT = Number.parseInt(process.env.TASKDROP_P6_PORT ?? "4360", 10);
const LEGACY_VERSIONS = ["2025-06-18", "2025-11-25"] as const;
const MODERN_VERSION = "2026-07-28";
const REQUIRED_TOOLS = ["append_revision", "create_handoff", "get_handoff"];

type Version = (typeof LEGACY_VERSIONS)[number] | typeof MODERN_VERSION;

type CaseResult = {
  name: string;
  status: "PASS" | "FAIL";
  detail: string;
};

type MatrixState = {
  question: string;
  endpoint: string;
  cases: CaseResult[];
  versions: Record<Version, { era: "legacy" | "modern"; tools: string[] }>;
  verdict: "RUNNING" | "PASS" | "FAIL";
};

const state: MatrixState = {
  question:
    "Can one endpoint and one Handoff Service preserve one contract across MCP 2025-06-18, 2025-11-25, and 2026-07-28?",
  endpoint: "(starting)",
  cases: [],
  versions: {
    "2025-06-18": { era: "legacy", tools: [] },
    "2025-11-25": { era: "legacy", tools: [] },
    "2026-07-28": { era: "modern", tools: [] },
  },
  verdict: "RUNNING",
};

let server: P6Server | undefined;
let nonInteractiveHeaderPrinted = false;
let nonInteractiveCaseCount = 0;

async function main(): Promise<void> {
  const spaceKey = `tdp_${randomBytes(32).toString("base64url")}`;
  try {
    server = await startP6Server(PORT);
    state.endpoint = server.endpoint;
    render();

    const clients: Record<Version, ContractClient> = {
      "2025-06-18": new LegacyClient(server.endpoint, spaceKey, "2025-06-18"),
      "2025-11-25": new LegacyClient(server.endpoint, spaceKey, "2025-11-25"),
      "2026-07-28": new ModernClient(server.endpoint, spaceKey),
    };

    for (const version of LEGACY_VERSIONS) {
      await clients[version].connect();
    }
    await clients[MODERN_VERSION].connect();

    const toolContracts = new Map<Version, unknown>();
    for (const version of [...LEGACY_VERSIONS, MODERN_VERSION] as Version[]) {
      const listed = await clients[version].listTools();
      const names = listed.map((tool) => readString(tool, "name")).sort();
      state.versions[version].tools = names;
      check(
        `${version} lists all tools`,
        sameJson(names, REQUIRED_TOOLS),
        names.join(", "),
      );
      toolContracts.set(version, canonicalToolContract(listed));
    }

    const referenceContract = toolContracts.get("2025-06-18");
    for (const version of ["2025-11-25", MODERN_VERSION] as Version[]) {
      check(
        `${version} tool schemas equal 2025-06-18`,
        sameJson(toolContracts.get(version), referenceContract),
        "names, input schemas, output schemas, annotations",
      );
    }

    for (const version of [...LEGACY_VERSIONS, MODERN_VERSION] as Version[]) {
      await runSameEraLoop(clients[version], version);
    }

    await runCrossEraLoop(
      clients[MODERN_VERSION],
      clients["2025-06-18"],
      "modern create -> 2025-06-18 append -> modern read",
    );
    await runCrossEraLoop(
      clients["2025-11-25"],
      clients[MODERN_VERSION],
      "2025-11-25 create -> modern append -> 2025-11-25 read",
    );

    const scopes = new Set(server.factoryObservations.map((item) => item.scopeHash));
    check("all era factories resolve one Space", scopes.size === 1, `${scopes.size} scope(s)`);
    check(
      "legacy and modern factories both executed",
      server.factoryObservations.some((item) => item.era === "legacy") &&
        server.factoryObservations.some((item) => item.era === "modern"),
      summarizeEras(server),
    );
    check(
      "all HTTP exchanges are stateless",
      server.requestObservations.every(
        (item) => !item.requestHadSession && !item.responseHadSession,
      ),
      `${server.requestObservations.length} request(s), no MCP Session ID`,
    );
    check(
      "one shared Handoff store contains every loop",
      server.service.visibleState().length === 1 &&
        server.service.visibleState()[0]?.handoffs.length === 5,
      `${server.service.visibleState()[0]?.handoffs.length ?? 0} Handoff(s)`,
    );

    state.verdict = state.cases.every((item) => item.status === "PASS") ? "PASS" : "FAIL";
    render();
    printEvidence(server);
    if (state.verdict !== "PASS") process.exitCode = 1;
  } catch (error) {
    state.verdict = "FAIL";
    state.cases.push({
      name: "runner completed",
      status: "FAIL",
      detail: sanitizedError(error),
    });
    render();
    process.exitCode = 1;
  } finally {
    await server?.close();
  }
}

async function runSameEraLoop(client: ContractClient, version: Version): Promise<void> {
  const revision1 = `# ${version} Revision 1`;
  const created = await client.callTool("create_handoff", { markdown: revision1 });
  const code = readCode(created.structuredContent);
  const read1 = await client.callTool("get_handoff", { code, revision: "latest" });
  const revision2 = `# ${version} Revision 2`;
  const appended = await client.callTool("append_revision", {
    code,
    baseRevision: 1,
    markdown: revision2,
  });
  const read2 = await client.callTool("get_handoff", { code, revision: "latest" });
  const stale = await client.callTool("append_revision", {
    code,
    baseRevision: 1,
    markdown: "# stale",
  });

  check(
    `${version} minimum Handoff loop`,
    readSnapshot(read1.structuredContent).markdown === revision1 &&
      readSnapshot(appended.structuredContent).revision === 2 &&
      readSnapshot(read2.structuredContent).markdown === revision2,
    `${code}: Revision 1 -> Revision 2`,
  );
  check(
    `${version} content equals structuredContent`,
    [created, read1, appended, read2, stale].every(contentMatchesStructured),
    "all five tool results",
  );
  check(
    `${version} conflict semantics`,
    readErrorCode(stale.structuredContent) === "REVISION_CONFLICT" && stale.isError === true,
    "stale append rejected without Revision 3",
  );
}

async function runCrossEraLoop(
  creator: ContractClient,
  appender: ContractClient,
  name: string,
): Promise<void> {
  const created = await creator.callTool("create_handoff", { markdown: `# ${name} R1` });
  const code = readCode(created.structuredContent);
  const readByOther = await appender.callTool("get_handoff", { code, revision: "latest" });
  const appended = await appender.callTool("append_revision", {
    code,
    baseRevision: 1,
    markdown: `# ${name} R2`,
  });
  const finalRead = await creator.callTool("get_handoff", { code, revision: "latest" });

  check(
    name,
    readSnapshot(readByOther.structuredContent).revision === 1 &&
      readSnapshot(appended.structuredContent).revision === 2 &&
      readSnapshot(finalRead.structuredContent).revision === 2,
    `${code}: shared Revision 1 -> Revision 2`,
  );
  check(
    `${name} response equivalence`,
    [created, readByOther, appended, finalRead].every(contentMatchesStructured),
    "content and structuredContent agree across eras",
  );
}

abstract class ContractClient {
  #nextId = 0;

  constructor(
    protected readonly endpoint: string,
    private readonly spaceKey: string,
    readonly version: Version,
  ) {}

  abstract connect(): Promise<void>;
  abstract envelope(params: Record<string, unknown>): Record<string, unknown>;

  async listTools(): Promise<Record<string, unknown>[]> {
    const response = await this.request("tools/list", {});
    return readRecords(readRecord(response, "result"), "tools");
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCall> {
    const response = await this.request("tools/call", { name, arguments: args });
    const result = readRecord(response, "result");
    return {
      content: readRecords(result, "content"),
      structuredContent: result.structuredContent,
      isError: result.isError,
    };
  }

  protected async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post({
      jsonrpc: "2.0",
      id: ++this.#nextId,
      method,
      params: this.envelope(params),
    });
  }

  protected async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.post({ jsonrpc: "2.0", method, params: this.envelope(params) });
  }

  protected async post(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.spaceKey}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": this.version,
    };
    if (this.version === MODERN_VERSION && typeof payload.method === "string") {
      headers["MCP-Method"] = payload.method;
      const params = payload.params;
      if (
        payload.method === "tools/call" &&
        typeof params === "object" &&
        params !== null &&
        !Array.isArray(params) &&
        typeof (params as Record<string, unknown>).name === "string"
      ) {
        headers["MCP-Name"] = (params as Record<string, unknown>).name as string;
      }
    }
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `${this.version} HTTP ${response.status}${readWireError(text) ? `: ${readWireError(text)}` : ""}`,
      );
    }
    if (!text) return {};
    return readRpcResponse(text);
  }
}

class LegacyClient extends ContractClient {
  async connect(): Promise<void> {
    const response = await this.post({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: this.version,
        capabilities: {},
        clientInfo: { name: `taskdrop-p6-${this.version}`, version: "0.0.0" },
      },
    });
    const negotiated = readString(readRecord(response, "result"), "protocolVersion");
    check(`${this.version} initialize`, negotiated === this.version, `negotiated ${negotiated}`);
    await this.notify("notifications/initialized");
  }

  envelope(params: Record<string, unknown>): Record<string, unknown> {
    return params;
  }
}

class ModernClient extends ContractClient {
  constructor(endpoint: string, spaceKey: string) {
    super(endpoint, spaceKey, MODERN_VERSION);
  }

  async connect(): Promise<void> {
    const response = await this.request("server/discover", {});
    const result = readRecord(response, "result");
    const versions = readStrings(result, "supportedVersions");
    check(
      `${MODERN_VERSION} discover`,
      versions.includes(MODERN_VERSION),
      `advertised ${versions.join(", ")}`,
    );
  }

  envelope(params: Record<string, unknown>): Record<string, unknown> {
    return {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION,
        [CLIENT_INFO_META_KEY]: { name: "taskdrop-p6-modern", version: "0.0.0" },
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
      ...params,
    };
  }
}

type ToolCall = {
  content: Record<string, unknown>[];
  structuredContent: unknown;
  isError: unknown;
};

function check(name: string, passed: boolean, detail: string): void {
  state.cases.push({ name, status: passed ? "PASS" : "FAIL", detail });
  render();
  if (!passed) throw new Error(`${name}: ${detail}`);
}

function render(): void {
  if (!process.stdout.isTTY) {
    if (!nonInteractiveHeaderPrinted) {
      nonInteractiveHeaderPrinted = true;
      console.log("TASKDROP P6 - PROTOTYPE / THROW AWAY");
      console.log(`Question: ${state.question}`);
      console.log(`Endpoint: ${state.endpoint}`);
    }

    for (const item of state.cases.slice(nonInteractiveCaseCount)) {
      console.log(`[${item.status}] ${item.name} — ${item.detail}`);
    }
    nonInteractiveCaseCount = state.cases.length;

    if (state.verdict !== "RUNNING") {
      console.log(`Verdict: ${state.verdict}`);
      for (const version of [...LEGACY_VERSIONS, MODERN_VERSION] as Version[]) {
        const row = state.versions[version];
        console.log(
          `  ${version} era=${row.era} tools=${row.tools.join(", ") || "(pending)"}`,
        );
      }
    }
    return;
  }

  console.clear();
  console.log("TASKDROP P6 - PROTOTYPE / THROW AWAY");
  console.log(`Question: ${state.question}`);
  console.log(`Endpoint: ${state.endpoint}`);
  console.log(`Verdict: ${state.verdict}`);
  console.log("");
  console.log("Protocol matrix:");
  for (const version of [...LEGACY_VERSIONS, MODERN_VERSION] as Version[]) {
    const row = state.versions[version];
    console.log(`  ${version}  era=${row.era}  tools=${row.tools.join(", ") || "(pending)"}`);
  }
  console.log("");
  console.log("Cases:");
  for (const item of state.cases) {
    console.log(`  [${item.status}] ${item.name} — ${item.detail}`);
  }
}

function printEvidence(activeServer: P6Server): void {
  console.log("");
  console.log("Evidence summary:");
  console.log(`  factory eras: ${summarizeEras(activeServer)}`);
  console.log(`  HTTP requests: ${activeServer.requestObservations.length}`);
  console.log(`  tool calls: ${activeServer.toolObservations.length}`);
  console.log(`  visible state: ${JSON.stringify(activeServer.service.visibleState())}`);
  console.log("  raw credentials and Markdown omitted from observations");
}

function canonicalToolContract(tools: Record<string, unknown>[]): unknown {
  return tools
    .map((tool) => ({
      name: tool.name,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }))
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function contentMatchesStructured(call: ToolCall): boolean {
  const text = call.content.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") return false;
  try {
    return sameJson(JSON.parse(text) as unknown, call.structuredContent);
  } catch {
    return false;
  }
}

function summarizeEras(activeServer: P6Server): string {
  const legacy = activeServer.factoryObservations.filter((item) => item.era === "legacy").length;
  const modern = activeServer.factoryObservations.filter((item) => item.era === "modern").length;
  return `legacy=${legacy}, modern=${modern}`;
}

function readRpcResponse(text: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) throw new Error("Unexpected MCP response framing");
    return asRecord(JSON.parse(dataLine.slice(6)) as unknown);
  }
}

function readSnapshot(value: unknown): Record<string, unknown> {
  const snapshot = asRecord(value);
  if (snapshot.ok !== true) throw new Error("Expected successful Handoff snapshot");
  return snapshot;
}

function readCode(value: unknown): string {
  const code = readSnapshot(value).code;
  if (typeof code !== "string" || code.length !== 6) throw new Error("Invalid Handoff Code");
  return code;
}

function readErrorCode(value: unknown): string {
  const error = readRecord(asRecord(value), "error");
  return readString(error, "code");
}

function readRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(value[key]);
}

function readRecords(value: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const items = value[key];
  if (!Array.isArray(items)) throw new Error(`Expected ${key} array`);
  return items.map(asRecord);
}

function readString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string") throw new Error(`Expected ${key} string`);
  return item;
}

function readStrings(value: Record<string, unknown>, key: string): string[] {
  const items = value[key];
  if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) {
    throw new Error(`Expected ${key} string array`);
  }
  return items;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object");
  }
  return value as Record<string, unknown>;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sanitizedError(error: unknown): string {
  return error instanceof Error ? error.message : "unknown failure";
}

function readWireError(text: string): string {
  try {
    const response = asRecord(JSON.parse(text) as unknown);
    const error = readRecord(response, "error");
    const code = error.code;
    const message = error.message;
    return `${typeof code === "number" ? code : "unknown"} ${typeof message === "string" ? message : "MCP error"}`;
  } catch {
    return "unparseable MCP error";
  }
}

await main();
