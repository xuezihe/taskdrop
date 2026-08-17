export type LandingLanguage = "en" | "zh";

export const LANGUAGE_STORAGE_KEY = "taskdrop.landing.lang";

export function isLandingLanguage(value: string | null | undefined): value is LandingLanguage {
  return value === "en" || value === "zh";
}

export function resolveLanguage(
  browserLanguages: readonly string[],
  stored: string | null | undefined,
): LandingLanguage {
  if (isLandingLanguage(stored)) return stored;
  const prefersChinese = browserLanguages.some((tag) => {
    const primary = tag.toLowerCase().split("-")[0];
    return primary === "zh";
  });
  return prefersChinese ? "zh" : "en";
}
