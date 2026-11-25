import localesData from './locales.json';

export type LocaleCode = keyof typeof localesData;

export interface LocaleMeta {
  code: LocaleCode;
  name: string;
}

const STORAGE_KEY = 'mactuner.locale';

export const AVAILABLE_LOCALES: LocaleMeta[] = (Object.keys(localesData) as LocaleCode[]).map(
  (code) => ({
    code,
    name: localesData[code].name,
  }),
);

export function getInitialLocale(): LocaleCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as LocaleCode | null;
    if (saved && saved in localesData) return saved;
  } catch {
    // ignore storage errors
  }
  return 'en';
}

export function saveLocale(code: LocaleCode): void {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // ignore
  }
}

export function translate(locale: LocaleCode, key: string): string {
  const dict = localesData[locale]?.strings as Record<string, string> | undefined;
  return dict?.[key] ?? key;
}
