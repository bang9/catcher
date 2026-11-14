// Envelopes — every message between the owner and agents, end-to-end encrypted.
//
// body  = XChaCha20-Poly1305(K, nonce, aad = canonical(core))       — the core (sender, ids, type, ref, scope…) is bound in
// wrap  = XChaCha20-Poly1305(KEK_r, wrapNonce, K, aad = id|recipient) — one per recipient, KEK from one ephemeral X25519 + HKDF
// sig   = Ed25519(sender, canonical({core, wraps, ctHash}))          — covers recipients and wrapped keys, so nobody can strip
//                                                                       the owner's copy or re-sign another sender's ciphertext
// Recipients are always: the target, the owner (audit timeline), and the sender (its own log).

import { b64, concat, unb64, utf8, fromUtf8 } from './bytes.ts';
import { canonical, type Json } from './canonical.ts';
import {
  derive,
  randomBytes,
  type Random,
  seal,
  sha256,
  sharedSecret,
  sign,
  unseal,
  verify,
  boxPublic,
} from './crypto.ts';
import type { Identity } from './identity.ts';
import type { GrantPayload, Signed } from './statements.ts';

export const ENVELOPE_TYPES = ['message', 'reply', 'ask', 'confirm', 'otp', 'grant-request', 'answer'] as const;
export type EnvelopeType = (typeof ENVELOPE_TYPES)[number];

/** Types an agent sends to the owner and waits on an owner-signed `answer` for. */
export const OWNER_REQUEST_TYPES: readonly EnvelopeType[] = ['ask', 'confirm', 'otp', 'grant-request'];

export const MAX_BODY_BYTES = 64 * 1024;

export interface MessageBody {
  text?: string;
  data?: Json;
}
export interface AskBody {
  question: string;
  choices?: string[];
}
export interface ConfirmBody {
  action: string;
  details?: string;
}
export interface OtpBody {
  service: string;
  hint?: string;
}
export type GrantRequestBody =
  | {
      action: 'grant';
      from: string;
      to: string;
      scopes: string[];
      requireApproval: boolean;
      expiresInSec: number | null;
      note?: string;
    }
  | { action: 'revoke'; grantId?: string; agentId?: string; note?: string };
export interface AnswerBody {
  /** ask: the chosen or typed answer */
  answer?: string;
  /** confirm / grant-request: the decision */
  approved?: boolean;
  /** otp: the code the owner typed */
  code?: string;
  /** grant-request approved: the signed grant */
  grant?: Signed<GrantPayload>;
  note?: string;
}

export interface BodyByType {
  message: MessageBody;
  reply: MessageBody;
  ask: AskBody;
  confirm: ConfirmBody;
  otp: OtpBody;
  'grant-request': GrantRequestBody;
  answer: AnswerBody;
}

export interface EnvelopeCore {
  v: 1;
  id: string;
  ownerId: string;
  from: string;
  to: string;
  type: EnvelopeType;
  /** per-sender counter, strictly increasing — lets the owner spot dropped envelopes */
  seq: number;
  createdAt: number;
  /** the envelope this one replies to or answers */
  ref: string | null;
  /** agent → agent only: the scope used, which a grant must cover */
  scope: string | null;
  grantId: string | null;
  /** after this the recipient ignores it (OTP answers, short asks) */
  expiresAt: number | null;
  nonce: string;
  ephPub: string;
  /** SHA-256 commitment to the body key — every recipient must unwrap the same key (owner audit copy == target copy) */
  keyHash: string;
}

export interface Wrap {
  to: string;
  nonce: string;
  key: string;
}

export interface Envelope {
  core: EnvelopeCore;
  wraps: Wrap[];
  ctHash: string;
  ct: string;
  sig: string;
}

export interface Party {
  id: string;
  boxPub: string;
}

export interface SealInput<T extends EnvelopeType> {
  id: string;
  ownerId: string;
  from: string;
  to: string;
  type: T;
  seq: number;
  body: BodyByType[T];
  ref?: string | null;
  scope?: string | null;
  grantId?: string | null;
  expiresAt?: number | null;
  createdAt?: number;
  sender: Pick<Identity, 'signSecret' | 'signPub'>;
  /** must contain `to`, the owner and the sender */
  recipients: Party[];
  random?: Random;
}

function bodyAad(core: EnvelopeCore): Uint8Array {
  return utf8(canonical({ ctx: 'catcher/v1/body', core }));
}

function signedBytes(env: Pick<Envelope, 'core' | 'wraps' | 'ctHash'>): Uint8Array {
  return utf8(canonical({ ctx: 'catcher/v1/envelope', core: env.core, wraps: env.wraps, ctHash: env.ctHash }));
}

function wrapKey(shared: Uint8Array, ephPub: Uint8Array, recipientBoxPub: Uint8Array): Uint8Array {
  return derive(shared, 'catcher/v1/wrap', 32, concat(ephPub, recipientBoxPub));
}

function keyCommitment(key: Uint8Array): string {
  return b64(sha256(concat(utf8('catcher/v1/key'), key)));
}

function wrapAad(envelopeId: string, recipientId: string): Uint8Array {
  return utf8(`catcher/v1/wrap|${envelopeId}|${recipientId}`);
}

