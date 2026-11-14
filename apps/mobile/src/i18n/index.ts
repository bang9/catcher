// t('key', { name }) — Korean when the phone's first language is Korean, English otherwise.

import { getLocales } from 'expo-localization';
import { en } from './en.ts';
import { type Key, ko } from './ko.ts';

export type { Key };

export const locale: 'ko' | 'en' = pickLocale();

function pickLocale(): 'ko' | 'en' {
  if (getLocales()[0]?.languageCode === 'ko') return 'ko';
  return 'en';
}

const table: Record<Key, string> = (locale === 'ko' && ko) || en;

export function t(key: Key, params: Record<string, string | number> = {}): string {
  return table[key].replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    if (v === undefined) return whole;
    return String(v);
  });
}

/** Full locale tag for the relay (push text language) and date formatting. */
export function localeTag(): string {
  return getLocales()[0]?.languageTag ?? locale;
}
