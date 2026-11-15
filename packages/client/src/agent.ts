// Agent side — verified directory, sending, inbox (verify + decrypt), ack, waiting on answers.
// Every envelope is checked against owner-signed certs and grants locally; the server is not trusted.

import {
  boxKeyOf,
  buildTrust,
  checkEnvelope,
  type BodyByType,
  type Directory,
  type EnvelopeType,
  fingerprint,
  identityFromSeed,
  type Identity,
  type InboxResponse,
  type MeResponse,
  openEnvelope,
  PolicyError,
  type PostEnvelopeResponse,
  publicKeys,
  randomId,
  type RepliesResponse,
  sealEnvelope,
  type StoredEnvelope,
  type Trust,
  unb64,
  findGrant,
} from '@catcher/protocol';
import { Api, ApiError, type Fetch } from './api.ts';

export interface AgentState {
  server: string;
  agentId: string;
  ownerId: string;
  name: string;
  /** base64url 32-byte seed — the agent's only secret */
  seed: string;
  /** owner keys this agent trusts (pinned at registration, moved forward along the signed chain) */
  ownerPin: { signPub: string; boxPub: string };
  /** highest revocation list version seen — a lower one from the server is a rollback */
  revocationVersion: number;
  /** last envelope seq this agent used */
  seq: number;
}

export interface Received {
  id: string;
  cursor: number;
  type: EnvelopeType;
  from: { id: string; name: string };
  to: string;
  ref: string | null;
  scope: string | null;
  grantId: string | null;
  createdAt: number;
  expiresAt: number | null;
  receivedAt: number;
  body: unknown;
}

export interface Rejected {
  id: string;
  cursor: number;
  from: string;
  reason: string;
  code: string;
}

/** Where the agent keeps the last verified directory between runs (re-verified on load — it is only a cache). */
export interface DirectoryCache {
  load(): { version: number; directory: Directory } | null;
  save(entry: { version: number; directory: Directory }): void;
}

export interface AgentClientOptions {
  fetch?: Fetch;
  save?: (s: AgentState) => void;
  directoryCache?: DirectoryCache;
  /** ids this agent already received — anything seen again is a replay and is dropped */
  seen?: (id: string) => boolean;
  /** this agent's own sent messages by id — replies and answers must point at one of them */
  outgoing?: (id: string) => { type: string; to: string } | null;
}

const OWNER_REQUESTS = ['ask', 'confirm', 'otp', 'grant-request'];

export function nameOfParty(trust: Trust, id: string): string {
  if (id === trust.ownerId) return 'owner';
  return trust.agents.get(id)?.name ?? id;
}

export class AgentClient {
  state: AgentState;
  identity: Identity;
  api: Api;
  private save: (s: AgentState) => void;
  private dirCache: DirectoryCache | undefined;
  private seen: (id: string) => boolean;
  private outgoing: AgentClientOptions['outgoing'];
  private cachedTrust: Trust | null = null;
  private cachedVersion = 0;

  constructor(state: AgentState, opts: AgentClientOptions = {}) {
    this.state = state;
    this.identity = identityFromSeed(unb64(state.seed));
    this.api = new Api({ server: state.server, callerId: state.agentId, identity: this.identity, fetch: opts.fetch });
    this.save = opts.save ?? (() => {});
    this.dirCache = opts.directoryCache;
    this.seen = opts.seen ?? (() => false);
    this.outgoing = opts.outgoing;
  }

  agentFingerprint(): string {
    return fingerprint(publicKeys(this.identity));
  }

  ownerFingerprint(): string {
    return fingerprint(this.state.ownerPin);
  }

  async me(): Promise<MeResponse> {
    return this.api.call<MeResponse>('GET', '/v1/me');
  }

