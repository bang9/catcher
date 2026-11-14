// HTTP helpers — JSON answers, errors, signed-request authentication.

import { AUTH_HEADER, AUTH_WINDOW_MS, authBytes, type ParsedAuth, parseAuth, unb64 } from '@catcher/protocol';

interface RateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  /** realtime notifier, one per owner — carries only "something new for X" signals */
  HUB: DurableObjectNamespace;
  REGISTER_LIMIT?: RateLimiter;
  OWNER_LIMIT?: RateLimiter;
  SEND_LIMIT?: RateLimiter;
  ENVELOPE_TTL_DAYS?: string;
  /** optional Expo access token when push security is turned on for the project */
  EXPO_ACCESS_TOKEN?: string;
  /** tests point this at a fake push endpoint */
  PUSH_URL?: string;
}

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: { code: e.code, message: e.message } }, e.status);
  // malformed input that slipped past validation (missing fields) — the caller's fault, not ours
  if (e instanceof TypeError) return json({ error: { code: 'bad_request', message: 'malformed request' } }, 400);
  console.error(e);
  return json({ error: { code: 'internal', message: 'internal error' } }, 500);
}

export function bad(message: string, code = 'bad_request'): never {
  throw new HttpError(400, code, message);
}

export function parseJson<T>(body: Uint8Array): T {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    return bad('body is not JSON');
  }
}

export interface Caller {
  kind: 'owner' | 'agent';
  id: string;
  ownerId: string;
  /** agents only */
  status?: string;
}

/** Ed25519 through native WebCrypto — far cheaper in CPU than a JS implementation on the Workers free plan. */
export async function verifyEd25519(signPub: string, sig: string, message: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', unb64(signPub), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, unb64(sig), message);
  } catch {
    return false;
  }
}

async function verifyAuth(auth: ParsedAuth, signPub: string, method: string, path: string, body: Uint8Array) {
  if (Math.abs(Date.now() - auth.ts) > AUTH_WINDOW_MS) return false;
  return verifyEd25519(signPub, auth.sig, authBytes(method, path, auth.ts, body));
}

/**
 * Verify a signed request against the caller's stored signing key.
 * `header` defaults to x-catcher-auth; the realtime stream passes it as ?auth= because WebSocket clients cannot set headers.
 */
export async function authenticate(
  env: Env,
  req: Request,
  path: string,
  body: Uint8Array,
  header: string | null = req.headers.get(AUTH_HEADER),
): Promise<Caller> {
  const auth = parseAuth(header);
  if (!auth) throw new HttpError(401, 'unauthenticated', 'missing or malformed x-catcher-auth header');
  let signPub: string | null = null;
  let caller: Caller | null = null;
  if (auth.callerId.startsWith('o_')) {
    const row = await env.DB.prepare('SELECT id, sign_pub FROM owners WHERE id = ?')
      .bind(auth.callerId)
      .first<{ id: string; sign_pub: string }>();
    if (row) {
      signPub = row.sign_pub;
      caller = { kind: 'owner', id: row.id, ownerId: row.id };
    }
  } else if (auth.callerId.startsWith('a_')) {
    const row = await env.DB.prepare('SELECT id, owner_id, sign_pub, status FROM agents WHERE id = ?')
      .bind(auth.callerId)
      .first<{ id: string; owner_id: string; sign_pub: string; status: string }>();
    if (row) {
      signPub = row.sign_pub;
      caller = { kind: 'agent', id: row.id, ownerId: row.owner_id, status: row.status };
    }
  }
  if (!signPub || !caller || !(await verifyAuth(auth, signPub, req.method, path, body))) {
    throw new HttpError(401, 'unauthenticated', 'request signature is invalid, expired, or the caller is unknown');
  }
  return caller;
}

export function requireOwner(caller: Caller): void {
  if (caller.kind !== 'owner') throw new HttpError(403, 'owner_only', 'only the owner can do this');
}

export function requireActiveAgentOrOwner(caller: Caller): void {
  if (caller.kind === 'agent' && caller.status !== 'active') {
    throw new HttpError(403, `agent_${caller.status}`, `this agent is ${caller.status}`);
  }
}
