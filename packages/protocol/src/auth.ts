// Request authentication — every API call is signed by the caller's Ed25519 key. No bearer tokens to leak.
// Header: x-catcher-auth: <callerId>.<timestampMs>.<signature b64url>
// Signed bytes: canonical({ctx, method, path (with query), ts, bodyHash})

import { b64, unb64, utf8 } from './bytes.ts';
import { canonical } from './canonical.ts';
import { sha256, sign, verify } from './crypto.ts';
import type { Identity } from './identity.ts';

export const AUTH_HEADER = 'x-catcher-auth';
export const AUTH_WINDOW_MS = 5 * 60 * 1000;

/** The bytes a request signature covers (exported so the relay can verify with native WebCrypto). */
export function authBytes(method: string, path: string, ts: number, body: Uint8Array): Uint8Array {
  return utf8(
    canonical({ ctx: 'catcher/v1/request', method: method.toUpperCase(), path, ts, bodyHash: b64(sha256(body)) }),
  );
}

export function signRequest(
  callerId: string,
  id: Pick<Identity, 'signSecret'>,
  method: string,
  path: string,
  body: Uint8Array,
  now = Date.now(),
): string {
  return `${callerId}.${now}.${b64(sign(authBytes(method, path, now, body), id.signSecret))}`;
}

export interface ParsedAuth {
  callerId: string;
  ts: number;
  sig: string;
}

export function parseAuth(header: string | null): ParsedAuth | null {
  if (!header) return null;
  const parts = header.split('.');
  if (parts.length !== 3) return null;
  const ts = Number(parts[1]);
  if (!parts[0] || !Number.isSafeInteger(ts) || !parts[2]) return null;
  return { callerId: parts[0], ts, sig: parts[2] };
}

export function verifyRequest(
  auth: ParsedAuth,
  signPub: string,
  method: string,
  path: string,
  body: Uint8Array,
  now = Date.now(),
): boolean {
  if (Math.abs(now - auth.ts) > AUTH_WINDOW_MS) return false;
  try {
    return verify(unb64(auth.sig), authBytes(method, path, auth.ts, body), unb64(signPub));
  } catch {
    return false;
  }
}