  /**
   * Verified view of certs and grants. Uses the on-disk cache when its version is current (the relay answers
   * "unchanged" without sending the directory), so a heartbeat costs the relay almost nothing.
   * `knownVersion` comes from the inbox answer; pass `refresh` to force a re-check.
   */
  async trust(opts: { refresh?: boolean; knownVersion?: number } = {}): Promise<Trust> {
    const hintMatches = opts.knownVersion === undefined || opts.knownVersion === this.cachedVersion;
    if (this.cachedTrust && !opts.refresh && hintMatches) return this.cachedTrust;
    const cached = this.dirCache?.load() ?? null;
    let entry: { version: number; directory: Directory };
    if (cached && !opts.refresh && opts.knownVersion === cached.version) {
      entry = cached;
    } else {
      let known = 0;
      if (cached && !opts.refresh) known = cached.version;
      const res = await this.api.call<(Directory & { version: number }) | { unchanged: true; version: number }>(
        'GET',
        `/v1/directory?known=${known}`,
      );
      if ('unchanged' in res && cached) {
        entry = cached;
      } else if ('unchanged' in res) {
        return this.trust({ refresh: true });
      } else {
        entry = { version: res.version, directory: res };
        this.dirCache?.save(entry);
      }
    }
    const directory = entry.directory;
    const version = entry.version;
    const trust = buildTrust(
      directory,
      { ownerId: this.state.ownerId, ...this.state.ownerPin },
      this.state.revocationVersion,
    );
    if (!trust.agents.has(this.state.agentId)) {
      throw new PolicyError('not_certified', 'this agent has no valid owner certificate (revoked or expired)');
    }
    let changed = false;
    if (trust.owner.signPub !== this.state.ownerPin.signPub) {
      this.state.ownerPin = { signPub: trust.owner.signPub, boxPub: trust.owner.boxPub };
      changed = true;
    }
    if (trust.revocationVersion > this.state.revocationVersion) {
      this.state.revocationVersion = trust.revocationVersion;
      changed = true;
    }
    if (changed) this.save(this.state);
    this.cachedTrust = trust;
    this.cachedVersion = version;
    return trust;
  }

  /** "owner", an agent name, or an agent id → id */
  async resolve(target: string): Promise<string> {
    const trust = await this.trust();
    if (target === 'owner' || target === trust.ownerId) return trust.ownerId;
    if (trust.agents.has(target)) return target;
    for (const cert of trust.agents.values()) {
      if (cert.name === target) return cert.agentId;
    }
    throw new PolicyError('unknown_party', `no certified agent named ${target}`);
  }

  private nextSeq(): number {
    this.state.seq += 1;
    this.save(this.state);
    return this.state.seq;
  }

