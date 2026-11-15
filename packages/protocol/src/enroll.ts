// Agent-first registration. The agent makes a 16-character code and shows it (or a link with it) to its user only;
// the owner types it in the app, checks it against what the relay returns, and claims the agent in one step.
//
//   code    = L(lookup, 5) S(secret, 5) T(tag, 5) check(1), Crockford, shown as XXXX-XXXX-XXXX-XXXX
//   T       = b32(SHA-256(canonical({ctx: "catcher/v1/enroll-tag", lookup, secret, signPub, boxPub}))[0..4])[0..5]
//   check   = b32(SHA-256("catcher/v1/enroll-check" + L + S + T)[0..1])[0..1]
//   agentId = "a_" + lower(b32(SHA-256("catcher/v1/agent" ‖ signPub)[0..10]))
//
// Only L ever reaches the relay. T binds the code to the agent's keys, so a relay that swaps the enroll statement for
// its own agent fails the owner's tag check. The owner's claim seals S to the agent's box key; the agent accepts only
// a claim that carries its own S, so an owner who never saw the code cannot claim the agent.

import { NAME_PATTERN } from './api.ts';
import { b32, b64, concat, CROCKFORD, equalBytes, groups, normalizeB32, unb64, utf8 } from './bytes.ts';
import { canonical } from './canonical.ts';
import { boxPublic, derive, randomBytes, type Random, seal, sha256, sharedSecret, unseal } from './crypto.ts';
import type { Identity, PublicKeys } from './identity.ts';
import { type ClaimPayload, type EnrollPayload, type Signed, signStatement, verifyStatement } from './statements.ts';

/** How long a registration code stays claimable. */
export const ENROLL_TTL_MS = 10 * 60 * 1000;
/** Tag mismatches the owner app allows per lookup before it refuses that code. */
export const ENROLL_MAX_MISMATCHES = 3;
/** Longest device / provider text the relay accepts (it never shortens a signed statement). */
export const ENROLL_MAX_DEVICE = 80;
export const ENROLL_MAX_PROVIDER = 40;

const PART = 5;
const CODE_LENGTH = 3 * PART + 1;

export interface EnrollCode {
  lookup: string;
  secret: string;
  tag: string;
  check: string;
  /** XXXX-XXXX-XXXX-XXXX */
  code: string;
}

export type EnrollCodeProblem = 'bad_length' | 'bad_char' | 'bad_check';

export class EnrollCodeError extends Error {
  code: EnrollCodeProblem;
  constructor(code: EnrollCodeProblem, message: string) {
    super(message);
    this.code = code;
  }
}

export function agentIdFor(signPub: string): string {
  return `a_${b32(sha256(concat(utf8('catcher/v1/agent'), utf8(signPub))).subarray(0, 10)).toLowerCase()}`;
}

/** Ten random bytes → L (bytes 0..4) and S (bytes 5..9), one character per byte. */
export function enrollParts(random10: Uint8Array): { lookup: string; secret: string } {
  if (random10.length !== 10) throw new Error('enroll parts need 10 random bytes');
  let lookup = '';
  let secret = '';
  for (let i = 0; i < PART; i++) lookup += CROCKFORD[random10[i]! & 31];
  for (let i = PART; i < 2 * PART; i++) secret += CROCKFORD[random10[i]! & 31];
  return { lookup, secret };
}

export function enrollTag(lookup: string, secret: string, keys: PublicKeys): string {
  const digest = sha256(
    utf8(canonical({ ctx: 'catcher/v1/enroll-tag', lookup, secret, signPub: keys.signPub, boxPub: keys.boxPub })),
  );
  return b32(digest.subarray(0, 4)).slice(0, PART);
}

export function enrollCheck(lookup: string, secret: string, tag: string): string {
  return b32(sha256(utf8(`catcher/v1/enroll-check${lookup}${secret}${tag}`)).subarray(0, 1)).slice(0, 1);
}

