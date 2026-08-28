export const DEFAULT_BROWSER_API_PROXY_TARGET = "http://127.0.0.1:3000";

export function resolveBrowserApiProxyTarget(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const rawTarget = env["TASKDROP_BROWSER_API_TARGET"];
  if (rawTarget === undefined || rawTarget === "") return DEFAULT_BROWSER_API_PROXY_TARGET;

  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    throw new Error("invalid TASKDROP_BROWSER_API_TARGET");
  }

  if (
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    target.pathname !== "/" ||
    target.search !== "" ||
    target.hash !== ""
  ) {
    throw new Error("invalid TASKDROP_BROWSER_API_TARGET");
  }

  return target.origin;
}