  async send<T extends EnvelopeType>(
    type: T,
    to: string,
    body: BodyByType[T],
    opts: { scope?: string; ref?: string; expiresAt?: number; id?: string; grantId?: string } = {},
  ): Promise<{ id: string; held: boolean; duplicate: boolean }> {
    const trust = await this.trust();
    const toId = await this.resolve(to);
    let scope: string | null = null;
    let grantId: string | null = null;
    const agentToAgent = toId !== trust.ownerId;
    if (agentToAgent && type === 'message') {
      scope = opts.scope ?? 'message';
      const grant = findGrant(trust, this.state.agentId, toId, scope);
      if (!grant) {
        throw new PolicyError(
          'no_grant',
          `no grant lets ${this.state.name} send "${scope}" to ${nameOfParty(trust, toId)} — ask the owner: catcher grant ${this.state.name} ${nameOfParty(trust, toId)} ${scope}`,
        );
      }
      grantId = grant.grantId;
    }
    if (agentToAgent && type === 'reply') {
      if (!opts.grantId) throw new PolicyError('no_grant', 'a reply to another agent needs the grant of its message');
      grantId = opts.grantId;
    }
    const id = opts.id ?? randomId('m');
    const parties = [...new Set([toId, trust.ownerId, this.state.agentId])];
    const recipients = parties.map((pid) => ({ id: pid, boxPub: boxKeyOf(trust, pid) }));
    const post = async (seq: number) =>
      this.api.call<PostEnvelopeResponse>('POST', '/v1/envelopes', {
        envelope: sealEnvelope({
          id,
          ownerId: trust.ownerId,
          from: this.state.agentId,
          to: toId,
          type,
          seq,
          body,
          ref: opts.ref ?? null,
          scope,
          grantId,
          expiresAt: opts.expiresAt ?? null,
          sender: this.identity,
          recipients,
        }),
      });
    let res: PostEnvelopeResponse;
    try {
      res = await post(this.nextSeq());
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'stale_seq') throw e;
      // state file was restored or copied — resume from the server's counter
      const me = await this.me();
      // never move the counter back: a lower value from the relay would let it hide a dropped message
      this.state.seq = Math.max(this.state.seq, me.lastSeq);
      res = await post(this.nextSeq());
    }
    return { id, held: res.held, duplicate: res.duplicate };
  }

  /** Verify + decrypt. Anything that fails policy comes back in `rejected` and is never shown as content. */
  async verifyAll(
    rows: StoredEnvelope[],
    knownVersion?: number,
  ): Promise<{ received: Received[]; rejected: Rejected[] }> {
    let trust = await this.trust({ knownVersion });
    const received: Received[] = [];
    const rejected: Rejected[] = [];
    for (const row of rows) {
      const c = row.envelope.core;
      try {
        if (c.to !== this.state.agentId) throw new PolicyError('not_mine', 'not addressed to this agent');
        if (this.seen(c.id)) throw new PolicyError('replay', 'already received this message');
        if (c.type === 'reply' || c.type === 'answer') {
          const sent = this.outgoing?.(c.ref ?? '');
          if (this.outgoing && (!sent || sent.to !== c.from)) {
            throw new PolicyError('bad_ref', `${c.type} does not answer a message this agent sent to ${c.from}`);
          }
          if (sent && c.type === 'answer' && !OWNER_REQUESTS.includes(sent.type)) {
            throw new PolicyError('bad_ref', 'answer to something that was not a request');
          }
          if (sent && c.type === 'reply' && sent.type !== 'message')
            throw new PolicyError('bad_ref', 'reply to a non-message');
        }
        try {
          checkEnvelope(trust, row.envelope, { release: row.release });
        } catch (e) {
          // a sender certified after our last directory read: refresh once
          if (!(e instanceof PolicyError) || e.code !== 'unknown_party') throw e;
          trust = await this.trust({ refresh: true });
          checkEnvelope(trust, row.envelope, { release: row.release });
        }
        const body = openEnvelope(row.envelope, { id: this.state.agentId, ...this.identity });
        received.push({
          id: c.id,
          cursor: row.cursor,
          type: c.type,
          from: { id: c.from, name: nameOfParty(trust, c.from) },
          to: c.to,
          ref: c.ref,
          scope: c.scope,
          grantId: c.grantId,
          createdAt: c.createdAt,
          expiresAt: c.expiresAt,
          receivedAt: row.receivedAt,
          body,
        });
      } catch (e) {
        let code = 'bad_envelope';
        if (e instanceof PolicyError) code = e.code;
        rejected.push({ id: c.id, cursor: row.cursor, from: c.from, reason: (e as Error).message, code });
      }
    }
    return { received, rejected };
  }

  async inbox(limit = 50): Promise<{ received: Received[]; rejected: Rejected[] }> {
    const res = await this.api.call<InboxResponse & { dirVersion: number }>('GET', `/v1/inbox?limit=${limit}`);
    if (!res.envelopes.length) {
      // nothing to verify — but still notice directory changes (revocation of this agent, rotated owner key)
      if (res.dirVersion !== this.dirCache?.load()?.version) await this.trust({ knownVersion: res.dirVersion });
      return { received: [], rejected: [] };
    }
    return this.verifyAll(res.envelopes, res.dirVersion);
  }

  async ack(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const res = await this.api.call<{ acked: number }>('POST', '/v1/ack', { ids });
    return res.acked;
  }

  /** Answers/replies to one of this agent's requests (owner-signed for answers). */
  async replies(ref: string): Promise<Received[]> {
    const res = await this.api.call<RepliesResponse>('GET', `/v1/replies?ref=${encodeURIComponent(ref)}`);
    const { received } = await this.verifyAll(res.envelopes);
    return received.filter((r) => r.ref === ref && r.to === this.state.agentId);
  }

  /** Poll for the first answer/reply to `ref`. Resolves null on timeout. */
  async waitFor(
    ref: string,
    opts: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal },
  ): Promise<Received | null> {
    const deadline = Date.now() + opts.timeoutMs;
    let interval = opts.intervalMs ?? 2000;
    for (;;) {
      const found = await this.replies(ref);
      const first = found[0];
      if (first) return first;
      if (Date.now() >= deadline || opts.signal?.aborted) return null;
      await new Promise((r) => setTimeout(r, Math.min(interval, Math.max(0, deadline - Date.now()))));
      // back off gently: 2s → 15s
      interval = Math.min(Math.round(interval * 1.5), 15000);
    }
  }
}
