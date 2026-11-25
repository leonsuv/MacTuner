import React, { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
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

function matchBrowserLocale(rawTag: string): LocaleCode | null {
  const tag = rawTag.trim();
  if (!tag) return null;
  const lower = tag.toLowerCase();

  // Chinese script / region mappings
  if (lower.startsWith('zh')) {
    if (
      lower.includes('hant') ||
      lower.includes('-tw') ||
      lower.includes('-hk') ||
      lower.includes('-mo') ||
      lower.includes('_tw') ||
      lower.includes('_hk') ||
      lower.includes('_mo')
    ) {
      return 'zh-Hant' in localesData ? ('zh-Hant' as LocaleCode) : null;
    }
    if (
      lower.includes('hans') ||
      lower.includes('-cn') ||
      lower.includes('-sg') ||
      lower.includes('_cn') ||
      lower.includes('_sg') ||
      lower === 'zh'
    ) {
      return 'zh-Hans' in localesData ? ('zh-Hans' as LocaleCode) : null;
    }
  }

  // Exact match (case-insensitive)
  const localeKeys = Object.keys(localesData) as LocaleCode[];
  const exact = localeKeys.find((k) => k.toLowerCase() === lower);
  if (exact) return exact;

  // Base language prefix match (e.g. de-DE -> de, fr-CH -> fr)
  const base = lower.split(/[-_]/)[0];
  const prefix = localeKeys.find((k) => k.toLowerCase() === base);
  if (prefix) return prefix;

  return null;
}

export function getInitialLocale(): LocaleCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as LocaleCode | null;
    if (saved && saved in localesData) return saved;
  } catch {
    // ignore storage errors
  }

  try {
    if (typeof navigator !== 'undefined') {
      const candidates: string[] = [];
      if (Array.isArray(navigator.languages)) {
        candidates.push(...navigator.languages);
      }
      if (navigator.language) {
        candidates.push(navigator.language);
      }
      for (const candidate of candidates) {
        const matched = matchBrowserLocale(candidate);
        if (matched) return matched;
      }
    }
  } catch {
    // ignore navigator errors
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

interface LocaleLookupCache {
  lower: Map<string, string>;
  stripped: Map<string, string>;
}

const lookupCache = new Map<LocaleCode, LocaleLookupCache>();

function stripTrailingPunctuation(s: string): string {
  return s.replace(/(?:\.\.\.|…|:)\s*$/u, '').trim();
}

function getLookupCache(locale: LocaleCode): LocaleLookupCache {
  let cached = lookupCache.get(locale);
  if (cached) return cached;

  const lower = new Map<string, string>();
  const stripped = new Map<string, string>();
  const dict = localesData[locale]?.strings as Record<string, string> | undefined;

  if (dict) {
    for (const [k, v] of Object.entries(dict)) {
      const kl = k.toLowerCase();
      if (!lower.has(kl)) {
        lower.set(kl, v);
      }
      const ks = stripTrailingPunctuation(k).toLowerCase();
      if (ks && !stripped.has(ks)) {
        stripped.set(ks, v);
      }
    }
  }

  cached = { lower, stripped };
  lookupCache.set(locale, cached);
  return cached;
}

function lookupInLocale(locale: LocaleCode, key: string): string | undefined {
  const dict = localesData[locale]?.strings as Record<string, string> | undefined;
  if (!dict) return undefined;

  // 1. Exact match
  if (Object.prototype.hasOwnProperty.call(dict, key)) {
    return dict[key];
  }

  // 2. Trimmed match
  const trimmed = key.trim();
  if (trimmed !== key && Object.prototype.hasOwnProperty.call(dict, trimmed)) {
    return dict[trimmed];
  }

  // 3. Lazy case-insensitive match
  const cache = getLookupCache(locale);
  const lowerHit = cache.lower.get(trimmed.toLowerCase());
  if (lowerHit !== undefined) {
    return lowerHit;
  }

  // 4. Trailing punctuation-insensitive match (… / ... / :)
  const strippedKey = stripTrailingPunctuation(trimmed).toLowerCase();
  if (strippedKey) {
    const strippedHit = cache.stripped.get(strippedKey);
    if (strippedHit !== undefined) {
      return strippedHit;
    }
  }

  return undefined;
}

function formatArgs(template: string, args: (string | number)[]): string {
  if (args.length === 0) return template;

  // Replace indexed placeholders {0}, {1}, ... first if present
  let result = template.replace(/\{(\d+)\}/g, (match, indexStr: string) => {
    const idx = Number(indexStr);
    return idx >= 0 && idx < args.length ? String(args[idx]) : match;
  });

  // Replace sequential printf / Apple format placeholders (%@, %lld, %d)
  let seqIdx = 0;
  result = result.replace(/%(?:@|lld|d)/g, (match) => {
    if (seqIdx < args.length) {
      return String(args[seqIdx++]);
    }
    return match;
  });

  return result;
}

export function translate(
  locale: LocaleCode,
  key: string,
  ...args: (string | number)[]
): string {
  const found =
    lookupInLocale(locale, key) ??
    (locale !== 'en' ? lookupInLocale('en', key) : undefined) ??
    key;

  return formatArgs(found, args);
}

export interface I18nContextValue {
  locale: LocaleCode;
  setLocale: (locale: LocaleCode) => void;
  t: (key: string, ...args: (string | number)[]) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  setLocale: () => {},
  t: (key, ...args) => translate('en', key, ...args),
});

export interface I18nProviderProps {
  locale: LocaleCode;
  setLocale: (locale: LocaleCode) => void;
  children: ReactNode;
}

export function I18nProvider({ locale, setLocale, children }: I18nProviderProps) {
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const t = useCallback(
    (key: string, ...args: (string | number)[]) => translate(locale, key, ...args),
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return React.createElement(I18nContext.Provider, { value }, children);
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
