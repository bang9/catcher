// Owner side — used by the phone app and by the headless owner in end-to-end tests.
// The owner key never leaves this side; every decision (cert, grant, revocation, release, answer) is signed here.

import {
  type AgentSummary,
  type AgentsResponse,
  type AnswerBody,
  b64,
  type BodyByType,
  type CertPayload,
  type CreatePairingResponse,
  type Envelope,
  type EnvelopeType,
  type FeedResponse,
  fingerprint,
  type GrantPayload,
  type GrantRequestBody,
  identityFromSeed,
  type Identity,
  newIdentity,
  openEnvelope,
  type OwnerKeyPayload,
  type OwnerLookupResponse,
  ownerIdFor,
  publicKeys,
  randomId,
  recoveryCode,
  type RevocationsPayload,
  sealEnvelope,
  seedFromRecoveryCode,
  type Signed,
  signStatement,
  type StoredEnvelope,
  unb64,
  verifyEnvelope,
  verifyOwnerChain,
  verifyStatement,
  type Directory,
} from '@catcher/protocol';
import { Api, type Fetch } from './api.ts';

export interface OwnerState {
  server: string;
  ownerId: string;
  /** current owner key seed, base64url — shown to the person as the recovery code */
  seed: string;
  keySeq: number;
  /** last envelope seq the owner used */
  seq: number;
  /** next key while a rotation is in flight — stored before the relay hears of it, so a crash never loses it */
  pendingSeed?: string;
}

/** One envelope as the owner sees it: verified against the sender's owner-signed cert, then decrypted. */
export interface OwnerItem {
  id: string;
  cursor: number;
  type: EnvelopeType;
  from: string;
  to: string;
  fromName: string;
  toName: string;
  ref: string | null;
  scope: string | null;
  grantId: string | null;
  createdAt: number;
  receivedAt: number;
  expiresAt: number | null;
  held: boolean;
  released: boolean;
  acked: boolean;
  /** decrypted body, or null when verification failed */
  body: unknown;
  verified: boolean;
  problem: string | null;
  envelope: Envelope;
}

export const CERT_DAYS = 365;

export class OwnerClient {
  state: OwnerState;
  identity: Identity;
  api: Api;
  private save: (s: OwnerState) => void;
  private fetchImpl: Fetch | undefined;

  constructor(state: OwnerState, opts: { fetch?: Fetch; save?: (s: OwnerState) => void } = {}) {
    this.state = state;
    this.identity = identityFromSeed(unb64(state.seed));
    this.fetchImpl = opts.fetch;
    this.api = new Api({ server: state.server, callerId: state.ownerId, identity: this.identity, fetch: opts.fetch });
    this.save = opts.save ?? (() => {});
  }

  private useIdentity(next: Identity): void {
    this.identity = next;
    this.api = new Api({
      server: this.state.server,
      callerId: this.state.ownerId,
      identity: next,
      fetch: this.fetchImpl,
    });
  }

  /** First launch: new owner key, registered with the relay. */
  static async create(server: string, opts: { fetch?: Fetch; seed?: Uint8Array } = {}): Promise<OwnerState> {
    let identity = newIdentity();
    if (opts.seed) identity = identityFromSeed(opts.seed);
    const keys = publicKeys(identity);
    const ownerId = ownerIdFor(keys.signPub);
    const genesis = signStatement({ kind: 'owner-key', ownerId, seq: 0, ...keys, issuedAt: Date.now() }, identity);
    const api = new Api({ server, fetch: opts.fetch });
    await api.call('POST', '/v1/owners', { chain: [genesis] }, { auth: false });
    return { server, ownerId, seed: b64(identity.seed), keySeq: 0, seq: 0 };
  }

