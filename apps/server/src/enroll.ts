// Agent-first registration on the relay. The agent posts a self-signed enroll statement under the lookup (first five
// characters of its code); the owner's app fetches it by lookup, checks it against the rest of the code locally, and
// posts an owner-signed claim plus cert. The relay never sees the secret or tag part of the code, so it cannot claim or
// swap anything itself — it only stores, matches and rate-limits. See packages/protocol/src/enroll.ts.

import {
  agentIdFor,
  AUTH_HEADER,
  type CertPayload,
  type ClaimEnrollmentRequest,
  type ClaimPayload,
  ENROLL_MAX_DEVICE,
  ENROLL_MAX_PROVIDER,
  ENROLL_TTL_MS,
  type EnrollPayload,
  type EnrollRequest,
  isLookup,
  NAME_PATTERN,
  parseAuth,
  verifyEnroll,
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
  requireOwner,
  verifyAuth,
} from './http.ts';
import { signal } from './hub.ts';
import { getOwner, parseOrNull } from './store.ts';

/** an enroll request is one small statement */
const MAX_ENROLL_BODY = 2048;
/** unclaimed, unexpired registrations across the whole relay */
const MAX_LIVE_ENROLLMENTS = 5000;
/** a claimed row stays until the agent has fetched its claim: 24 h after its first call, 30 days at most */
const CLAIMED_KEEP_MS = 30 * 86_400_000;
const CLAIMED_GRACE_MS = 86_400_000;
const CLOCK_SKEW_MS = 10 * 60 * 1000;

interface EnrollmentRow {
  lookup: string;
  agent_id: string;
  sign_pub: string;
  statement: string;
  created_at: number;
  expires_at: number;
  claimed_by: string | null;
  claimed_at: number | null;
  claim: string | null;
}

function later(ctx: ExecutionContext, p: Promise<unknown>): void {
  ctx.waitUntil(p.catch((e) => console.warn('background task failed', e)));
}

function badCode(): never {
  throw new HttpError(
    404,
    'bad_code',
    'this registration code is wrong or expired — ask the agent to run register again',
  );
}

function isLive(row: EnrollmentRow, now: number): boolean {
  return row.claimed_at === null && row.expires_at > now;
}

async function enrollment(env: Env, lookup: string): Promise<EnrollmentRow | null> {
  return env.DB.prepare('SELECT * FROM enrollments WHERE lookup = ?').bind(lookup).first<EnrollmentRow>();
}

function payloadOf(row: EnrollmentRow): EnrollPayload {
  return (JSON.parse(row.statement) as { payload: EnrollPayload }).payload;
}

function uniqueViolation(e: unknown): boolean {
  return /UNIQUE|constraint/i.test(String((e as Error)?.message ?? e));
}

