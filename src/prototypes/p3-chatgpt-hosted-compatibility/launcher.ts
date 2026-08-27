/**
 * PROTOTYPE - THROW AWAY.
 *
 * One-command operator shell for the P3 ChatGPT hosted compatibility test.
 */

import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { LifecycleStage } from "./lifecycle-recorder.js";
import { startP3Server, type P3Server } from "./server.js";

const PORT = Number.parseInt(process.env.TASKDROP_P3_PORT ?? "4330", 10);
const QUICK_TUNNEL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let server: P3Server | undefined;
let tunnel: ChildProcessWithoutNullStreams | undefined;
let publicOrigin = "(starting)";
let expectedFingerprint = "(pending)";
let preflight = "pending";
let clipboard = "empty";
let shuttingDown = false;
let lastRenderedSequence = 0;
let lastRenderedStatus = "";

await main().catch(async () => {
  console.error("P3 launcher failed; sensitive error details were suppressed.");
  await shutdown(1);
});

async function main(): Promise<void> {
  requireExecutable("cloudflared", ["--version"]);
  requireExecutable("pbcopy", []);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(0));
  }

  const spaceKey = `tdp_${randomBytes(32).toString("base64url")}`;
  expectedFingerprint = createHash("sha256").update(spaceKey).digest("base64url").slice(0, 12);

  server = await startP3Server({
    port: PORT,
    expectedFingerprint,
    onStateChanged: render,
  });
  render();

  tunnel = spawn(
    "cloudflared",
    [
      "tunnel",
      "--protocol",
      "http2",
      "--edge-ip-version",
      "4",
      "--url",
      server.localOrigin,
      "--no-autoupdate",
    ],
    {
      stdio: "pipe",
      env: cloudflaredEnvironment(),
    },
  );

  publicOrigin = await waitForQuickTunnel(tunnel);
  server.allowPublicHost(new URL(publicOrigin).hostname);
  render();
  await delay(2_000);

  const credentialUrl = `${publicOrigin}/mcp?taskdropKey=${encodeURIComponent(spaceKey)}`;
  await runPublicPreflight(credentialUrl);
  preflight = "passed";
  server.recorder.setStage("tool-scan");

  await writeClipboard(credentialUrl);
  clipboard = "contains disposable endpoint";
  render();

  tunnel.once("exit", () => {
    if (!shuttingDown) {
      preflight = "tunnel stopped unexpectedly";
      render();
    }
  });

  startOperatorLoop();
}

function requireExecutable(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(`${command} is unavailable`);
  }
}

function cloudflaredEnvironment(): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

async function waitForQuickTunnel(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffered = "";
    let discoveredUrl: string | undefined;
    let registered = false;

    const finishIfReady = () => {
      if (settled || !discoveredUrl || !registered) return;
      settled = true;
      clearTimeout(timeout);
      resolve(discoveredUrl);
    };

    const inspect = (chunk: Buffer) => {
      buffered = `${buffered}${chunk.toString("utf8")}`.slice(-16_384);
      const match = QUICK_TUNNEL_PATTERN.exec(buffered);
      if (match?.[0]) {
        discoveredUrl = match[0];
      }
      registered ||= buffered.includes("Registered tunnel connection");
      finishIfReady();
    };

    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", reject);
    child.once("exit", () => {
      if (!settled) reject(new Error("Quick Tunnel exited before becoming ready"));
    });

    const timeout = setTimeout(() => {
      if (!settled) reject(new Error("Quick Tunnel did not become ready"));
    }, 30_000);
  });
}

async function runPublicPreflight(endpoint: string): Promise<void> {
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    preflight = `waiting for public route (${attempt}/30)`;
    render();
    try {
      await executePreflight(endpoint);
      return;
    } catch (error) {
      lastFailure = error;
      await delay(1_000);
    }
  }

  void lastFailure;
  throw new Error("Public MCP preflight failed");
}