  /** New phone: recovery code → same key → find the owner on the relay. */
  static async restore(server: string, code: string, opts: { fetch?: Fetch } = {}): Promise<OwnerState> {
    const seed = seedFromRecoveryCode(code);
    const identity = identityFromSeed(seed);
    const api = new Api({ server, fetch: opts.fetch });
    const res = await api.call<OwnerLookupResponse>(
      'GET',
      `/v1/owners/lookup?signPub=${encodeURIComponent(b64(identity.signPub))}`,
      undefined,
      { auth: false },
    );
    const current = verifyOwnerChain(res.chain, res.ownerId);
    if (current.signPub !== b64(identity.signPub)) throw new Error('this recovery code is for an older key');
    const client = new OwnerClient(
      { server, ownerId: res.ownerId, seed: b64(seed), keySeq: current.seq, seq: 0 },
      opts,
    );
    const agents = await client.agents();
    client.state.seq = agents.senderSeq[res.ownerId] ?? 0;
    return client.state;
  }

  recoveryCode(): string {
    return recoveryCode(this.identity.seed);
  }

  fingerprint(): string {
    return fingerprint(publicKeys(this.identity));
  }

  private nextSeq(): number {
    this.state.seq += 1;
    this.save(this.state);
    return this.state.seq;
  }

  async registerPush(token: string, platform: 'ios' | 'android' | 'web', locale: string): Promise<void> {
    await this.api.call('POST', '/v1/owner/push-tokens', { token, platform, locale });
  }

  async unregisterPush(token: string): Promise<void> {
    await this.api.call('POST', '/v1/owner/push-tokens/delete', { token });
  }

  async createPairing(): Promise<CreatePairingResponse> {
    const statement = signStatement(
      { kind: 'pairing', ownerId: this.state.ownerId, issuedAt: Date.now() },
      this.identity,
    );
    return this.api.call<CreatePairingResponse>('POST', '/v1/owner/pairings', { statement });
  }

  async agents(): Promise<AgentsResponse> {
    return this.api.call<AgentsResponse>('GET', '/v1/owner/agents');
  }

  async directory(): Promise<Directory> {
    return this.api.call<Directory>('GET', '/v1/directory');
  }

  agentFingerprint(agent: Pick<AgentSummary, 'signPub' | 'boxPub'>): string {
    return fingerprint({ signPub: agent.signPub, boxPub: agent.boxPub });
  }

  /** Approve a pending registration (after the person compared fingerprints) — signs the cert. */
  async approveAgent(agent: AgentSummary, days = CERT_DAYS): Promise<Signed<CertPayload>> {
    const now = Date.now();
    // the cert carries today's revocation version, so the new agent can never be served an older list
    const dir = await this.directory();
    let revocationFloor = 0;
    if (dir.revocations) {
      revocationFloor = verifyStatement(dir.revocations, 'revocations', b64(this.identity.signPub)).version;
    }
    const cert = signStatement(
      {
        kind: 'cert',
        ownerId: this.state.ownerId,
        agentId: agent.agentId,
        name: agent.name,
        signPub: agent.signPub,
        boxPub: agent.boxPub,
        device: agent.device,
        provider: agent.provider,
        issuedAt: now,
        expiresAt: now + days * 86_400_000,
        revocationFloor,
      },
      this.identity,
    );
    await this.api.call('POST', '/v1/owner/certs', { cert });
    return cert;
  }

  async rejectAgent(agentId: string): Promise<void> {
    await this.api.call('POST', `/v1/owner/agents/${agentId}/reject`, {});
  }

  async grant(input: {
    from: string;
    to: string;
    scopes: string[];
    requireApproval?: boolean;
    expiresAt?: number | null;
  }): Promise<Signed<GrantPayload>> {
    const grant = signStatement(
      {
        kind: 'grant',
        ownerId: this.state.ownerId,
        grantId: randomId('g'),
        from: input.from,
        to: input.to,
        scopes: input.scopes,
        requireApproval: input.requireApproval ?? false,
        issuedAt: Date.now(),
        expiresAt: input.expiresAt ?? null,
      },
      this.identity,
    );
    await this.api.call('POST', '/v1/owner/grants', { grant });
    return grant;
  }

