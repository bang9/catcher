// Trust and policy — turns the server's directory (all owner-signed) into a verified view, then decides whether
// one envelope may be accepted. Agents run this on every poll; the server runs the same checks as a pre-filter only.

import type { Envelope } from './envelope.ts';
import { verifyEnvelope } from './envelope.ts';
import type { PublicKeys } from './identity.ts';
import {
  type CertPayload,
  type GrantPayload,
  type OwnerKeyPayload,
  type ReleasePayload,
  type RevocationsPayload,
  resolveOwnerKeys,
  type Signed,
  verifyStatement,
} from './statements.ts';

/** No agent may be called this — it always means the owner. */
export const RESERVED_NAME = 'owner';

export interface Directory {
  ownerId: string;
  ownerChain: Signed<OwnerKeyPayload>[];
  revocations: Signed<RevocationsPayload> | null;
  certs: Signed<CertPayload>[];
  grants: Signed<GrantPayload>[];
}

export interface OwnerPin extends PublicKeys {
  ownerId: string;
}

export interface Trust {
  ownerId: string;
  owner: PublicKeys & { seq: number };
  revocationVersion: number;
  agents: Map<string, CertPayload>;
  grants: Map<string, GrantPayload>;
  revokedAgents: Set<string>;
  revokedGrants: Set<string>;
}

export class PolicyError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Verify the whole directory against the pinned owner key. Anything not signed by the current owner key is dropped
 * (certs and grants are re-signed by the owner app when it rotates keys). A revocation list older than one the agent
 * already saw is a rollback and fails hard.
 */
export function buildTrust(dir: Directory, pin: OwnerPin, minRevocationVersion: number, now = Date.now()): Trust {
  if (dir.ownerId !== pin.ownerId) throw new PolicyError('owner_mismatch', 'directory belongs to another owner');
  const owner = resolveOwnerKeys(dir.ownerChain, pin.ownerId, pin);
  let revocationVersion = 0;
  const revokedAgents = new Set<string>();
  const revokedGrants = new Set<string>();
  if (dir.revocations) {
    const r = verifyStatement(dir.revocations, 'revocations', owner.signPub);
    if (r.ownerId !== pin.ownerId) throw new PolicyError('owner_mismatch', 'revocation list belongs to another owner');
    revocationVersion = r.version;
    for (const a of r.agents) revokedAgents.add(a);
    for (const g of r.grants) revokedGrants.add(g);
  }
  const agents = new Map<string, CertPayload>();
  let floor = minRevocationVersion;
  for (const s of dir.certs) {
    let c: CertPayload;
    try {
      c = verifyStatement(s, 'cert', owner.signPub);
    } catch {
      // not signed by the current owner key — ignore
      continue;
    }
    if (c.ownerId !== pin.ownerId) continue;
    // any genuine cert raises the floor, even one that is revoked or expired now
    if (Number.isSafeInteger(c.revocationFloor) && c.revocationFloor > floor) floor = c.revocationFloor;
    if (c.expiresAt <= now || revokedAgents.has(c.agentId) || c.name === RESERVED_NAME) continue;
    agents.set(c.agentId, c);
  }
  if (revocationVersion < floor) {
    throw new PolicyError(
      'revocations_rolled_back',
      'server returned an older revocation list than this agent has seen',
    );
  }
  const grants = new Map<string, GrantPayload>();
  for (const s of dir.grants) {
    try {
      const g = verifyStatement(s, 'grant', owner.signPub);
      if (g.ownerId !== pin.ownerId || revokedGrants.has(g.grantId)) continue;
      if (g.expiresAt !== null && g.expiresAt <= now) continue;
      if (!agents.has(g.from) || !agents.has(g.to)) continue;
      grants.set(g.grantId, g);
    } catch {
      // ignore
    }
  }
  return { ownerId: pin.ownerId, owner, revocationVersion, agents, grants, revokedAgents, revokedGrants };
}