export function requiredRecipients(core: Pick<EnvelopeCore, 'to' | 'ownerId' | 'from'>): string[] {
  return [...new Set([core.to, core.ownerId, core.from])];
}

export function sealEnvelope<T extends EnvelopeType>(input: SealInput<T>): Envelope {
  const random = input.random ?? randomBytes;
  const plaintext = utf8(JSON.stringify(input.body));
  if (plaintext.length > MAX_BODY_BYTES) throw new Error(`message body is over ${MAX_BODY_BYTES} bytes`);
  const ephSecret = random(32);
  const ephPub = boxPublic(ephSecret);
  const nonce = random(24);
  const key = random(32);
  const core: EnvelopeCore = {
    v: 1,
    id: input.id,
    ownerId: input.ownerId,
    from: input.from,
    to: input.to,
    type: input.type,
    seq: input.seq,
    createdAt: input.createdAt ?? Date.now(),
    ref: input.ref ?? null,
    scope: input.scope ?? null,
    grantId: input.grantId ?? null,
    expiresAt: input.expiresAt ?? null,
    nonce: b64(nonce),
    ephPub: b64(ephPub),
    keyHash: keyCommitment(key),
  };
  const need = requiredRecipients(core);
  const byId = new Map(input.recipients.map((r) => [r.id, r]));
  const missing = need.filter((id) => !byId.has(id));
  if (missing.length) throw new Error(`no box key for recipient ${missing.join(', ')}`);
  const wraps: Wrap[] = need.map((rid) => {
    const recipientBox = unb64(byId.get(rid)!.boxPub);
    const kek = wrapKey(sharedSecret(ephSecret, recipientBox), ephPub, recipientBox);
    const wrapNonce = random(24);
    return { to: rid, nonce: b64(wrapNonce), key: b64(seal(kek, wrapNonce, key, wrapAad(core.id, rid))) };
  });
  const ct = seal(key, nonce, plaintext, bodyAad(core));
  const ctHash = b64(sha256(ct));
  const sig = b64(sign(signedBytes({ core, wraps, ctHash }), input.sender.signSecret));
  return { core, wraps, ctHash, ct: b64(ct), sig };
}

/**
 * Structural rules plus the sender signature. Does not decide whether the sender may talk to the recipient —
 * that is grant policy (see policy.ts).
 */
export function verifyEnvelope(env: Envelope, senderSignPub: string): void {
  if (!env || typeof env !== 'object' || !env.core) throw new Error('envelope missing');
  const c = env.core;
  if (c.v !== 1) throw new Error('unsupported envelope version');
  if (!ENVELOPE_TYPES.includes(c.type)) throw new Error(`unknown envelope type ${String(c.type)}`);
  if (!Number.isSafeInteger(c.seq) || c.seq < 1) throw new Error('envelope seq must be a positive integer');
  if ((c.type === 'reply' || c.type === 'answer') && !c.ref) throw new Error(`${c.type} needs ref`);
  if (c.type === 'answer' && c.from !== c.ownerId) throw new Error('only the owner can answer');
  if (OWNER_REQUEST_TYPES.includes(c.type) && c.to !== c.ownerId) throw new Error(`${c.type} goes to the owner only`);
  const agentToAgent = c.from !== c.ownerId && c.to !== c.ownerId;
  if (agentToAgent && c.type === 'message' && (!c.scope || !c.grantId)) {
    throw new Error('agent messages need a scope and a grant');
  }
  // a reply between agents names the grant of the message it answers (held the same way when that grant needs approval)
  if (agentToAgent && c.type === 'reply' && !c.grantId) throw new Error('agent replies need the grant of the message');
  if (typeof c.keyHash !== 'string') throw new Error('envelope has no key commitment');
  if (c.from === c.to) throw new Error('cannot send to yourself');
  const ids = env.wraps.map((w) => w.to);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate recipient');
  for (const need of requiredRecipients(c)) {
    if (!ids.includes(need)) throw new Error(`envelope is not readable by ${need}`);
  }
  if (ids.length !== requiredRecipients(c).length) throw new Error('envelope has extra recipients');
  if (b64(sha256(unb64(env.ct))) !== env.ctHash) throw new Error('ciphertext hash mismatch');
  if (!verify(unb64(env.sig), signedBytes(env), unb64(senderSignPub))) throw new Error('envelope signature is invalid');
}

/** Decrypt for one recipient. Call verifyEnvelope first with the sender's verified key. */
export function openEnvelope<T extends EnvelopeType = EnvelopeType>(
  env: Envelope,
  me: { id: string } & Pick<Identity, 'boxSecret' | 'boxPub'>,
): BodyByType[T] {
  const wrap = env.wraps.find((w) => w.to === me.id);
  if (!wrap) throw new Error('this envelope is not addressed to you');
  const ephPub = unb64(env.core.ephPub);
  const kek = wrapKey(sharedSecret(me.boxSecret, ephPub), ephPub, me.boxPub);
  const key = unseal(kek, unb64(wrap.nonce), unb64(wrap.key), wrapAad(env.core.id, me.id));
  if (keyCommitment(key) !== env.core.keyHash) throw new Error('body key does not match the commitment');
  const plaintext = unseal(key, unb64(env.core.nonce), unb64(env.ct), bodyAad(env.core));
  return JSON.parse(fromUtf8(plaintext)) as BodyByType[T];
}
