// Owner side — used by the phone app and by the headless owner in end-to-end tests.
// The owner key never leaves this side; every decision (cert, grant, revocation, release, answer) is signed here.

import {
  agentIdFor,
  type AgentSummary,
  type AgentsResponse,
  type AnswerBody,
  b64,
  type BodyByType,
  type CertPayload,
  type ClaimEnrollmentRequest,
  type ClaimEnrollmentResponse,
  ENROLL_MAX_MISMATCHES,
  type EnrollPayload,
  type Envelope,
  type EnvelopeType,
  type FeedResponse,
  fingerprint,
  type GrantPayload,
  type GrantRequestBody,
  identityFromSeed,
  type Identity,
  NAME_PATTERN,
  newIdentity,
  openEnvelope,
  type OwnerEnrollmentResponse,
  type OwnerKeyPayload,
  type OwnerLookupResponse,
  ownerIdFor,
  parseEnrollCode,
  publicKeys,
  randomId,
  recoveryCode,
  type RevocationsPayload,
  sealClaim,
  sealEnvelope,
  seedFromRecoveryCode,
  type Signed,
  signStatement,
  type StoredEnvelope,
  tagMatches,
  unb64,
  verifyEnroll,
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
  /**
   * Highest revocation list version this phone signed or saw. A relay list older than this is a rollback (it would
   * quietly un-revoke agents) and is refused. Persist it with the rest of the state.
   */
  revocationVersion?: number;
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

/** What the confirm sheet shows after the code checked out against the relay's answer. */
export interface EnrollmentPreview {
  lookup: string;
  /** derived here from the agent's key, not taken from the relay */
  agentId: string;
  name: string;
  device: string;
  provider: string;
  /** when the agent made the code (its own clock) */
  issuedAt: number;
  /** when the code stops working (relay clock) */
  expiresAt: number;
  /** audit only: the same value `catcher status` prints */
  fingerprint: string;
  /** your live agent with the same name, found in your own signed certs — claiming with `replace` revokes it */
  existing?: { agentId: string; name: string; device: string; provider: string };
}

export type EnrollmentProblem =
  | 'locked'
  | 'tag_mismatch'
  | 'bad_statement'
  | 'nothing_to_replace'
  | 'changed'
  | 'bad_name';

export interface ClaimOptions {
  /** continue the live agent with the agent's own name (preview.existing): disconnect it, take its place */
  replace?: boolean;
  /** continue this agent of yours (live or already disconnected): its name, conversation and grants carry over */
  continues?: string;
  /** what to call the agent — defaults to the name it asked for, or the name of the agent it continues */
  name?: string;
}

/** Local refusals. Code typos throw EnrollCodeError (bad_length / bad_char / bad_check); relay answers throw ApiError. */
export class EnrollmentError extends Error {
  code: EnrollmentProblem;
  constructor(code: EnrollmentProblem, message: string) {
    super(message);
    this.code = code;
  }
}

/** The relay served a revocation list older than one this phone signed or saw. */
export class RollbackError extends Error {
  code = 'revocations_rolled_back';
  constructor(expected: number, got: number) {
    super(`the relay served revocation list v${got}, older than v${expected} this phone already has — not trusting it`);
  }
}

interface VerifiedEnrollment {
  code: { lookup: string; secret: string; tag: string };
  payload: EnrollPayload;
  /** the enroll statement's signature: the exact statement the confirm sheet showed */
  sig: string;
  preview: EnrollmentPreview;
}

function scopesOf(g: GrantPayload): string {
  return [...g.scopes].sort().join(',');
}

export class OwnerClient {
  state: OwnerState;
  identity: Identity;
  api: Api;
  /**
   * Tag mismatches per lookup. After ENROLL_MAX_MISMATCHES the app refuses that code without asking the relay. Pass a
   * persisted map to keep the count across restarts.
   */
  enrollMismatches: Map<string, number>;
  private save: (s: OwnerState) => void;
  private fetchImpl: Fetch | undefined;
  private verifiedEnrollments = new Map<string, VerifiedEnrollment>();

  constructor(
    state: OwnerState,
    opts: { fetch?: Fetch; save?: (s: OwnerState) => void; enrollMismatches?: Map<string, number> } = {},
  ) {
    this.state = state;
    this.enrollMismatches = opts.enrollMismatches ?? new Map();
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

  async agents(): Promise<AgentsResponse> {
    return this.api.call<AgentsResponse>('GET', '/v1/owner/agents');
  }

  async directory(): Promise<Directory> {
    return this.api.call<Directory>('GET', '/v1/directory');
  }

  agentFingerprint(agent: Pick<AgentSummary, 'signPub' | 'boxPub'>): string {
    return fingerprint({ signPub: agent.signPub, boxPub: agent.boxPub });
  }

  /**
   * Step 1–4 of adding an agent: check the code locally (length, characters, check character), refuse a lookup that
   * already failed ENROLL_MAX_MISMATCHES times, fetch the agent's self-signed statement by its lookup (the only part of
   * the code that leaves the phone), verify it, and match the code's tag against the agent keys the relay returned.
   * Returns what the confirm sheet shows. Nothing is approved yet.
   */
  async lookupEnrollment(code: string): Promise<EnrollmentPreview> {
    const parsed = parseEnrollCode(code);
    if ((this.enrollMismatches.get(parsed.lookup) ?? 0) >= ENROLL_MAX_MISMATCHES) {
      throw new EnrollmentError('locked', 'this code failed its check too often — ask the agent to run register again');
    }
    const res = await this.api.call<OwnerEnrollmentResponse>('GET', `/v1/owner/enrollments/${parsed.lookup}`);
    let payload: EnrollPayload;
    try {
      payload = verifyEnroll(res.statement, parsed.lookup);
    } catch {
      throw new EnrollmentError('bad_statement', 'the relay answered with a registration that does not check out');
    }
    if (!tagMatches(parsed, payload)) {
      this.enrollMismatches.set(parsed.lookup, (this.enrollMismatches.get(parsed.lookup) ?? 0) + 1);
      throw new EnrollmentError(
        'tag_mismatch',
        'this code does not match the agent the relay returned — check the code; nothing was approved',
      );
    }
    const preview: EnrollmentPreview = {
      lookup: parsed.lookup,
      agentId: agentIdFor(payload.signPub),
      name: payload.name,
      device: payload.device,
      provider: payload.provider,
      issuedAt: payload.issuedAt,
      expiresAt: res.expiresAt,
      fingerprint: fingerprint({ signPub: payload.signPub, boxPub: payload.boxPub }),
    };
    const existing = await this.liveAgentNamed(payload.name);
    if (existing) preview.existing = existing;
    this.verifiedEnrollments.set(parsed.lookup, { code: parsed, payload, sig: res.statement.sig, preview });
    return preview;
  }

  /**
   * Step 5, after the person tapped approve on the confirm sheet: sign the cert and the claim (which seals the code's
   * secret part to the agent) and post both. The owner may give the agent another name than the one it asked for. To
   * continue an old agent (`replace` for the live one with the same name, `continues` for any of yours), the old agent
   * is disconnected first and the new cert names it; move its grants with `continueGrants` afterwards.
   */
  async claimEnrollment(code: string, opts: ClaimOptions = {}): Promise<{ agentId: string; name: string }> {
    const parsed = parseEnrollCode(code);
    let verified = this.verifiedEnrollments.get(parsed.lookup);
    const stale = !verified || verified.code.secret !== parsed.secret || verified.code.tag !== parsed.tag;
    const continuing = !!opts.replace || opts.continues !== undefined;
    if (continuing) {
      // continuing disconnects the old agent and hands its place over, so the person must have seen exactly what gets
      // approved
      if (stale || !verified) throw new EnrollmentError('changed', 'show the confirm sheet for this code first');
      const shown = verified;
      // and right before revoking: the code is still valid and unclaimed (a typo or a used code never costs the old
      // agent), and it is still the same registration and the same old agent as on the sheet
      await this.lookupEnrollment(code);
      verified = this.verifiedEnrollments.get(parsed.lookup);
      if (
        !verified ||
        verified.sig !== shown.sig ||
        verified.preview.existing?.agentId !== shown.preview.existing?.agentId
      ) {
        throw new EnrollmentError('changed', 'this registration changed since you looked — check it again');
      }
    } else if (stale) {
      await this.lookupEnrollment(code);
      verified = this.verifiedEnrollments.get(parsed.lookup);
    }
    if (!verified) throw new EnrollmentError('bad_statement', 'look the code up first');
    const { payload, preview } = verified;
    let oldId: string | undefined = opts.continues;
    if (opts.replace) {
      if (!preview.existing)
        throw new EnrollmentError('nothing_to_replace', `you have no live agent named ${payload.name}`);
      oldId = preview.existing.agentId;
    }
    let name = opts.name ?? payload.name;
    let revocationFloor: number;
    if (oldId !== undefined) {
      // the old agent comes from a cert this owner signed, never from the relay's word
      const old = (await this.certifiedAgents()).get(oldId);
      if (!old || oldId === preview.agentId) {
        throw new EnrollmentError('nothing_to_replace', 'that agent is not one of yours any more');
      }
      if (opts.name === undefined) name = old.cert.name;
      if (old.live) {
        // the cert carries the revocation version that includes the old agent
        revocationFloor = (await this.revoke({ agents: [oldId] })).payload.version;
      } else {
        revocationFloor = await this.revocationVersion();
      }
    } else {
      revocationFloor = await this.revocationVersion();
    }
    if (!NAME_PATTERN.test(name)) {
      throw new EnrollmentError('bad_name', 'use lowercase letters, digits and dashes (max 32), not "owner"');
    }
    const now = Date.now();
    const certPayload: CertPayload = {
      kind: 'cert',
      ownerId: this.state.ownerId,
      agentId: preview.agentId,
      name,
      signPub: payload.signPub,
      boxPub: payload.boxPub,
      device: payload.device,
      provider: payload.provider,
      issuedAt: now,
      expiresAt: now + CERT_DAYS * 86_400_000,
      revocationFloor,
    };
    if (oldId !== undefined) certPayload.continues = oldId;
    const cert = signStatement(certPayload, this.identity);
    const claim = sealClaim({
      owner: this.identity,
      ownerId: this.state.ownerId,
      lookup: parsed.lookup,
      secret: parsed.secret,
      agentId: preview.agentId,
      agentSignPub: payload.signPub,
      agentBoxPub: payload.boxPub,
      issuedAt: now,
    });
    const body: ClaimEnrollmentRequest = { claim, cert };
    if (oldId !== undefined) body.replace = oldId;
    const res = await this.api.call<ClaimEnrollmentResponse>(
      'POST',
      `/v1/owner/enrollments/${parsed.lookup}/claim`,
      body,
    );
    this.verifiedEnrollments.delete(parsed.lookup);
    return { agentId: res.agentId, name };
  }

  /**
   * Every agent this owner ever certified, from certs signed by a key in the verified owner chain (the relay's list is
   * only where they are found). `live`: active, unexpired and not on the revocation list.
   */
  async certifiedAgents(): Promise<Map<string, { cert: CertPayload; live: boolean }>> {
    const [list, dir] = await Promise.all([this.agents(), this.directory()]);
    verifyOwnerChain(dir.ownerChain, this.state.ownerId);
    const keys = dir.ownerChain.map((l) => l.payload.signPub);
    let revoked = new Set<string>();
    try {
      revoked = new Set(this.checkedRevocations(dir)?.agents ?? []);
    } catch (e) {
      if (e instanceof RollbackError) throw e;
      // mid-rotation the list may still carry the old key
    }
    const now = Date.now();
    const out = new Map<string, { cert: CertPayload; live: boolean }>();
    for (const a of list.agents) {
      if (!a.cert || !keys.includes(a.cert.signer)) continue;
      let c: CertPayload;
      try {
        c = verifyStatement(a.cert, 'cert', a.cert.signer);
      } catch {
        continue;
      }
      if (c.ownerId !== this.state.ownerId || c.agentId !== a.agentId) continue;
      const live = a.status === 'active' && c.expiresAt > now && !revoked.has(c.agentId);
      out.set(c.agentId, { cert: c, live });
    }
    return out;
  }

  /**
   * After continuing `oldId` with `newId`: every grant the old agent had (not revoked, not expired, with an agent that
   * is still live) is issued again for the new one with the same scopes, approval rule and expiry, then the old grants
   * are revoked. Safe to run again after a failure: a grant the new agent already has is not issued twice.
   */
  async continueGrants(oldId: string, newId: string): Promise<number> {
    const dir = await this.directory();
    const key = b64(this.identity.signPub);
    const revocations = this.checkedRevocations(dir);
    const revokedGrants = new Set(revocations?.grants ?? []);
    const revokedAgents = new Set(revocations?.agents ?? []);
    const now = Date.now();
    const liveAgents = new Set<string>();
    for (const s of dir.certs) {
      try {
        const c = verifyStatement(s, 'cert', key);
        if (c.expiresAt > now && !revokedAgents.has(c.agentId)) liveAgents.add(c.agentId);
      } catch {
        // signed by an older key: re-signed by resignAll, not ours to judge here
      }
    }
    const grants: GrantPayload[] = [];
    for (const s of dir.grants) {
      try {
        const g = verifyStatement(s, 'grant', key);
        if (revokedGrants.has(g.grantId) || (g.expiresAt !== null && g.expiresAt <= now)) continue;
        grants.push(g);
      } catch {
        // not in force
      }
    }
    const moved: string[] = [];
    let issued = 0;
    for (const g of grants) {
      if (g.from !== oldId && g.to !== oldId) continue;
      let from = g.from;
      let to = g.to;
      if (from === oldId) from = newId;
      if (to === oldId) to = newId;
      moved.push(g.grantId);
      const other = (from === newId && to) || from;
      if (from === to || !liveAgents.has(other)) continue;
      const has = grants.some(
        (x) =>
          x.from === from &&
          x.to === to &&
          scopesOf(x) === scopesOf(g) &&
          x.requireApproval === g.requireApproval &&
          x.expiresAt === g.expiresAt,
      );
      if (has) continue;
      await this.grant({ from, to, scopes: g.scopes, requireApproval: g.requireApproval, expiresAt: g.expiresAt });
      issued += 1;
    }
    if (moved.length) await this.revoke({ grants: moved });
    return issued;
  }

  /** A new name (a nickname — agents address each other by it) or a corrected platform: the same cert, signed again. */
  async updateAgent(agentId: string, change: { name?: string; provider?: string }): Promise<void> {
    if (change.name !== undefined && !NAME_PATTERN.test(change.name)) {
      throw new EnrollmentError('bad_name', 'use lowercase letters, digits and dashes (max 32), not "owner"');
    }
    const dir = await this.directory();
    const key = b64(this.identity.signPub);
    for (const s of dir.certs) {
      let c: CertPayload;
      try {
        c = verifyStatement(s, 'cert', key);
      } catch {
        continue;
      }
      if (c.agentId !== agentId || c.ownerId !== this.state.ownerId) continue;
      const next: CertPayload = { ...c, issuedAt: Date.now() };
      if (change.name !== undefined) next.name = change.name;
      if (change.provider !== undefined) next.provider = change.provider;
      await this.api.call('POST', '/v1/owner/certs', { cert: signStatement(next, this.identity) });
      return;
    }
    throw new Error('this agent has no certificate signed by this phone');
  }

  /** Take a disconnected agent off the lists (the relay keeps the row; history keeps its name). */
  async removeAgent(agentId: string): Promise<void> {
    await this.api.call('POST', `/v1/owner/agents/${agentId}/remove`, {});
  }

  /** Current revocation list version, verified with this phone's key (0 when there is none). */
  private async revocationVersion(): Promise<number> {
    const dir = await this.directory();
    return this.checkedRevocations(dir)?.version ?? 0;
  }

  /** A live agent with this name, from certs this owner key signed (never from the relay's word). */
  private async liveAgentNamed(name: string): Promise<EnrollmentPreview['existing']> {
    const dir = await this.directory();
    const key = b64(this.identity.signPub);
    const revoked = new Set<string>();
    if (dir.revocations) {
      let list: RevocationsPayload | null = null;
      try {
        list = this.checkedRevocations(dir);
      } catch (e) {
        if (e instanceof RollbackError) throw e;
        // mid-rotation the list may still carry the old key; a stale hit only offers a replace that revokes again
      }
      for (const a of list?.agents ?? []) revoked.add(a);
    }
    const now = Date.now();
    for (const s of dir.certs) {
      let c: CertPayload;
      try {
        c = verifyStatement(s, 'cert', key);
      } catch {
        continue;
      }
      if (c.ownerId !== this.state.ownerId || c.name !== name || c.expiresAt <= now || revoked.has(c.agentId)) continue;
      return { agentId: c.agentId, name: c.name, device: c.device, provider: c.provider };
    }
    return undefined;
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

  /**
   * The relay's revocation list, verified, and never older than the highest version this phone signed or saw (a relay
   * serving an older list would have the next revocation silently drop earlier ones). Raises the remembered version.
   */
  private checkedRevocations(dir: Directory, signer = b64(this.identity.signPub)): RevocationsPayload | null {
    const floor = this.state.revocationVersion ?? 0;
    if (!dir.revocations) {
      if (floor > 0) throw new RollbackError(floor, 0);
      return null;
    }
    const r = verifyStatement(dir.revocations, 'revocations', signer);
    if (r.version < floor) throw new RollbackError(floor, r.version);
    this.noteRevocationVersion(r.version);
    return r;
  }

  private noteRevocationVersion(version: number): void {
    if (version <= (this.state.revocationVersion ?? 0)) return;
    this.state.revocationVersion = version;
    this.save(this.state);
  }

  /** Add agents/grants to the signed revocation list (version + 1). */
  async revoke(input: { agents?: string[]; grants?: string[] }): Promise<Signed<RevocationsPayload>> {
    const dir = await this.directory();
    const current: RevocationsPayload = this.checkedRevocations(dir) ?? {
      kind: 'revocations',
      ownerId: this.state.ownerId,
      version: 0,
      agents: [],
      grants: [],
      issuedAt: 0,
    };
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
    // remembered before the relay hears of it: a crash after posting never lets an older list back in
    this.noteRevocationVersion(revocations.payload.version);
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
      const r = this.checkedRevocations(dir, dir.revocations.signer);
      if (!r) throw new Error('revocation list missing');
      const revocations = signStatement({ ...r, version: r.version + 1, issuedAt: Date.now() }, this.identity);
      this.noteRevocationVersion(revocations.payload.version);
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