  /** Add agents/grants to the signed revocation list (version + 1). */
  async revoke(input: { agents?: string[]; grants?: string[] }): Promise<Signed<RevocationsPayload>> {
    const dir = await this.directory();
    let current: RevocationsPayload = {
      kind: 'revocations',
      ownerId: this.state.ownerId,
      version: 0,
      agents: [],
      grants: [],
      issuedAt: 0,
    };
    if (dir.revocations) current = verifyStatement(dir.revocations, 'revocations', b64(this.identity.signPub));
    const revocations = signStatement(
      {
        kind: 'revocations',
        ownerId: this.state.ownerId,
        version: current.version + 1,
        agents: [...new Set([...current.agents, ...(input.agents ?? [])])],
        grants: [...new Set([...current.grants, ...(input.grants ?? [])])],
        issuedAt: Date.now(),
      },
      this.identity,
    );
    await this.api.call('POST', '/v1/owner/revocations', { revocations });
    return revocations;
  }

  /** Let one held envelope through — bound to its exact ciphertext. */
  async release(item: Pick<OwnerItem, 'envelope' | 'verified'>): Promise<void> {
    // never let through what the owner could not read and verify itself
    if (!item.verified) throw new Error('cannot release a message that failed verification');
    const release = signStatement(
      {
        kind: 'release',
        ownerId: this.state.ownerId,
        envelopeId: item.envelope.core.id,
        ctHash: item.envelope.ctHash,
        issuedAt: Date.now(),
      },
      this.identity,
    );
    await this.api.call('POST', '/v1/owner/releases', { release });
  }

  async dropHeld(envelopeId: string): Promise<void> {
    await this.api.call('POST', `/v1/owner/held/${envelopeId}/drop`, {});
  }

  /** Send to one agent (owner → agent message or answer). */
  async send<T extends 'message' | 'answer'>(
    type: T,
    agent: AgentSummary,
    body: BodyByType[T],
    opts: { ref?: string; expiresAt?: number } = {},
  ): Promise<string> {
    const id = randomId('m');
    const envelope = sealEnvelope({
      id,
      ownerId: this.state.ownerId,
      from: this.state.ownerId,
      to: agent.agentId,
      type,
      seq: this.nextSeq(),
      body,
      ref: opts.ref ?? null,
      expiresAt: opts.expiresAt ?? null,
      sender: this.identity,
      recipients: [
        { id: agent.agentId, boxPub: agent.boxPub },
        { id: this.state.ownerId, boxPub: b64(this.identity.boxPub) },
      ],
    });
    await this.api.call('POST', '/v1/envelopes', { envelope });
    return id;
  }

  /** Answer an agent's ask / confirm / otp / grant-request. OTP answers expire after 5 minutes. */
  async answer(request: OwnerItem, agent: AgentSummary, body: AnswerBody): Promise<string> {
    let expiresAt: number | undefined;
    if (request.type === 'otp') expiresAt = Date.now() + 5 * 60 * 1000;
    return this.send('answer', agent, body, { ref: request.id, expiresAt });
  }

  /** Approve a grant-request: sign the grant (or revocation), then answer the requester with it. */
  async decideGrantRequest(request: OwnerItem, agents: AgentSummary[], approved: boolean): Promise<void> {
    const requester = agents.find((a) => a.agentId === request.from);
    if (!requester) throw new Error('requesting agent is gone');
    const body = request.body as GrantRequestBody;
    if (!approved) {
      await this.answer(request, requester, { approved: false });
      return;
    }
    if (body.action === 'grant') {
      let expiresAt: number | null = null;
      if (body.expiresInSec) expiresAt = Date.now() + body.expiresInSec * 1000;
      const grant = await this.grant({
        from: body.from,
        to: body.to,
        scopes: body.scopes,
        requireApproval: body.requireApproval,
        expiresAt,
      });
      await this.answer(request, requester, { approved: true, grant });
      return;
    }
    const revokeAgents: string[] = [];
    if (body.agentId) revokeAgents.push(body.agentId);
    const revokeGrants: string[] = [];
    if (body.grantId) revokeGrants.push(body.grantId);
    await this.revoke({ agents: revokeAgents, grants: revokeGrants });
    await this.answer(request, requester, { approved: true });
  }

