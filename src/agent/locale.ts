export type Locale = "en" | "zh";

export const resolveLocale = (locale?: Locale): Locale =>
  locale === "en" ? "en" : "zh";

export const localized = (
  locale: Locale | undefined,
  zh: string,
  en: string,
) => (resolveLocale(locale) === "en" ? en : zh);