export function signKeyOf(trust: Trust, id: string): string {
  if (id === trust.ownerId) return trust.owner.signPub;
  const cert = trust.agents.get(id);
  if (!cert) throw new PolicyError('unknown_party', `${id} is not a certified agent (unknown, expired or revoked)`);
  return cert.signPub;
}

export function boxKeyOf(trust: Trust, id: string): string {
  if (id === trust.ownerId) return trust.owner.boxPub;
  const cert = trust.agents.get(id);
  if (!cert) throw new PolicyError('unknown_party', `${id} is not a certified agent (unknown, expired or revoked)`);
  return cert.boxPub;
}

/** Find a live grant that lets `from` send `scope` to `to`. */
export function findGrant(trust: Trust, from: string, to: string, scope: string): GrantPayload | null {
  for (const g of trust.grants.values()) {
    if (g.from === from && g.to === to && g.scopes.includes(scope)) return g;
  }
  return null;
}

/**
 * Decide whether `env` is acceptable. Verifies the sender signature with the trusted key, then the grant rules.
 * `release` is the owner-signed release statement for envelopes under a requireApproval grant.
 */
export function checkEnvelope(
  trust: Trust,
  env: Envelope,
  opts: { now?: number; release?: Signed<ReleasePayload> | null } = {},
): void {
  const now = opts.now ?? Date.now();
  const c = env.core;
  if (c.ownerId !== trust.ownerId) throw new PolicyError('owner_mismatch', 'envelope belongs to another owner');
  const senderKey = signKeyOf(trust, c.from);
  signKeyOf(trust, c.to);
  try {
    verifyEnvelope(env, senderKey);
  } catch (e) {
    throw new PolicyError('bad_envelope', (e as Error).message);
  }
  if (c.expiresAt !== null && c.expiresAt <= now) throw new PolicyError('expired', 'envelope has expired');
  const agentToAgent = c.from !== trust.ownerId && c.to !== trust.ownerId;
  if (!agentToAgent) {
    if (c.from === trust.ownerId && !['message', 'answer'].includes(c.type)) {
      throw new PolicyError('bad_type', `owner does not send ${c.type}`);
    }
    return;
  }
  if (c.type === 'message') {
    let g: GrantPayload | undefined;
    if (c.grantId) g = trust.grants.get(c.grantId);
    if (!g) throw new PolicyError('no_grant', 'no live grant for this message (missing, expired or revoked)');
    if (g.from !== c.from || g.to !== c.to || !c.scope || !g.scopes.includes(c.scope)) {
      throw new PolicyError('no_grant', `grant ${g.grantId} does not cover ${c.from} → ${c.to} for ${c.scope ?? '?'}`);
    }
    if (g.requireApproval) requireRelease(trust, env, opts.release);
    return;
  }
  if (c.type === 'reply') {
    // must name a live grant that links the two agents; held exactly like messages under that grant
    let g: GrantPayload | undefined;
    if (c.grantId) g = trust.grants.get(c.grantId);
    const links = g && ((g.from === c.to && g.to === c.from) || (g.from === c.from && g.to === c.to));
    if (!g || !links) throw new PolicyError('no_grant', 'reply between agents with no live grant');
    if (g.requireApproval) requireRelease(trust, env, opts.release);
    return;
  }
  throw new PolicyError('bad_type', `agents do not send ${c.type} to each other`);
}

function requireRelease(trust: Trust, env: Envelope, release: Signed<ReleasePayload> | null | undefined): void {
  if (!release) throw new PolicyError('held', 'waiting for the owner to approve this message');
  const r = verifyStatement(release, 'release', trust.owner.signPub);
  if (r.envelopeId !== env.core.id || r.ctHash !== env.ctHash || r.ownerId !== trust.ownerId) {
    throw new PolicyError('bad_release', 'owner approval does not match this message');
  }
}
