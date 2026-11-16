// API handlers. The relay is a thin mailbox: it authenticates callers, applies cheap SQL pre-filters (sender, recipient,
// grant row, reply target), stores ciphertext, signals listeners and pushes the owner. Signature checks of envelopes,
// certs and grants happen on the agents and the phone, which re-verify everything anyway.

import {
  type AckRequest,
  type AgentSummary,
  type AppendOwnerKeyRequest,
  type CreateOwnerRequest,
  ENROLL_MAX_PROVIDER,
  type Envelope,
  ENVELOPE_TYPES,
  ID_PATTERN,
  NAME_PATTERN,
  OWNER_REQUEST_TYPES,
  type PostCertRequest,
  type PostEnvelopeRequest,
  type PostGrantRequest,
  type PostReleaseRequest,
  type PostRevocationsRequest,
  type PushTokenRequest,
  requiredRecipients,
  SCOPE_PATTERN,
  verifyOwnerChain,
  verifyStatement,
} from '@catcher/protocol';
import {
  bad,
  type Caller,
  clientIp,
  type Env,
  HttpError,
  json,
  limitOrThrow,
  parseJson,
  requireActiveAgentOrOwner,
  requireOwner,
} from './http.ts';
import { signal } from './hub.ts';
import { pushOwner } from './push.ts';
import { type AgentRow, type EnvelopeRow, getOwner, loadDirectory, nameOf, parseOrNull, toStored } from './store.ts';

const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
/** delivered envelopes stay this long after both sides have them (agent acked, owner app synced) */
const DELIVERED_GRACE_MS = 24 * 60 * 60 * 1000;

function ttlMs(env: Env): number {
  return Number(env.ENVELOPE_TTL_DAYS || '30') * 86_400_000;
}

function later(ctx: ExecutionContext, p: Promise<unknown>): void {
  ctx.waitUntil(p.catch((e) => console.warn('background task failed', e)));
}