export function enrollCode(lookup: string, secret: string, keys: PublicKeys): EnrollCode {
  const tag = enrollTag(lookup, secret, keys);
  const check = enrollCheck(lookup, secret, tag);
  return { lookup, secret, tag, check, code: groups(`${lookup}${secret}${tag}${check}`, 4) };
}

export function newEnrollCode(keys: PublicKeys, random: Random = randomBytes): EnrollCode {
  const { lookup, secret } = enrollParts(random(10));
  return enrollCode(lookup, secret, keys);
}

/** `<server>/r#<code>` — the fragment never reaches any server. */
export function enrollLink(server: string, code: string): string {
  return `${server.replace(/\/+$/, '')}/r#${code}`;
}

/**
 * A typed or pasted code (or a link ending in #code) → its parts. Local checks only: length, alphabet, check
 * character. Never sends anything.
 */
export function parseEnrollCode(text: string): { lookup: string; secret: string; tag: string } {
  let raw = String(text);
  const hash = raw.lastIndexOf('#');
  if (hash >= 0) raw = raw.slice(hash + 1);
  const clean = normalizeB32(raw);
  if (clean.length !== CODE_LENGTH) {
    throw new EnrollCodeError('bad_length', `a registration code has ${CODE_LENGTH} characters`);
  }
  for (const c of clean) {
    if (!CROCKFORD.includes(c))
      throw new EnrollCodeError('bad_char', 'the code has a character that is not used in codes');
  }
  const lookup = clean.slice(0, PART);
  const secret = clean.slice(PART, 2 * PART);
  const tag = clean.slice(2 * PART, 3 * PART);
  if (enrollCheck(lookup, secret, tag) !== clean.slice(3 * PART)) {
    throw new EnrollCodeError('bad_check', 'the code has a typo');
  }
  return { lookup, secret, tag };
}

export function isLookup(text: unknown): text is string {
  if (typeof text !== 'string' || text.length !== PART) return false;
  for (const c of text) if (!CROCKFORD.includes(c)) return false;
  return true;
}

export function signEnroll(
  input: Omit<EnrollPayload, 'kind' | 'signPub' | 'boxPub'>,
  agent: Pick<Identity, 'signSecret' | 'signPub' | 'boxPub'>,
): Signed<EnrollPayload> {
  return signStatement(
    {
      kind: 'enroll',
      lookup: input.lookup,
      name: input.name,
      signPub: b64(agent.signPub),
      boxPub: b64(agent.boxPub),
      device: input.device,
      provider: input.provider,
      issuedAt: input.issuedAt,
    },
    agent,
  );
}

/** Self-signed by the key it registers, for this lookup, with a valid name. Returns the payload or throws. */
export function verifyEnroll(statement: Signed, lookup: string): EnrollPayload {
  const signPub = (statement?.payload as { signPub?: unknown } | undefined)?.signPub;
  if (typeof signPub !== 'string') throw new Error('enroll statement has no signing key');
  const p = verifyStatement(statement, 'enroll', signPub);
  if (p.lookup !== lookup) throw new Error('enroll statement is for another code');
  if (typeof p.name !== 'string' || !NAME_PATTERN.test(p.name)) throw new Error('enroll statement has a bad name');
  if (typeof p.boxPub !== 'string' || unb64(p.boxPub).length !== 32)
    throw new Error('enroll statement has a bad box key');
  if (typeof p.device !== 'string' || typeof p.provider !== 'string') throw new Error('enroll statement is malformed');
  if (!Number.isSafeInteger(p.issuedAt)) throw new Error('enroll statement is malformed');
  return p;
}

/** Constant-time: does the tag in the code match the keys the relay returned? */
export function tagMatches(parsed: { lookup: string; secret: string; tag: string }, keys: PublicKeys): boolean {
  return equalBytes(utf8(enrollTag(parsed.lookup, parsed.secret, keys)), utf8(parsed.tag));
}