async function executePreflight(endpoint: string): Promise<void> {
  let id = 0;
  await postRpc(endpoint, {
    jsonrpc: "2.0",
    id: ++id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "taskdrop-p3-preflight", version: "0.0.0" },
    },
  });

  await postRpc(endpoint, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });

  const listed = await postRpc(endpoint, {
    jsonrpc: "2.0",
    id: ++id,
    method: "tools/list",
    params: {},
  });
  const tools = readArray(asRecord(listed)?.result, "tools")
    .map((tool) => asRecord(tool)?.name)
    .filter((name): name is string => typeof name === "string");
  for (const required of ["create_handoff", "get_handoff", "append_revision"]) {
    if (!tools.includes(required)) {
      throw new Error("Public MCP tool list is incomplete");
    }
  }

  const markdown = [
    "# Task Handoff",
    "",
    "## Current Goal",
    "Verify the hosted P3 endpoint before ChatGPT Tool Scan.",
    "",
    "## Next Action",
    "Test credential continuity and write capability in ChatGPT Business.",
  ].join("\n");

  const created = await callTool(endpoint, ++id, "create_handoff", { markdown });
  const code = asRecord(created)?.code;
  if (typeof code !== "string" || code.length !== 6) {
    throw new Error("Public create_handoff preflight failed");
  }

  const read = await callTool(endpoint, ++id, "get_handoff", {
    code,
    revision: "latest",
  });
  if (asRecord(read)?.markdown !== markdown) {
    throw new Error("Public get_handoff preflight failed");
  }
}

async function callTool(
  endpoint: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await postRpc(endpoint, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = asRecord(asRecord(response)?.result);
  if (!result || result.isError === true) {
    throw new Error("Public MCP tool call failed");
  }
  return result.structuredContent;
}

async function postRpc(endpoint: string, payload: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error("Public MCP request failed");
  }
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) {
      throw new Error("Unexpected MCP response framing");
    }
    return JSON.parse(dataLine.slice(6)) as unknown;
  }
}

function startOperatorLoop(): void {
  if (!process.stdin.isTTY) {
    throw new Error("P3 launcher requires an interactive terminal");
  }

  const input = createInterface({ input: process.stdin, output: process.stdout });
  input.on("line", (line) => {
    void handleCommand(line).catch(() => {
      preflight = "operator action failed";
      render();
    });
  });
}

async function handleCommand(input: string): Promise<void> {
  const command = input.trim().toLowerCase();
  const stages: Partial<Record<string, Exclude<LifecycleStage, "preflight">>> = {
    "3": "later-call",
    "4": "reopened-conversation",
    "5": "refresh-reconnect",
  };
  const stage = stages[command];
  if (stage) {
    server?.recorder.setStage(stage);
    render();
    return;
  }

  if (command === "c") {
    await clearClipboard();
    render();
    return;
  }

  if (command === "q") {
    await shutdown(0);
  }
}

async function writeClipboard(value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error("pbcopy failed"))));
    child.stdin.end(value);
  });
}

async function clearClipboard(): Promise<void> {
  await writeClipboard("");
  clipboard = "cleared";
  render();
}

function render(): void {
  const snapshot = server?.snapshot();
  const status = [
    publicOrigin,
    preflight,
    clipboard,
    snapshot?.lifecycle.currentStage ?? "preflight",
  ].join("|");
  const statusChanged = status !== lastRenderedStatus;
  if (statusChanged) {
    lastRenderedStatus = status;
    console.log(
      `[state] preflight=${preflight} stage=${snapshot?.lifecycle.currentStage ?? "preflight"} clipboard=${clipboard}`,
    );
  }

  for (const observation of snapshot?.lifecycle.observations ?? []) {
    if (observation.sequence <= lastRenderedSequence) continue;
    lastRenderedSequence = observation.sequence;
    console.log(
      `[mcp] #${observation.sequence} stage=${observation.stage} rpc=${observation.rpcMethod}${observation.toolName ? ` tool=${observation.toolName}` : ""} auth=${observation.authentication} match=${observation.credentialMatchedExpected} status=${observation.responseStatus}`,
    );
  }

  if (statusChanged && preflight === "passed" && snapshot?.lifecycle.currentStage === "tool-scan") {
    console.log(
      "[ready] Scan Tools now; the first ChatGPT tool call will enter first-call automatically.",
    );
    console.log(
      "[commands] 3 later-call | 4 reopened | 5 refresh/reconnect | c clear clipboard | q quit",
    );
  }
}

async function shutdown(exitCode: number): Promise<never> {
  if (shuttingDown) {
    process.exit(exitCode);
  }
  shuttingDown = true;

  if (process.stdin.isTTY) {
    process.stdin.pause();
  }

  if (clipboard !== "cleared") {
    await clearClipboard().catch(() => undefined);
  }

  tunnel?.kill("SIGTERM");
  await server?.close().catch(() => undefined);
  process.exit(exitCode);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readArray(value: unknown, key: string): unknown[] {
  const candidate = asRecord(value)?.[key];
  return Array.isArray(candidate) ? candidate : [];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