function clampLimit(url: URL, fallback: number, max: number): number {
  const n = Math.floor(Number(url.searchParams.get('limit') ?? fallback));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function freshTime(t: number, now: number): void {
  if (!Number.isSafeInteger(t) || Math.abs(now - t) > CLOCK_SKEW_MS) {
    bad('statement time is too far from now (check the device clock)', 'stale');
  }
}

function statementError(e: unknown): never {
  if (e instanceof HttpError) throw e;
  return bad((e as Error).message, 'bad_statement');
}

async function bumpDirectory(env: Env, ctx: ExecutionContext, ownerId: string): Promise<void> {
  await env.DB.prepare('UPDATE owners SET dir_version = dir_version + 1 WHERE id = ?').bind(ownerId).run();
  later(ctx, signal(env, ownerId, { to: '*', kind: 'directory' }));
}

// ─── owner ───────────────────────────────────────────────────────────────────

/** Unauthenticated: the genesis key signs itself; the owner id is derived from it. */
export async function createOwner(env: Env, request: Request, body: Uint8Array): Promise<Response> {
  await limitOrThrow(env.OWNER_LIMIT, `owner:${clientIp(request)}`);
  const req = parseJson<CreateOwnerRequest>(body);
  if (!Array.isArray(req.chain)) bad('chain is required');
  const first = req.chain?.[0];
  if (!first || req.chain.length !== 1) bad('send exactly the genesis owner key');
  const ownerId = first.payload.ownerId;
  let keys: ReturnType<typeof verifyOwnerChain>;
  try {
    keys = verifyOwnerChain(req.chain, ownerId);
  } catch (e) {
    return bad((e as Error).message, 'bad_owner_key');
  }
  const now = Date.now();
  freshTime(first.payload.issuedAt, now);
  const existing = await env.DB.prepare('SELECT id FROM owners WHERE id = ?').bind(ownerId).first();
  if (existing) return json({ ownerId, created: false });
  await env.DB.prepare('INSERT INTO owners (id, sign_pub, box_pub, chain, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(ownerId, keys.signPub, keys.boxPub, JSON.stringify(req.chain), now)
    .run();
  return json({ ownerId, created: true }, 201);
}

/** Restore on a new phone: find the owner by its current signing key. */
export async function lookupOwner(env: Env, url: URL): Promise<Response> {
  const signPub = url.searchParams.get('signPub');
  if (!signPub) bad('signPub is required');
  const row = await env.DB.prepare('SELECT id, chain FROM owners WHERE sign_pub = ?')
    .bind(signPub)
    .first<{ id: string; chain: string }>();
  if (!row) throw new HttpError(404, 'not_found', 'no owner uses this key');
  return json({ ownerId: row.id, chain: JSON.parse(row.chain) });
}

/** Key rotation: the new link must be signed by the current key (the caller already proved it holds it). */
export async function appendOwnerKey(
  env: Env,
  caller: Caller,
  body: Uint8Array,
  ctx: ExecutionContext,
): Promise<Response> {
  requireOwner(caller);
  const { link } = parseJson<AppendOwnerKeyRequest>(body);
  const owner = await getOwner(env, caller.ownerId);
  const chain = [...JSON.parse(owner.chain), link];
  let keys: ReturnType<typeof verifyOwnerChain>;
  try {
    keys = verifyOwnerChain(chain, caller.ownerId);
  } catch (e) {
    return bad((e as Error).message, 'bad_owner_key');
  }
  await env.DB.prepare('UPDATE owners SET sign_pub = ?, box_pub = ?, chain = ? WHERE id = ?')
    .bind(keys.signPub, keys.boxPub, JSON.stringify(chain), caller.ownerId)
    .run();
  await bumpDirectory(env, ctx, caller.ownerId);
  return json({ ok: true, seq: keys.seq });
}

export async function putPushToken(env: Env, caller: Caller, body: Uint8Array): Promise<Response> {
  requireOwner(caller);
  const req = parseJson<PushTokenRequest>(body);
  if (typeof req.token !== 'string' || !req.token || req.token.length > 300) bad('token is required');
  if (!['ios', 'android', 'web'].includes(req.platform)) bad('platform must be ios, android or web');
  await env.DB.prepare(
    'INSERT INTO push_tokens (token, owner_id, platform, locale, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(token) DO UPDATE SET owner_id = excluded.owner_id, platform = excluded.platform, locale = excluded.locale, updated_at = excluded.updated_at',
  )
    .bind(req.token, caller.ownerId, req.platform, String(req.locale || 'en').slice(0, 16), Date.now())
    .run();
  return json({ ok: true });
}

export async function deletePushToken(env: Env, caller: Caller, body: Uint8Array): Promise<Response> {
  requireOwner(caller);
  const { token } = parseJson<{ token: string }>(body);
  await env.DB.prepare('DELETE FROM push_tokens WHERE token = ? AND owner_id = ?').bind(token, caller.ownerId).run();
  return json({ ok: true });
}

function agentSummary(r: AgentRow): AgentSummary {
  return {
    agentId: r.id,
    name: r.name,
    device: r.device,
    provider: r.provider,
    status: r.status as AgentSummary['status'],
    signPub: r.sign_pub,
    boxPub: r.box_pub,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    cert: parseOrNull(r.cert),
    removedAt: r.removed_at ?? null,
  };
}

export async function listAgents(env: Env, caller: Caller): Promise<Response> {
  requireOwner(caller);
  const { results } = await env.DB.prepare('SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at')
    .bind(caller.ownerId)
    .all<AgentRow>();
  const owner = await getOwner(env, caller.ownerId);
  const senderSeq: Record<string, number> = { [caller.ownerId]: owner.last_seq };
  for (const r of results) senderSeq[r.id] = r.last_seq;
  return json({ agents: results.map(agentSummary), senderSeq });
}

export async function postCert(env: Env, caller: Caller, body: Uint8Array, ctx: ExecutionContext): Promise<Response> {
  requireOwner(caller);
  const { cert } = parseJson<PostCertRequest>(body);
  const owner = await getOwner(env, caller.ownerId);
  let c: ReturnType<typeof verifyStatement<'cert'>>;
  try {
    c = verifyStatement(cert, 'cert', owner.sign_pub);
  } catch (e) {
    return statementError(e);
  }
  const agent = await env.DB.prepare('SELECT * FROM agents WHERE id = ? AND owner_id = ?')
    .bind(c.agentId, caller.ownerId)
    .first<AgentRow>();
  if (!agent) throw new HttpError(404, 'not_found', 'no such agent');
  if (agent.sign_pub !== c.signPub || agent.box_pub !== c.boxPub) {
    bad('cert does not match the registered agent keys', 'cert_mismatch');
  }
  // renewal, re-signing after a key rotation, a new name (a nickname the owner picks) or a corrected platform; new
  // agents arrive through a claim (enroll.ts)
  if (agent.status !== 'active') bad(`agent is ${agent.status}`, 'agent_closed');
  if (typeof c.name !== 'string' || !NAME_PATTERN.test(c.name)) {
    bad('name must be lowercase letters, digits and dashes (max 32)', 'bad_name');
  }
  if (typeof c.provider !== 'string' || c.provider.length > ENROLL_MAX_PROVIDER) {
    bad(`provider is at most ${ENROLL_MAX_PROVIDER} characters`, 'bad_statement');
  }
  try {
    await env.DB.prepare('UPDATE agents SET cert = ?, name = ?, provider = ? WHERE id = ?')
      .bind(JSON.stringify(cert), c.name, c.provider, c.agentId)
      .run();
  } catch (e) {
    // agents_owner_name: names are unique among the owner's live agents (agents address each other by name)
    if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? e))) {
      throw new HttpError(409, 'name_taken', `you already have an agent named ${c.name}`);
    }
    throw e;
  }
  await bumpDirectory(env, ctx, caller.ownerId);
  return json({ ok: true });
}

