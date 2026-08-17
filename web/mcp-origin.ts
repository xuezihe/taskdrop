export const DEFAULT_MCP_ORIGIN = "https://taskdrop.xuezihe.com";

export function resolveMcpOrigin(value: string | undefined): string {
  const raw = value?.trim() ? value.trim() : DEFAULT_MCP_ORIGIN;
  const withoutTrailingSlash = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  let parsed: URL;
  try {
    parsed = new URL(withoutTrailingSlash);
  } catch {
    throw new Error("MCP origin must be an absolute https origin");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("MCP origin must use https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("MCP origin must not include credentials or a query");
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error("MCP origin must not include a path");
  }
  return parsed.origin;
}
