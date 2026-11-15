// Incoming links. Registration links never claim anything: the code is held, and the root layout opens the confirm
// sheet once the owner is set up.
//
// - https://<SITE_HOST>/r#<code> — the main path: a verified app link (associated domains / Android autoVerify), so
//   only this app receives it. The code sits in the #fragment, so it is read from the full URL.
// - catcher://enroll?code=<code> — kept for typing or Android intent:// links, but any app can claim a custom scheme,
//   so it is treated exactly like a typed code: confirm sheet only.

import { SITE_HOST } from '@/lib/site';
import { holdEnrollCode } from '@/state/enroll';

const escapedHost = SITE_HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SITE_LINK = new RegExp(`^https://${escapedHost}/r/?(?:[?#]|$)`, 'i');
const SCHEME_LINK = /^(?:catcher:\/\/\/?enroll\b|\/?enroll\b|\/r\/?(?:[?#]|$))/i;

export function enrollCodeFromUrl(url: string): string | null {
  if (!SITE_LINK.test(url) && !SCHEME_LINK.test(url)) return null;
  const hash = url.indexOf('#');
  if (hash >= 0) return url.slice(hash + 1);
  const query = /[?&]code=([^&#]+)/i.exec(url);
  if (query?.[1]) return decodeURIComponent(query[1]);
  return '';
}

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  const code = enrollCodeFromUrl(path);
  if (code === null) return path;
  if (code) holdEnrollCode(code);
  return '/';
}