/** POST /v1/owner/agents/{id}/remove — take a disconnected agent off the owner's lists (the row stays). */
export async function removeAgent(env: Env, caller: Caller, agentId: string): Promise<Response> {
  requireOwner(caller);
  const agent = await env.DB.prepare('SELECT status FROM agents WHERE id = ? AND owner_id = ?')
    .bind(agentId, caller.ownerId)
    .first<{ status: string }>();
  if (!agent) throw new HttpError(404, 'not_found', 'no such agent');
  if (agent.status === 'active') bad('disconnect the agent before removing it', 'agent_active');
  await env.DB.prepare('UPDATE agents SET removed_at = ? WHERE id = ? AND owner_id = ? AND removed_at IS NULL')
    .bind(Date.now(), agentId, caller.ownerId)
    .run();
  return json({ ok: true });
}

export async function postGrant(env: Env, caller: Caller, body: Uint8Array, ctx: ExecutionContext): Promise<Response> {
  requireOwner(caller);
  const { grant } = parseJson<PostGrantRequest>(body);
  const owner = await getOwner(env, caller.ownerId);
  let g: ReturnType<typeof verifyStatement<'grant'>>;
  try {
    g = verifyStatement(grant, 'grant', owner.sign_pub);
  } catch (e) {
    return statementError(e);
  }
  if (g.ownerId !== caller.ownerId || !ID_PATTERN.grant.test(g.grantId)) bad('bad grant id or owner');
  if (!g.scopes.length || !g.scopes.every((s) => SCOPE_PATTERN.test(s))) bad('scopes must match [a-z0-9._:-]');
  const parties = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM agents WHERE owner_id = ? AND status = 'active' AND id IN (?, ?)",
  )
    .bind(caller.ownerId, g.from, g.to)
    .first<{ n: number }>();
  if (g.from === g.to || parties?.n !== 2) bad('both agents must be active and different');
  let requireApproval = 0;
  if (g.requireApproval) requireApproval = 1;
  await env.DB.prepare(
    'INSERT INTO grants (id, owner_id, from_id, to_id, statement, scopes, require_approval, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET statement = excluded.statement, scopes = excluded.scopes, require_approval = excluded.require_approval, expires_at = excluded.expires_at WHERE grants.owner_id = excluded.owner_id',
  )
    .bind(
      g.grantId,
      caller.ownerId,
      g.from,
      g.to,
      JSON.stringify(grant),
      JSON.stringify(g.scopes),
      requireApproval,
      g.expiresAt,
      Date.now(),
    )
    .run();
  await bumpDirectory(env, ctx, caller.ownerId);
  return json({ ok: true });
}