/** The bytes a claim's AEAD covers: every field except `sealed`. */
export function claimAad(payload: Omit<ClaimPayload, 'sealed'> & { sealed?: string }): Uint8Array {
  const bind: Record<string, unknown> = { ...payload };
  delete bind.sealed;
  return utf8(canonical({ ctx: 'catcher/v1/claim', claim: bind }));
}

/** KEK = HKDF-SHA256(X25519(eph, agentBoxPub), salt = ephPub ‖ agentBoxPub, info = "catcher/v1/claim-key"). */
export function claimKey(shared: Uint8Array, ephPub: Uint8Array, agentBoxPub: Uint8Array): Uint8Array {
  return derive(shared, 'catcher/v1/claim-key', 32, concat(ephPub, agentBoxPub));
}

export interface SealClaimInput {
  owner: Pick<Identity, 'signSecret' | 'signPub' | 'boxPub'>;
  ownerId: string;
  lookup: string;
  secret: string;
  agentId: string;
  agentSignPub: string;
  agentBoxPub: string;
  issuedAt?: number;
  /** eph secret (32 bytes) is drawn first, then the nonce (24) — tests pass a fixed stream */
  random?: Random;
}

export function sealClaim(input: SealClaimInput): Signed<ClaimPayload> {
  const random = input.random ?? randomBytes;
  const ephSecret = random(32);
  const ephPub = boxPublic(ephSecret);
  const nonce = random(24);
  const agentBox = unb64(input.agentBoxPub);
  const bind: Omit<ClaimPayload, 'sealed'> = {
    kind: 'claim',
    ownerId: input.ownerId,
    ownerSignPub: b64(input.owner.signPub),
    ownerBoxPub: b64(input.owner.boxPub),
    lookup: input.lookup,
    agentId: input.agentId,
    agentSignPub: input.agentSignPub,
    agentBoxPub: input.agentBoxPub,
    ephPub: b64(ephPub),
    nonce: b64(nonce),
    issuedAt: input.issuedAt ?? Date.now(),
  };
  const kek = claimKey(sharedSecret(ephSecret, agentBox), ephPub, agentBox);
  const sealed = b64(seal(kek, nonce, utf8(input.secret), claimAad(bind)));
  return signStatement({ ...bind, sealed }, input.owner);
}

/**
 * Agent side, steps 1–4: signed by the key it names, for this lookup and these exact agent keys, and it carries this
 * agent's secret. Throws on any mismatch; the caller then forgets the registration (one guess only).
 */
export function openClaim(
  claim: Signed,
  me: { agentId: string; lookup: string; secret: string } & Pick<Identity, 'signPub' | 'boxPub' | 'boxSecret'>,
): ClaimPayload {
  const ownerSignPub = (claim?.payload as { ownerSignPub?: unknown } | undefined)?.ownerSignPub;
  if (typeof ownerSignPub !== 'string') throw new Error('claim names no owner key');
  const p = verifyStatement(claim, 'claim', ownerSignPub);
  if (p.lookup !== me.lookup || p.agentId !== me.agentId) throw new Error('claim is for another registration');
  if (p.agentSignPub !== b64(me.signPub) || p.agentBoxPub !== b64(me.boxPub)) {
    throw new Error('claim is for other agent keys');
  }
  if (typeof p.ownerId !== 'string' || typeof p.ownerBoxPub !== 'string') throw new Error('claim is malformed');
  const ephPub = unb64(p.ephPub);
  const kek = claimKey(sharedSecret(me.boxSecret, ephPub), ephPub, me.boxPub);
  let plain: Uint8Array;
  try {
    plain = unseal(kek, unb64(p.nonce), unb64(p.sealed), claimAad(p));
  } catch {
    throw new Error('claim was not sealed to this agent');
  }
  if (!equalBytes(plain, utf8(me.secret))) throw new Error('claim does not carry this registration code');
  return p;
}