  /**
   * Rotate the owner key: the old key signs the new one, then every live cert and grant is re-signed and the
   * revocation list is re-issued with the new key. Returns the new recovery code.
   * Crash-safe: the new seed is saved before the relay hears of it; `resumeRotation` finishes an interrupted one.
   */
  async rotateKey(): Promise<string> {
    const next = newIdentity();
    this.state.pendingSeed = b64(next.seed);
    this.save(this.state);
    const link = signStatement(
      {
        kind: 'owner-key',
        ownerId: this.state.ownerId,
        seq: this.state.keySeq + 1,
        ...publicKeys(next),
        issuedAt: Date.now(),
      },
      this.identity,
    );
    await this.api.call('POST', '/v1/owner/keys', { link });
    this.adopt(next);
    await this.resignAll();
    return recoveryCode(next.seed);
  }

  /** Call on start-up: finishes a rotation that was interrupted after the new seed was saved. */
  async resumeRotation(): Promise<boolean> {
    if (!this.state.pendingSeed) return false;
    const next = identityFromSeed(unb64(this.state.pendingSeed));
    const res = await this.api
      .call<OwnerLookupResponse>(
        'GET',
        `/v1/owners/lookup?signPub=${encodeURIComponent(b64(next.signPub))}`,
        undefined,
        {
          auth: false,
        },
      )
      .catch(() => null);
    if (!res || res.ownerId !== this.state.ownerId) {
      // the relay never took the new key — keep the current one
      delete this.state.pendingSeed;
      this.save(this.state);
      return false;
    }
    this.adopt(next);
    await this.resignAll();
    return true;
  }

  private adopt(next: Identity): void {
    this.state.seed = b64(next.seed);
    this.state.keySeq += 1;
    delete this.state.pendingSeed;
    this.useIdentity(next);
    this.save(this.state);
  }

  /** Re-sign whatever is still signed by an older owner key (idempotent — safe to run again after a failure). */
  async resignAll(): Promise<void> {
    const dir = await this.directory();
    const keys = verifyOwnerChain(dir.ownerChain, this.state.ownerId);
    const chainKeys = dir.ownerChain.map((l) => l.payload.signPub);
    const current = b64(this.identity.signPub);
    if (keys.signPub !== current) throw new Error('relay owner key does not match this phone');
    const old = (signer: string) => signer !== current && chainKeys.includes(signer);
    for (const s of dir.certs) {
      if (!old(s.signer)) continue;
      const c = verifyStatement(s, 'cert', s.signer);
      await this.api.call('POST', '/v1/owner/certs', {
        cert: signStatement({ ...c, issuedAt: Date.now() }, this.identity),
      });
    }
    for (const s of dir.grants) {
      if (!old(s.signer)) continue;
      const g = verifyStatement(s, 'grant', s.signer);
      await this.api.call('POST', '/v1/owner/grants', { grant: signStatement(g, this.identity) });
    }
    if (dir.revocations && old(dir.revocations.signer)) {
      const r = verifyStatement(dir.revocations, 'revocations', dir.revocations.signer);
      const revocations = signStatement({ ...r, version: r.version + 1, issuedAt: Date.now() }, this.identity);
      await this.api.call('POST', '/v1/owner/revocations', { revocations });
    }
  }

  async feed(after: number, limit = 200): Promise<FeedResponse> {
    return this.api.call<FeedResponse>('GET', `/v1/owner/feed?after=${after}&limit=${limit}`);
  }

  async envelopeStates(ids: string[]): Promise<StoredEnvelope[]> {
    if (!ids.length) return [];
    const res = await this.api.call<{ envelopes: StoredEnvelope[] }>(
      'GET',
      `/v1/owner/envelopes?ids=${ids.map(encodeURIComponent).join(',')}`,
    );
    return res.envelopes;
  }

  /** Verify each envelope against the sender key from its owner-signed cert (kept for revoked agents too), decrypt. */
  /** Every signing key in the verified owner chain — certs of revoked agents may carry an older one. */
  async ownerSignKeys(): Promise<string[]> {
    const dir = await this.directory();
    verifyOwnerChain(dir.ownerChain, this.state.ownerId);
    return dir.ownerChain.map((l) => l.payload.signPub);
  }

