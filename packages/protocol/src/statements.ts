// Signed statements — the owner's decisions, verified by every agent locally. The server stores and relays
// them but cannot forge or alter them; agents never trust a decision that is not signed by the owner key.

import { b64, unb64, utf8 } from './bytes.ts';
import { canonical } from './canonical.ts';
import { sign, verify } from './crypto.ts';
import { type Identity, ownerIdFor, type PublicKeys } from './identity.ts';

export interface CertPayload {
  kind: 'cert';
  ownerId: string;
  agentId: string;
  /** what the owner calls this agent — a nickname the owner can change (a new cert); the id is the identity */
  name: string;
  signPub: string;
  boxPub: string;
  device: string;
  provider: string;
  issuedAt: number;
  expiresAt: number;
  /** revocation list version when this cert was issued — agents never accept an older list (rollback floor) */
  revocationFloor: number;
  /**
   * The owner's agent this one continues (same role, new key — e.g. its machine was rebuilt): the owner's app shows both
   * as one conversation and moved the old agent's grants over. Absent for a new agent.
   */
  continues?: string;
}

export interface GrantPayload {
  kind: 'grant';
  ownerId: string;
  grantId: string;
  /** sender agent id */
  from: string;
  /** recipient agent id */
  to: string;
  /** "message" for free-form requests, or a data scope such as "calendar.read" */
  scopes: string[];
  /** every envelope under this grant waits for an owner-signed release before the recipient accepts it */
  requireApproval: boolean;
  issuedAt: number;
  expiresAt: number | null;
}

/** Monotonic: agents keep the highest version they have seen and reject anything lower. */
export interface RevocationsPayload {
  kind: 'revocations';
  ownerId: string;
  version: number;
  agents: string[];
  grants: string[];
  issuedAt: number;
}

/**
 * Owner key chain. seq 0 is self-signed (genesis); every later link is signed by the previous key,
 * so an agent that pinned any earlier key can walk forward to the current one.
 */
export interface OwnerKeyPayload {
  kind: 'owner-key';
  ownerId: string;
  seq: number;
  signPub: string;
  boxPub: string;
  issuedAt: number;
}

/** Owner lets one held envelope through (grant with requireApproval). Bound to the exact ciphertext. */
export interface ReleasePayload {
  kind: 'release';
  ownerId: string;
  envelopeId: string;
  ctHash: string;
  issuedAt: number;
}

/**
 * An agent asks to be registered (signed by the agent's own key, so it proves it holds the secret). Only `lookup`, the
 * first part of the registration code, is in it — the rest of the code never reaches the relay (see enroll.ts).
 */
export interface EnrollPayload {
  kind: 'enroll';
  lookup: string;
  name: string;
  signPub: string;
  boxPub: string;
  device: string;
  provider: string;
  issuedAt: number;
}

/**
 * The owner claims a registration (signed by the owner's current key). `sealed` carries the code's secret part, sealed
 * to the agent's box key and bound to every other field, so the agent can tell the owner who typed its code from
 * anyone else (see enroll.ts).
 */
export interface ClaimPayload {
  kind: 'claim';
  ownerId: string;
  ownerSignPub: string;
  ownerBoxPub: string;
  lookup: string;
  agentId: string;
  agentSignPub: string;
  agentBoxPub: string;
  ephPub: string;
  nonce: string;
  sealed: string;
  issuedAt: number;
}

export type Payload =
  | CertPayload
  | GrantPayload
  | RevocationsPayload
  | OwnerKeyPayload
  | ReleasePayload
  | EnrollPayload
  | ClaimPayload;

export interface Signed<P extends Payload = Payload> {
  payload: P;
  /** Ed25519 public key of the signer, base64url */
  signer: string;
  sig: string;
}

function statementBytes(payload: Payload): Uint8Array {
  return utf8(canonical({ ctx: 'catcher/v1/statement', payload }));
}

export function signStatement<P extends Payload>(payload: P, id: Pick<Identity, 'signSecret' | 'signPub'>): Signed<P> {
  return { payload, signer: b64(id.signPub), sig: b64(sign(statementBytes(payload), id.signSecret)) };
}

/** Checks the signature and that it was made by `expectedSigner`. Returns the payload or throws. */
export function verifyStatement<K extends Payload['kind']>(
  statement: Signed,
  kind: K,
  expectedSigner: string,
): Extract<Payload, { kind: K }> {
  if (!statement || typeof statement !== 'object') throw new Error('statement missing');
  if (statement.payload?.kind !== kind) throw new Error(`expected a ${kind} statement`);
  if (statement.signer !== expectedSigner) throw new Error(`${kind} is not signed by the expected key`);
  let ok = false;
  try {
    ok = verify(unb64(statement.sig), statementBytes(statement.payload), unb64(statement.signer));
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`${kind} signature is invalid`);
  return statement.payload as Extract<Payload, { kind: K }>;
}

/**
 * Walk the owner key chain from a pinned key to the newest one. Returns the current owner keys.
 * `chain` must be ordered by seq. Links before the pinned key are ignored (already trusted).
 */
export function resolveOwnerKeys(chain: Signed[], ownerId: string, pinned: PublicKeys): PublicKeys & { seq: number } {
  let current: (PublicKeys & { seq: number }) | null = null;
  for (const link of chain) {
    const p = link.payload as OwnerKeyPayload;
    if (p?.kind !== 'owner-key' || p.ownerId !== ownerId) throw new Error('owner key chain is for another owner');
    if (!current) {
      if (p.signPub !== pinned.signPub) continue;
      // the pinned link itself: its signer is either itself (genesis) or the previous key we skipped — both fine,
      // because the agent pinned it from an owner-signed claim that proved it saw the registration code
      if (p.boxPub !== pinned.boxPub) throw new Error('owner key chain does not match the pinned box key');
      current = { signPub: p.signPub, boxPub: p.boxPub, seq: p.seq };
      continue;
    }
    if (p.seq !== current.seq + 1) throw new Error('owner key chain skips a link');
    verifyStatement(link, 'owner-key', current.signPub);
    current = { signPub: p.signPub, boxPub: p.boxPub, seq: p.seq };
  }
  if (!current) throw new Error('pinned owner key is not in the owner key chain');
  return current;
}

/** Full chain check from genesis (the owner app uses this; agents use resolveOwnerKeys from their pin). */
export function verifyOwnerChain(chain: Signed[], ownerId: string): PublicKeys & { seq: number } {
  const first = chain[0];
  if (!first) throw new Error('owner key chain is empty');
  const genesis = verifyStatement(first, 'owner-key', first.signer);
  if (genesis.seq !== 0 || genesis.signPub !== first.signer) throw new Error('owner key genesis must be self-signed');
  if (ownerIdFor(genesis.signPub) !== ownerId) throw new Error('owner id does not match the genesis key');
  return resolveOwnerKeys(chain, ownerId, { signPub: genesis.signPub, boxPub: genesis.boxPub });
}
