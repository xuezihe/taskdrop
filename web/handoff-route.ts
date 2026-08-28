const HANDOFF_CODE_PATTERN = /^[0-9A-TV-Za-tv-z]{6}$/;

export function parseHandoffPath(pathname: string): string | null {
  const match = /^\/handoff\/([^/]+)$/.exec(pathname);
  if (!match) return null;

  let code: string;
  try {
    code = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }

  if (code.includes("/") || !HANDOFF_CODE_PATTERN.test(code)) return null;
  return code;
}