  openItems(rows: StoredEnvelope[], agents: AgentSummary[], ownerSignKeys: string[]): OwnerItem[] {
    const byId = new Map(agents.map((a) => [a.agentId, a]));
    const name = (id: string) => {
      if (id === this.state.ownerId) return 'owner';
      return byId.get(id)?.name ?? id;
    };
    return rows.map((row) => {
      const c = row.envelope.core;
      let body: unknown = null;
      let verified = false;
      let problem: string | null = null;
      try {
        let senderKeys = ownerSignKeys;
        if (c.from !== this.state.ownerId) {
          const agent = byId.get(c.from);
          if (!agent?.cert) throw new Error('sender has no owner certificate');
          // certs signed by an older owner key are still checked against the owner chain
          if (!ownerSignKeys.includes(agent.cert.signer)) throw new Error('certificate is not signed by the owner');
          const cert = verifyStatement(agent.cert, 'cert', agent.cert.signer);
          if (cert.agentId !== c.from) throw new Error('certificate is for another agent');
          senderKeys = [cert.signPub];
        }
        // the owner's own envelopes may be signed by any key of its chain (sent before a rotation)
        verifyWithAny(row.envelope, senderKeys);
        body = openEnvelope(row.envelope, { id: this.state.ownerId, ...this.identity });
        verified = true;
      } catch (e) {
        problem = (e as Error).message;
      }
      return {
        id: c.id,
        cursor: row.cursor,
        type: c.type,
        from: c.from,
        to: c.to,
        fromName: name(c.from),
        toName: name(c.to),
        ref: c.ref,
        scope: c.scope,
        grantId: c.grantId,
        createdAt: c.createdAt,
        receivedAt: row.receivedAt,
        expiresAt: c.expiresAt,
        held: row.held,
        released: row.release !== null,
        acked: row.ackedAt !== null,
        body,
        verified,
        problem,
        envelope: row.envelope,
      };
    });
  }
}

/** Requests waiting on the owner: agent asks/confirms/otps/grant-requests with no answer yet, and held messages. */
export function pendingForOwner(items: OwnerItem[], ownerId: string): OwnerItem[] {
  const answered = new Set(items.filter((i) => i.type === 'answer' && i.ref).map((i) => i.ref as string));
  const now = Date.now();
  return items.filter((i) => {
    if (i.held) return true;
    if (i.to !== ownerId) return false;
    if (!['ask', 'confirm', 'otp', 'grant-request'].includes(i.type)) return false;
    if (answered.has(i.id) || i.acked) return false;
    if (i.expiresAt !== null && i.expiresAt <= now) return false;
    return true;
  });
}

function verifyWithAny(envelope: Envelope, keys: string[]): void {
  let last: unknown = new Error('no key to verify with');
  for (const k of keys) {
    try {
      verifyEnvelope(envelope, k);
      return;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/**
 * Sender seq gaps the owner should know about (dropped or withheld envelopes). The owner's own seq is skipped (a send
 * that failed after taking a number leaves a harmless hole), and `sinceCursor` limits the check to what this install
 * synced live — older envelopes may already be deleted from the relay after delivery.
 */
export function seqGaps(
  items: OwnerItem[],
  senderSeq: Record<string, number>,
  opts: { ownerId?: string; sinceCursor?: number } = {},
): { sender: string; missing: number }[] {
  const seen = new Map<string, Set<number>>();
  for (const i of items) {
    if (i.from === opts.ownerId) continue;
    if (opts.sinceCursor !== undefined && i.cursor < opts.sinceCursor) continue;
    const set = seen.get(i.from) ?? new Set<number>();
    set.add(i.envelope.core.seq);
    seen.set(i.from, set);
  }
  const gaps: { sender: string; missing: number }[] = [];
  for (const [sender, set] of seen) {
    const top = Math.max(senderSeq[sender] ?? 0, ...set);
    const low = Math.min(...set);
    let missing = 0;
    for (let s = low; s <= top; s++) if (!set.has(s)) missing++;
    if (missing) gaps.push({ sender, missing });
  }
  return gaps;
}

export type { OwnerKeyPayload };