export async function postRevocations(
  env: Env,
  caller: Caller,
  body: Uint8Array,
  ctx: ExecutionContext,
): Promise<Response> {
  requireOwner(caller);
  const { revocations } = parseJson<PostRevocationsRequest>(body);
  const owner = await getOwner(env, caller.ownerId);
  let r: ReturnType<typeof verifyStatement<'revocations'>>;
  try {
    r = verifyStatement(revocations, 'revocations', owner.sign_pub);
  } catch (e) {
    return statementError(e);
  }
  if (r.ownerId !== caller.ownerId) bad('revocations for another owner');
  if (r.version <= owner.revocation_version) bad(`version must be above ${owner.revocation_version}`, 'stale_version');
  const stmts = [
    env.DB.prepare(
      'UPDATE owners SET revocations = ?, revocation_version = ?, dir_version = dir_version + 1 WHERE id = ?',
    ).bind(JSON.stringify(revocations), r.version, caller.ownerId),
  ];
  for (const a of r.agents) {
    stmts.push(
      env.DB.prepare("UPDATE agents SET status = 'revoked' WHERE id = ? AND owner_id = ?").bind(a, caller.ownerId),
    );
  }
  for (const g of r.grants) {
    stmts.push(env.DB.prepare('UPDATE grants SET revoked = 1 WHERE id = ? AND owner_id = ?').bind(g, caller.ownerId));
  }
  await env.DB.batch(stmts);
  later(ctx, signal(env, caller.ownerId, { to: '*', kind: 'directory' }));
  return json({ ok: true, version: r.version });
}

export async function postRelease(
  env: Env,
  caller: Caller,
  body: Uint8Array,
  ctx: ExecutionContext,
): Promise<Response> {
  requireOwner(caller);
  const { release } = parseJson<PostReleaseRequest>(body);
  const owner = await getOwner(env, caller.ownerId);
  let r: ReturnType<typeof verifyStatement<'release'>>;
  try {
    r = verifyStatement(release, 'release', owner.sign_pub);
  } catch (e) {
    return statementError(e);
  }
  const row = await env.DB.prepare(
    'SELECT cursor, to_id, envelope FROM envelopes WHERE id = ? AND owner_id = ? AND held = 1',
  )
    .bind(r.envelopeId, caller.ownerId)
    .first<{ cursor: number; to_id: string; envelope: string }>();
  if (!row) throw new HttpError(404, 'not_found', 'no held message with that id');
  if ((JSON.parse(row.envelope) as Envelope).ctHash !== r.ctHash)
    bad('release does not match the message', 'release_mismatch');
  await env.DB.prepare('UPDATE envelopes SET held = 0, release = ? WHERE id = ?')
    .bind(JSON.stringify(release), r.envelopeId)
    .run();
  later(ctx, signal(env, caller.ownerId, { to: row.to_id, kind: 'envelope', cursor: row.cursor, id: r.envelopeId }));
  return json({ ok: true });
}

/** Owner discards a held message instead of releasing it. */
export async function dropHeld(env: Env, caller: Caller, envelopeId: string): Promise<Response> {
  requireOwner(caller);
  const r = await env.DB.prepare('UPDATE envelopes SET held = 2 WHERE id = ? AND owner_id = ? AND held = 1')
    .bind(envelopeId, caller.ownerId)
    .run();
  if (!r.meta.changes) throw new HttpError(404, 'not_found', 'no held message with that id');
  return json({ ok: true });
}