/** POST /v1/enroll — unauthenticated; the statement is signed by the key it registers. */
export async function enroll(env: Env, req: Request, body: Uint8Array, ctx: ExecutionContext): Promise<Response> {
  await limitOrThrow(env.ENROLL_LIMIT, `enroll:${clientIp(req)}`);
  if (body.length >= MAX_ENROLL_BODY) throw new HttpError(400, 'too_long', 'registration request is too large');
  const { statement } = parseJson<EnrollRequest>(body);
  const p = statement?.payload;
  if (p?.kind !== 'enroll') bad('expected an enroll statement', 'bad_statement');
  if (!isLookup(p.lookup)) bad('lookup must be 5 code characters', 'bad_lookup');
  if (typeof p.name !== 'string' || !NAME_PATTERN.test(p.name)) {
    bad('name must be lowercase letters, digits and dashes (max 32)', 'bad_name');
  }
  if (typeof p.device !== 'string' || typeof p.provider !== 'string')
    bad('device and provider are required', 'bad_statement');
  // never shortened: the app shows exactly what the agent signed
  if (p.device.length > ENROLL_MAX_DEVICE || p.provider.length > ENROLL_MAX_PROVIDER) {
    throw new HttpError(
      400,
      'too_long',
      `device is at most ${ENROLL_MAX_DEVICE} and provider ${ENROLL_MAX_PROVIDER} characters`,
    );
  }
  try {
    verifyEnroll(statement, p.lookup);
  } catch (e) {
    bad((e as Error).message, 'bad_statement');
  }
  const now = Date.now();
  if (!Number.isSafeInteger(p.issuedAt) || Math.abs(now - p.issuedAt) > CLOCK_SKEW_MS) {
    bad('statement time is too far from now (check the device clock)', 'stale');
  }
  const agentId = agentIdFor(p.signPub);
  // housekeeping on the way: expired codes free their lookup and their slot
  later(ctx, env.DB.prepare('DELETE FROM enrollments WHERE claimed_at IS NULL AND expires_at <= ?').bind(now).run());

  const { results } = await env.DB.prepare('SELECT * FROM enrollments WHERE lookup = ? OR sign_pub = ?')
    .bind(p.lookup, p.signPub)
    .all<EnrollmentRow>();
  for (const row of results) {
    // the same agent posting the same registration again (its first answer was lost): same answer
    if (row.lookup === p.lookup && row.sign_pub === p.signPub && isLive(row, now)) {
      // only the identical statement (Ed25519 is deterministic: same payload, same signature)
      if ((JSON.parse(row.statement) as { sig?: string }).sig !== statement.sig) {
        throw new HttpError(409, 'lookup_taken', 'this code is taken by a different registration');
      }
      return json({ agentId: row.agent_id, expiresAt: row.expires_at });
    }
    if (row.sign_pub === p.signPub && !(row.claimed_at === null && row.expires_at <= now)) {
      throw new HttpError(409, 'key_taken', 'this key is already registered');
    }
    if (row.lookup === p.lookup && !(row.claimed_at === null && row.expires_at <= now)) {
      throw new HttpError(409, 'lookup_taken', 'this code is taken — pick another');
    }
  }
  const known = await env.DB.prepare('SELECT id FROM agents WHERE sign_pub = ? OR id = ?')
    .bind(p.signPub, agentId)
    .first();
  if (known) throw new HttpError(409, 'key_taken', 'this key is already registered');
  const live = await env.DB.prepare('SELECT COUNT(*) AS n FROM enrollments WHERE claimed_at IS NULL AND expires_at > ?')
    .bind(now)
    .first<{ n: number }>();
  if ((live?.n ?? 0) >= MAX_LIVE_ENROLLMENTS) {
    throw new HttpError(503, 'busy', 'too many registrations are waiting right now; try again in a few minutes');
  }
  const expiresAt = now + ENROLL_TTL_MS;
  try {
    await env.DB.batch([
      // an expired row under the same lookup or key goes first
      env.DB.prepare(
        'DELETE FROM enrollments WHERE (lookup = ? OR sign_pub = ?) AND claimed_at IS NULL AND expires_at <= ?',
      ).bind(p.lookup, p.signPub, now),
      env.DB.prepare(
        'INSERT INTO enrollments (lookup, agent_id, sign_pub, statement, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(p.lookup, agentId, p.signPub, JSON.stringify(statement), now, expiresAt),
    ]);
  } catch (e) {
    if (!uniqueViolation(e)) throw e;
    // lost a race for the lookup or the key
    const row = await enrollment(env, p.lookup);
    if (row && row.sign_pub !== p.signPub)
      throw new HttpError(409, 'lookup_taken', 'this code is taken — pick another');
    throw new HttpError(409, 'key_taken', 'this key is already registered');
  }
  return json({ agentId, expiresAt }, 201);
}

/**
 * GET /v1/enroll/{lookup} — the enrolling agent polls for its claim. Signed with the enrolling key: the header's caller
 * id is the agent id the relay derived from it.
 */
export async function enrollStatus(env: Env, req: Request, url: URL, lookup: string): Promise<Response> {
  const auth = parseAuth(req.headers.get(AUTH_HEADER));
  if (!auth) throw new HttpError(401, 'unauthenticated', 'missing or malformed x-catcher-auth header');
  // keyed by the code, not the unverified caller id in the header
  await limitOrThrow(env.ENROLL_POLL_LIMIT, `poll:${lookup}`);
  const row = await enrollment(env, lookup);
  if (!row) throw new HttpError(404, 'not_found', 'no registration under this code');
  const ok =
    auth.callerId === row.agent_id &&
    (await verifyAuth(auth, row.sign_pub, 'GET', url.pathname + url.search, new Uint8Array()));
  if (!ok)
    throw new HttpError(401, 'unauthenticated', 'request signature is invalid, expired, or not this registration');
  if (row.claimed_at === null) {
    if (row.expires_at <= Date.now()) throw new HttpError(410, 'expired', 'this registration code expired');
    return json({ status: 'waiting', expiresAt: row.expires_at });
  }
  const agent = await env.DB.prepare('SELECT cert FROM agents WHERE id = ?')
    .bind(row.agent_id)
    .first<{ cert: string | null }>();
  return json({ status: 'claimed', claim: parseOrNull(row.claim), cert: parseOrNull(agent?.cert ?? null) });
}

/** GET /v1/owner/enrollments/{lookup} — the owner's app fetches what to check against the code. */
export async function ownerEnrollment(env: Env, caller: Caller, lookup: string): Promise<Response> {
  requireOwner(caller);
  await limitOrThrow(env.ENROLL_LOOKUP_LIMIT, `lookup:${caller.ownerId}`);
  const row = await enrollment(env, lookup);
  const now = Date.now();
  if (!row || (row.claimed_at === null && row.expires_at <= now)) badCode();
  if (row.claimed_at !== null) throw new HttpError(409, 'claimed', 'this registration code was already used');
  const name = payloadOf(row).name;
  const existing = await env.DB.prepare("SELECT id FROM agents WHERE owner_id = ? AND name = ? AND status = 'active'")
    .bind(caller.ownerId, name)
    .first<{ id: string }>();
  const out: { statement: unknown; expiresAt: number; existing?: { agentId: string } } = {
    statement: JSON.parse(row.statement),
    expiresAt: row.expires_at,
  };
  if (existing) out.existing = { agentId: existing.id };
  return json(out);
}

/**
 * POST /v1/owner/enrollments/{lookup}/claim {claim, cert, replace?} — one transaction: mark the code claimed (if it is
 * still open and the name is free) and create the active agent with its cert. `replace` names the old same-name agent
 * the owner revoked first.
 */
export async function claimEnrollment(
  env: Env,
  caller: Caller,
  lookup: string,
  body: Uint8Array,
  ctx: ExecutionContext,
): Promise<Response> {
  requireOwner(caller);
  const req = parseJson<ClaimEnrollmentRequest>(body);
  const owner = await getOwner(env, caller.ownerId);
  let claim: ClaimPayload;
  let cert: CertPayload;
  try {
    claim = verifyStatement(req.claim, 'claim', owner.sign_pub);
    cert = verifyStatement(req.cert, 'cert', owner.sign_pub);
  } catch (e) {
    return bad(`${(e as Error).message} (sign with the current owner key)`, 'bad_statement');
  }
  if (claim.ownerId !== caller.ownerId || cert.ownerId !== caller.ownerId)
    bad('claim is for another owner', 'bad_statement');
  if (claim.ownerSignPub !== owner.sign_pub || claim.ownerBoxPub !== owner.box_pub) {
    bad('claim must name the current owner keys', 'bad_statement');
  }
  if (claim.lookup !== lookup) bad('claim is for another code', 'bad_statement');
  const now = Date.now();
  if (!Number.isSafeInteger(claim.issuedAt) || Math.abs(now - claim.issuedAt) > CLOCK_SKEW_MS) {
    bad('statement time is too far from now (check the device clock)', 'stale');
  }
  const row = await enrollment(env, lookup);
  if (!row || (row.claimed_at === null && row.expires_at <= now)) badCode();
  if (row.claimed_at !== null) throw new HttpError(409, 'claimed', 'this registration code was already used');
  const e = payloadOf(row);
  if (claim.agentId !== row.agent_id || claim.agentSignPub !== e.signPub || claim.agentBoxPub !== e.boxPub) {
    bad('claim does not match the registration', 'bad_statement');
  }
  if (
    cert.agentId !== row.agent_id ||
    cert.name !== e.name ||
    cert.signPub !== e.signPub ||
    cert.boxPub !== e.boxPub ||
    cert.device !== e.device ||
    cert.provider !== e.provider
  ) {
    bad('cert does not match the registration', 'cert_mismatch');
  }
  if (req.replace !== undefined) {
    const old = await env.DB.prepare('SELECT name FROM agents WHERE id = ? AND owner_id = ?')
      .bind(req.replace, caller.ownerId)
      .first<{ name: string }>();
    if (!old || old.name !== e.name) bad('replace must name your old agent with this name', 'bad_replace');
  }
  const claimText = JSON.stringify(req.claim);
  const won = 'EXISTS (SELECT 1 FROM enrollments WHERE lookup = ? AND claim = ?)';
  let changed = 0;
  try {
    const [update] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE enrollments SET claimed_by = ?, claimed_at = ?, claim = ?, expires_at = ?
           WHERE lookup = ? AND claimed_at IS NULL AND expires_at > ?
             AND NOT EXISTS (SELECT 1 FROM agents WHERE owner_id = ? AND name = ? AND status IN ('pending', 'active'))`,
      ).bind(caller.ownerId, now, claimText, now + CLAIMED_KEEP_MS, lookup, now, caller.ownerId, e.name),
      env.DB.prepare(
        `INSERT INTO agents (id, owner_id, name, sign_pub, box_pub, device, provider, status, cert, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, 'active', ?, ? WHERE ${won}`,
      ).bind(
        row.agent_id,
        caller.ownerId,
        e.name,
        e.signPub,
        e.boxPub,
        e.device,
        e.provider,
        JSON.stringify(req.cert),
        now,
        lookup,
        claimText,
      ),
      env.DB.prepare(`UPDATE owners SET dir_version = dir_version + 1 WHERE id = ? AND ${won}`).bind(
        caller.ownerId,
        lookup,
        claimText,
      ),
    ]);
    changed = update?.meta.changes ?? 0;
  } catch (err) {
    // the batch is one transaction: nothing was written
    if (!uniqueViolation(err)) throw err;
  }
  if (!changed) {
    const again = await enrollment(env, lookup);
    if (!again || (again.claimed_at === null && again.expires_at <= now)) badCode();
    if (again.claimed_at !== null) throw new HttpError(409, 'claimed', 'this registration code was already used');
    // still open: the code stays claimable once the name is free
    throw new HttpError(
      409,
      'name_taken',
      `you already have an agent named ${e.name} — replace it or ask for another name`,
    );
  }
  later(ctx, signal(env, caller.ownerId, { to: '*', kind: 'directory' }));
  later(ctx, signal(env, caller.ownerId, { to: caller.ownerId, kind: 'registration', id: row.agent_id }));
  return json({ agentId: row.agent_id }, 201);
}

/** First authenticated call of a new agent: it has its claim, so the claimed row may go a day later. */
export async function agentFirstSeen(env: Env, agentId: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ? AND last_seen_at IS NULL').bind(now, agentId),
    env.DB.prepare(
      'UPDATE enrollments SET expires_at = ? WHERE agent_id = ? AND claimed_at IS NOT NULL AND expires_at > ?',
    ).bind(now + CLAIMED_GRACE_MS, agentId, now + CLAIMED_GRACE_MS),
  ]);
}

export function gone(): Response {
  throw new HttpError(
    410,
    'gone',
    'pairing codes are gone in catcher 0.2 — the agent runs `catcher register --name <name>`',
  );
}
