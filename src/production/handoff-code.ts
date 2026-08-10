export function normalizeHandoffCode(code: string): string {
  return code.toUpperCase().replaceAll("O", "0").replace(/[IL]/g, "1");
}