/** Owner timeline sync. `after` doubles as the owner's ack: everything at or below it is on the phone. */
export async function ownerFeed(env: Env, caller: Caller, url: URL, ctx: ExecutionContext): Promise<Response> {
  requireOwner(caller);
  const after = Number(url.searchParams.get('after') ?? '0') || 0;
  const limit = clampLimit(url, 200, 500);
  const { results } = await env.DB.prepare(
    'SELECT * FROM envelopes WHERE owner_id = ? AND cursor > ? ORDER BY cursor LIMIT ?',
  )
    .bind(caller.ownerId, after, limit)
    .all<EnvelopeRow>();
  const envelopes = results.map(toStored);
  if (after > 0) {
    later(
      ctx,
      env.DB.prepare('UPDATE owners SET feed_cursor = ? WHERE id = ? AND feed_cursor < ?')
        .bind(after, caller.ownerId, after)
        .run(),
    );
  }
  return json({ envelopes, cursor: envelopes.at(-1)?.cursor ?? after });
}

/** Held state changes after the fact (release / drop) — the app re-reads these by id. */
export async function envelopeStates(env: Env, caller: Caller, url: URL): Promise<Response> {
  requireOwner(caller);
  const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).slice(0, 90);
  if (!ids.length) return json({ envelopes: [] });
  const { results } = await env.DB.prepare(
    `SELECT * FROM envelopes WHERE owner_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
  )
    .bind(caller.ownerId, ...ids)
    .all<EnvelopeRow>();
  return json({ envelopes: results.map(toStored) });
}

// ─── agent ───────────────────────────────────────────────────────────────────

export async function me(env: Env, caller: Caller): Promise<Response> {
  if (caller.kind !== 'agent') throw new HttpError(403, 'agent_only', 'only agents have /me');
  const row = await env.DB.prepare('SELECT * FROM agents WHERE id = ?').bind(caller.id).first<AgentRow>();
  if (!row) throw new HttpError(404, 'not_found', 'agent missing');
  return json({
    agentId: row.id,
    ownerId: row.owner_id,
    name: row.name,
    status: row.status,
    cert: parseOrNull(row.cert),
    lastSeq: row.last_seq,
  });
}

/** `?known=<version>` returns {unchanged: true} when the agent's cached directory is current. */
export async function directory(env: Env, caller: Caller, url: URL): Promise<Response> {
  requireActiveAgentOrOwner(caller);
  const known = Number(url.searchParams.get('known') ?? '0');
  const v = await env.DB.prepare('SELECT dir_version FROM owners WHERE id = ?')
    .bind(caller.ownerId)
    .first<{ dir_version: number }>();
  if (known && v && known === v.dir_version) return json({ unchanged: true, version: v.dir_version });
  let forAgent: string | undefined;
  if (caller.kind === 'agent') forAgent = caller.id;
  return json({ ...(await loadDirectory(env, caller.ownerId, forAgent)), version: v?.dir_version ?? 0 });
}

async function touch(env: Env, caller: Caller, now: number): Promise<void> {
  if (caller.kind !== 'agent') return;
  await env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)')
    .bind(now, caller.id, now - LAST_SEEN_THROTTLE_MS)
    .run();
}

/**
 * The heartbeat. One indexed read when empty; dirVersion tells the agent whether its cached directory is stale.
 * `after` pages past unacked messages the agent is still working on (acks are explicit).
 */
export async function inbox(env: Env, caller: Caller, url: URL, ctx: ExecutionContext): Promise<Response> {
  requireActiveAgentOrOwner(caller);
  const limit = clampLimit(url, 50, 200);
  let after = Math.floor(Number(url.searchParams.get('after') ?? '0'));
  if (!Number.isSafeInteger(after) || after < 0) after = 0;
  const [rows, version] = await env.DB.batch([
    env.DB.prepare(
      'SELECT * FROM envelopes WHERE to_id = ? AND acked_at IS NULL AND held = 0 AND cursor > ? ORDER BY cursor LIMIT ?',
    ).bind(caller.id, after, limit),
    env.DB.prepare('SELECT dir_version FROM owners WHERE id = ?').bind(caller.ownerId),
  ]);
  later(ctx, touch(env, caller, Date.now()));
  const results = (rows?.results ?? []) as EnvelopeRow[];
  const dirVersion = (version?.results?.[0] as { dir_version?: number } | undefined)?.dir_version ?? 0;
  return json({ envelopes: results.map(toStored), dirVersion });
}

export async function ack(env: Env, caller: Caller, body: Uint8Array): Promise<Response> {
  requireActiveAgentOrOwner(caller);
  const { ids } = parseJson<AckRequest>(body);
  if (!Array.isArray(ids) || ids.length > 200) bad('ids must be a list of at most 200 envelope ids');
  const now = Date.now();
  let acked = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    const r = await env.DB.prepare(
      `UPDATE envelopes SET acked_at = ? WHERE to_id = ? AND acked_at IS NULL AND id IN (${part.map(() => '?').join(',')})`,
    )
      .bind(now, caller.id, ...part)
      .run();
    acked += r.meta.changes ?? 0;
  }
  return json({ acked });
}

/** Answers/replies to one of the caller's messages that are still in the mailbox. */
export async function replies(env: Env, caller: Caller, url: URL): Promise<Response> {
  requireActiveAgentOrOwner(caller);
  const ref = url.searchParams.get('ref');
  if (!ref) bad('ref is required');
  const { results } = await env.DB.prepare(
    'SELECT * FROM envelopes WHERE ref = ? AND to_id = ? AND held = 0 ORDER BY cursor',
  )
    .bind(ref, caller.id)
    .all<EnvelopeRow>();
  return json({ envelopes: results.map(toStored) });
}

// ─── envelopes (owner and agents) ────────────────────────────────────────────

function structural(envelope: Envelope): void {
  const c = envelope?.core;
  if (!c || c.v !== 1) bad('envelope missing or unsupported version');
  if (!ENVELOPE_TYPES.includes(c.type)) bad('unknown envelope type');
  if (!ID_PATTERN.envelope.test(c.id)) bad('envelope id must look like m_ + 26 base32 characters');
  if (!Number.isSafeInteger(c.seq) || c.seq < 1) bad('seq must be a positive integer');
  if (typeof c.from !== 'string' || typeof c.to !== 'string' || typeof c.ownerId !== 'string') bad('bad parties');
  if (c.scope !== null && (typeof c.scope !== 'string' || !SCOPE_PATTERN.test(c.scope))) bad('bad scope');
  if (c.grantId !== null && (typeof c.grantId !== 'string' || !ID_PATTERN.grant.test(c.grantId))) bad('bad grant id');
  if (!Number.isSafeInteger(c.createdAt)) bad('createdAt must be an integer');
  if (c.expiresAt !== null && !Number.isSafeInteger(c.expiresAt)) bad('expiresAt must be an integer or null');
  if (c.from === c.to) bad('cannot send to yourself');
  if (c.type === 'reply' || c.type === 'answer') {
    if (typeof c.ref !== 'string' || !ID_PATTERN.envelope.test(c.ref)) bad(`${c.type} needs ref`);
  } else if (c.ref !== null) {
    bad('only replies and answers carry ref');
  }
  if (c.type === 'answer' && c.from !== c.ownerId) bad('only the owner can answer');
  if (OWNER_REQUEST_TYPES.includes(c.type) && c.to !== c.ownerId) bad(`${c.type} goes to the owner only`);
  const need = requiredRecipients(c);
  const ids = (envelope.wraps ?? []).map((w) => w.to);
  if (ids.length !== need.length || !need.every((id) => ids.includes(id))) {
    bad('envelope must be readable by exactly the recipient, the owner and the sender', 'bad_recipients');
  }
  if (typeof envelope.ct !== 'string' || envelope.ct.length > 120_000)
    throw new HttpError(413, 'too_large', 'message is too large');
}

export async function postEnvelope(
  env: Env,
  caller: Caller,
  body: Uint8Array,
  ctx: ExecutionContext,
): Promise<Response> {
  requireActiveAgentOrOwner(caller);
  await limitOrThrow(env.SEND_LIMIT, `send:${caller.id}`);
  const { envelope } = parseJson<PostEnvelopeRequest>(body);
  structural(envelope);
  const c = envelope.core;
  if (c.from !== caller.id) throw new HttpError(403, 'not_sender', 'you can only send as yourself');
  if (c.ownerId !== caller.ownerId) throw new HttpError(403, 'owner_mismatch', 'envelope is for another owner');
  const now = Date.now();
  if (Math.abs(now - c.createdAt) > CLOCK_SKEW_MS)
    bad('message time is too far from now (check the device clock)', 'stale');

  // idempotent retry: same id from the same sender returns the stored row
  const existing = await env.DB.prepare('SELECT cursor, from_id, held, envelope FROM envelopes WHERE id = ?')
    .bind(c.id)
    .first<{ cursor: number; from_id: string; held: number; envelope: string }>();
  if (existing) {
    // only an identical resend is a retry; a new message under an old id is refused (no replaying old answers)
    const same =
      existing.from_id === caller.id && (JSON.parse(existing.envelope) as Envelope).ctHash === envelope.ctHash;
    if (!same) throw new HttpError(409, 'id_taken', 'envelope id already used');
    return json({ cursor: existing.cursor, held: existing.held === 1, duplicate: true });
  }

  let seqTable = 'agents';
  if (caller.kind === 'owner') seqTable = 'owners';
  const last = await env.DB.prepare(`SELECT last_seq FROM ${seqTable} WHERE id = ?`)
    .bind(caller.id)
    .first<{ last_seq: number }>();
  const lastSeq = last?.last_seq ?? 0;
  if (c.seq <= lastSeq) throw new HttpError(409, 'stale_seq', `seq must be above ${lastSeq}`);

  if (c.to !== caller.ownerId) {
    const target = await env.DB.prepare("SELECT id FROM agents WHERE id = ? AND owner_id = ? AND status = 'active'")
      .bind(c.to, caller.ownerId)
      .first();
    if (!target) throw new HttpError(404, 'unknown_party', 'recipient is not an active agent');
  }

  let held = 0;
  const agentToAgent = c.from !== caller.ownerId && c.to !== caller.ownerId;
  if (c.from === caller.ownerId && !['message', 'answer'].includes(c.type)) bad(`owner does not send ${c.type}`);
  if (agentToAgent && c.type !== 'message' && c.type !== 'reply') {
    throw new HttpError(403, 'bad_type', `agents do not send ${c.type} to each other`);
  }
  if (agentToAgent && c.type === 'message') {
    if (!c.grantId || !c.scope) throw new HttpError(403, 'no_grant', 'agent messages need a scope and a grant');
    const g = await liveGrant(env, c.grantId, now);
    if (!g || g.from_id !== c.from || g.to_id !== c.to || !(JSON.parse(g.scopes) as string[]).includes(c.scope)) {
      throw new HttpError(403, 'no_grant', `no live grant lets ${c.from} send ${c.scope} to ${c.to}`);
    }
    held = g.require_approval;
  }

  // replies answer a message (not a reply) sent the other way, once; answers settle an owner request, once
  if (c.type === 'reply' || c.type === 'answer') {
    const ref = await env.DB.prepare(
      'SELECT from_id, to_id, type, envelope FROM envelopes WHERE id = ? AND owner_id = ?',
    )
      .bind(c.ref, caller.ownerId)
      .first<{ from_id: string; to_id: string; type: string; envelope: string }>();
    if (!ref || ref.from_id !== c.to || ref.to_id !== c.from) {
      throw new HttpError(403, 'bad_ref', `${c.type} must answer a message ${c.to} sent to ${c.from}`);
    }
    if (c.type === 'reply' && ref.type !== 'message')
      throw new HttpError(403, 'bad_ref', 'replies answer messages only');
    if (c.type === 'answer' && !OWNER_REQUEST_TYPES.includes(ref.type as never)) {
      throw new HttpError(403, 'bad_ref', 'answers settle asks, confirms, otp and grant requests only');
    }
    const dup = await env.DB.prepare('SELECT id FROM envelopes WHERE ref = ? AND from_id = ? AND type = ?')
      .bind(c.ref, c.from, c.type)
      .first();
    if (dup) throw new HttpError(409, 'already_answered', `this message already has a ${c.type}`);
    if (c.type === 'reply' && agentToAgent) {
      const refGrant = (JSON.parse(ref.envelope) as Envelope).core.grantId;
      const g = await liveGrant(env, c.grantId ?? '', now);
      if (!g || c.grantId !== refGrant)
        throw new HttpError(403, 'no_grant', 'reply must name the live grant of the message');
      held = g.require_approval;
    }
  }

  const stmts = [
    env.DB.prepare(
      'INSERT INTO envelopes (id, owner_id, from_id, to_id, type, ref, envelope, held, received_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(c.id, caller.ownerId, c.from, c.to, c.type, c.ref, JSON.stringify(envelope), held, now, now + ttlMs(env)),
    env.DB.prepare(`UPDATE ${seqTable} SET last_seq = ? WHERE id = ? AND last_seq < ?`).bind(c.seq, caller.id, c.seq),
  ];
  // the owner's copy of a request is settled once answered
  if (c.type === 'answer') {
    stmts.push(env.DB.prepare('UPDATE envelopes SET acked_at = ? WHERE id = ? AND acked_at IS NULL').bind(now, c.ref));
  }
  const [ins] = await env.DB.batch(stmts);
  const cursor = Number(ins?.meta.last_row_id ?? 0);
  if (caller.kind === 'agent') later(ctx, touch(env, caller, now));

  if (held) {
    later(
      ctx,
      (async () =>
        pushOwner(env, caller.ownerId, {
          kind: 'held',
          fromName: await nameOf(env, c.from, caller.ownerId),
          toName: await nameOf(env, c.to, caller.ownerId),
          envelopeId: c.id,
        }))(),
    );
    later(ctx, signal(env, caller.ownerId, { to: caller.ownerId, kind: 'envelope', cursor, id: c.id }));
  } else {
    later(ctx, signal(env, caller.ownerId, { to: c.to, kind: 'envelope', cursor, id: c.id }));
    if (c.to === caller.ownerId) {
      later(
        ctx,
        (async () =>
          pushOwner(env, caller.ownerId, {
            kind: 'envelope',
            type: c.type,
            fromName: await nameOf(env, c.from, caller.ownerId),
            envelopeId: c.id,
          }))(),
      );
    }
  }
  return json({ cursor, held: held === 1, duplicate: false }, 201);
}

async function liveGrant(env: Env, grantId: string, now: number) {
  return env.DB.prepare(
    'SELECT from_id, to_id, scopes, require_approval FROM grants WHERE id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?)',
  )
    .bind(grantId, now)
    .first<{ from_id: string; to_id: string; scopes: string; require_approval: number }>();
}

// ─── housekeeping ────────────────────────────────────────────────────────────

/**
 * Hourly. The relay keeps nothing it does not need: an envelope goes once the recipient acked it and the owner app
 * synced past it (plus a day of grace for retries), or after the hard TTL if nobody ever picked it up.
 */
export async function cleanup(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    // delivered to an agent (acked) or plain chat to the owner, and already synced to the owner's phone
    env.DB.prepare(
      `DELETE FROM envelopes WHERE received_at < ?
         AND (acked_at IS NOT NULL OR (to_id = owner_id AND type IN ('message', 'reply')))
         AND cursor <= (SELECT feed_cursor FROM owners WHERE owners.id = envelopes.owner_id)`,
    ).bind(now - DELIVERED_GRACE_MS),
    env.DB.prepare('DELETE FROM envelopes WHERE held = 2 AND received_at < ?').bind(now - DELIVERED_GRACE_MS),
    env.DB.prepare('DELETE FROM envelopes WHERE expires_at < ?').bind(now),
    // unclaimed codes a day after they expired (their lookup is reserved until then); claimed ones 24 h after the
    // agent's first call, 30 days at most (enroll.ts)
    env.DB.prepare(
      'DELETE FROM enrollments WHERE (claimed_at IS NULL AND expires_at < ?) OR (claimed_at IS NOT NULL AND expires_at < ?)',
    ).bind(now - 86_400_000, now),
  ]);
}
