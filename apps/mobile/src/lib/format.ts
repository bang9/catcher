// Small formatting helpers. Plain functions instead of Intl.RelativeTimeFormat (not guaranteed on Hermes).

import { groups, unb32 } from '@catcher/protocol';
import { localeTag, t } from '@/i18n';

export function ago(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t('time.justNow');
  if (min < 60) return t('time.minutesAgo', { n: min });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('time.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t('time.daysAgo', { n: days });
  return shortDate(ms);
}

export function shortDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(localeTag(), { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export function dateTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(localeTag(), {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
}

export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** mm:ss for countdowns */
export function countdown(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Remaining time in words: "4분" / "2시간" */
export function remaining(msLeft: number): string {
  const min = Math.max(1, Math.ceil(msLeft / 60_000));
  if (min < 60) return t('time.minutes', { n: min });
  return t('time.hours', { n: Math.floor(min / 60) });
}

/** Pairing code ABCDEFGH → ABCD-EFGH */
export function groupedCode(code: string): string {
  return groups(code.replace(/-/g, '').toUpperCase(), 4);
}

/** Normalize a typed recovery code for display while typing (keeps what the person typed, upper case). */
export function cleanRecoveryInput(text: string): string {
  return text.toUpperCase().replace(/[^0-9A-Z\s-]/g, '');
}

/** True when the typed recovery code has at least the right number of characters to try. */
export function recoveryLooksComplete(text: string): boolean {
  try {
    return unb32(text).length >= 34;
  } catch {
    return false;
  }
}

/** Agents poll their inbox as a heartbeat; seen in the last 5 minutes counts as connected. */
export function isOnline(lastSeenAt: number | null, now = Date.now()): boolean {
  return lastSeenAt !== null && now - lastSeenAt < 5 * 60_000;
}

export const DEFAULT_SERVER = 'https://catcher.bang9.dev';

/** https anywhere; plain http only for this machine / the Android emulator host (development). */
export function normalizeServer(input: string): string | null {
  const text = input.trim().replace(/\/+$/, '');
  const m = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(:\d{1,5})?(\/[^\s?#]*)?$/i.exec(text);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  const host = m[2]!.toLowerCase();
  if (scheme === 'https') return text;
  if (['127.0.0.1', 'localhost', '10.0.2.2'].includes(host)) return text;
  return null;
}

/** A reversed copy (newest first), without relying on Array#toReversed being in the engine. */
export function newestFirst<T>(list: readonly T[]): T[] {
  const out: T[] = [];
  for (let i = list.length - 1; i >= 0; i--) out.push(list[i]!);
  return out;
}
