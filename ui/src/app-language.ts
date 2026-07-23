export const APP_LANGUAGES = ["en", "zh"] as const;
export type AppLanguage = (typeof APP_LANGUAGES)[number];

export const DEFAULT_APP_LANGUAGE: AppLanguage = "en";

export const APP_LANGUAGE_OPTIONS = [
  {
    value: "en",
    label: "English",
  },
  {
    value: "zh",
    label: "中文",
  },
] as const satisfies Array<{
  value: AppLanguage;
  label: string;
}>;

/**
 * EN: Checks whether a stored or selected value is a supported app display language.
 * 中文: 判断持久化或用户选择的值是否为支持的应用显示语言。
 * @param value candidate language value.
 * @returns true when the value is a supported language code.
 */
export function isAppLanguage(value: unknown): value is AppLanguage {
  return (
    typeof value === "string" &&
    (APP_LANGUAGES as readonly string[]).includes(value)
  );
}

/**
 * EN: Normalizes an unknown language value to the app display language contract.
 * 中文: 将未知语言值规范化为应用显示语言契约。
 * @param value candidate language value.
 * @returns supported language code or the default language.
 */
export function normalizeAppLanguage(value: unknown): AppLanguage {
  return isAppLanguage(value) ? value : DEFAULT_APP_LANGUAGE;
}

/**
 * EN: Formats the display label for one app language option.
 * 中文: 格式化单个应用语言选项的展示名称。
 * @param language language code to display.
 * @returns human-readable option label.
 */
export function formatAppLanguageLabel(language: AppLanguage): string {
  return (
    APP_LANGUAGE_OPTIONS.find((option) => option.value === language)?.label ??
    language
  );
}
