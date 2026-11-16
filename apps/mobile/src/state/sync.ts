// Sync: relay → verify + decrypt (OwnerClient.openItems) → SQLite → store.
// Single-flight: every trigger (realtime signal, foreground, push, pull-to-refresh, after an action) joins the run
// in progress, and one more pass runs after it if anything asked while it was busy.

import { ApiError, OwnerClient, type OwnerItem, type OwnerState, RollbackError } from '@catcher/client';
import {
  type AgentSummary,
  type Directory,
  type StoredEnvelope,
  verifyOwnerChain,
  verifyStatement,
} from '@catcher/protocol';
import {
  getCursor,
  getKv,
  heldIds,
  loadItems,
  resetForOwner,
  savePage,
  saveReopened,
  setHeldState,
  setKv,
  unverifiedEnvelopes,
} from '@/lib/db';
import type { LocalItem } from '@/lib/db';
import { describeError } from '@/lib/errors';
import { loadOnboarded, loadOwnerState, saveOnboarded, saveOwnerState } from '@/lib/secure';
import { loadRooms } from './rooms';
import { getState, type GrantView, setState } from './store';

const PAGE = 200;
const STATE_CHUNK = 100;

const MISMATCHES_KEY = 'enrollMismatches';

/** Registration codes that failed their tag check, per lookup — kept on disk so the 3-strike lock survives a restart. */
function loadMismatches(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const raw: unknown = JSON.parse(getKv(MISMATCHES_KEY) ?? '{}');
    if (raw && typeof raw === 'object') {
      for (const [lookup, n] of Object.entries(raw)) if (typeof n === 'number') out.set(lookup, n);
    }
  } catch {
    // unreadable: start counting again
  }
  return out;
}

export function saveMismatches(owner: OwnerClient): void {
  setKv(MISMATCHES_KEY, JSON.stringify(Object.fromEntries(owner.enrollMismatches)));
}

export function makeClient(state: OwnerState): OwnerClient {
  return new OwnerClient(state, { save: saveOwnerState, enrollMismatches: loadMismatches() });
}

/** App start: read the owner key from the keychain. */
export async function bootstrap(): Promise<void> {
  const saved = await loadOwnerState();
  if (!saved) {
    setState({ ready: true, owner: null, onboarded: false });
    return;
  }
  resetForOwner(saved.ownerId);
  const owner = makeClient(saved);
  setState({ ready: true, owner, onboarded: loadOnboarded() });
  loadRooms();
  refreshFromDisk();
  // a key rotation interrupted by a crash or a dropped connection is finished here
  if (saved.pendingSeed) void owner.resumeRotation().catch(() => {});
}

/** New owner key — saved to the keychain before anything else, so a crash cannot lose it. */
export async function createOwner(server: string): Promise<void> {
  const state = await OwnerClient.create(server);
  saveOwnerState(state);
  resetForOwner(state.ownerId);
  setState({ owner: makeClient(state), onboarded: false, items: [], agents: [] });
  loadRooms();
}

export async function restoreOwner(server: string, code: string): Promise<void> {
  const state = await OwnerClient.restore(server, code);
  saveOwnerState(state);
  resetForOwner(state.ownerId);
  saveOnboarded();
  setState({ owner: makeClient(state), onboarded: true, items: [], agents: [] });
  loadRooms();
}

export function finishOnboarding(): void {
  saveOnboarded();
  setState({ onboarded: true });
}

function nameLookup(agents: AgentSummary[], ownerId: string): (id: string) => string {
  const byId = new Map(agents.map((a) => [a.agentId, a.name]));
  return (id) => {
    if (id === ownerId) return 'owner';
    return byId.get(id) ?? id;
  };
}

/** Re-read the local history (after a write or on start) with current agent names. */
export function refreshFromDisk(): void {
  const { owner, agents } = getState();
  if (!owner) return;
  setState({ items: loadItems(nameLookup(agents, owner.state.ownerId)) });
}

/**
 * The relay's revocation list must never be older than one this phone signed or saw: an older list would quietly bring
 * revoked agents and grants back. A newer one raises the remembered version (saved with the owner state).
 */
function checkRevocationVersion(owner: OwnerClient, version: number): void {
  const floor = owner.state.revocationVersion ?? 0;
  if (version < floor) throw new RollbackError(floor, version);
  if (version > floor) {
    owner.state.revocationVersion = version;
    saveOwnerState(owner.state);
  }
}

function grantViews(
  owner: OwnerClient,
  dir: Directory,
  ownerSignPub: string,
): { grants: GrantView[]; revokedAgents: string[] } {
  let revokedGrants: string[] = [];
  let revokedAgents: string[] = [];
  let version = 0;
  let readable = !dir.revocations;
  if (dir.revocations) {
    try {
      const r = verifyStatement(dir.revocations, 'revocations', ownerSignPub);
      revokedGrants = r.grants;
      revokedAgents = r.agents;
      version = r.version;
      readable = true;
    } catch {
      // not signed by the current key (mid-rotation): ignore, like agents do
    }
  }
  if (readable) checkRevocationVersion(owner, version);
  const now = Date.now();
  const grants: GrantView[] = [];
  for (const s of dir.grants) {
    try {
      const g = verifyStatement(s, 'grant', ownerSignPub);
      grants.push({
        ...g,
        revoked: revokedGrants.includes(g.grantId),
        expired: g.expiresAt !== null && g.expiresAt <= now,
      });
    } catch {
      // grants not signed by the current owner key are not in force
    }
  }
  return { grants, revokedAgents };
}

const SLICE = 25;

/** Signature checks are pure JS on Hermes; open a page in slices so the UI keeps responding. */
async function openInSlices(
  owner: OwnerClient,
  rows: StoredEnvelope[],
  agents: AgentSummary[],
  signKeys: string[],
): Promise<OwnerItem[]> {
  const out: OwnerItem[] = [];
  for (let i = 0; i < rows.length; i += SLICE) {
    out.push(...owner.openItems(rows.slice(i, i + SLICE), agents, signKeys));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return out;
}

/** Drop what a sync has caught up with: sent messages that came back, answers that are now on disk. */
function reconcileLocal(items: LocalItem[]): void {
  const ids = new Set(items.map((i) => i.id));
  const answered = new Set(items.filter((i) => i.type === 'answer' && i.ref).map((i) => i.ref));
  const { outbox, settled } = getState();
  // a typed message leaves the outbox once every copy of it (one per agent) came back
  const nextOutbox = outbox.filter((m) => m.ids.length < m.targets.length || !m.ids.every((id) => ids.has(id)));
  const nextSettled = Object.fromEntries(Object.entries(settled).filter(([id]) => !answered.has(id)));
  if (nextOutbox.length !== outbox.length || Object.keys(nextSettled).length !== Object.keys(settled).length) {
    setState({ outbox: nextOutbox, settled: nextSettled });
  }
}

function publishItems(owner: OwnerClient, agents: AgentSummary[]): void {
  const items = loadItems(nameLookup(agents, owner.state.ownerId));
  setState({ items });
  reconcileLocal(items);
}

async function syncOnce(): Promise<void> {
  const owner = getState().owner;
  if (!owner) return;
  // every relay call is a round trip to the edge and the database, so the three reads go out together
  let cursor = getCursor();
  const [agentsRes, dir, first] = await Promise.all([owner.agents(), owner.directory(), owner.feed(cursor, PAGE)]);
  const current = verifyOwnerChain(dir.ownerChain, owner.state.ownerId);
  const signKeys = dir.ownerChain.map((l) => l.payload.signPub);
  const agents = agentsRes.agents;
  const ownerKeySince = dir.ownerChain.find((l) => l.payload.seq === current.seq)?.payload.issuedAt ?? 0;
  setState({ agents, senderSeq: agentsRes.senderSeq, ownerKeySince, ownerSignKeys: signKeys });
  // an older permission list than this phone has seen: keep the grants we had, still sync messages, then warn
  let rollback: RollbackError | null = null;
  try {
    setState(grantViews(owner, dir, current.signPub));
  } catch (e) {
    if (!(e instanceof RollbackError)) throw e;
    rollback = e;
  }

  // feed pages; asking for the next page (after=cursor) is what lets the relay delete synced rows. A short page is
  // the last one, so that follow-up call (the ack) runs next to the held-state checks below instead of before them.
  let page = first;
  let ack: Promise<{ envelopes: unknown[] }> | null = null;
  let fresh = false;
  while (page.envelopes.length) {
    savePage(await openInSlices(owner, page.envelopes, agents, signKeys), page.cursor);
    cursor = page.cursor;
    fresh = true;
    if (page.envelopes.length < PAGE) {
      ack = owner.feed(cursor, PAGE);
      break;
    }
    page = await owner.feed(cursor, PAGE);
  }
  // new messages show now, before the slower bookkeeping below
  if (fresh) publishItems(owner, agents);
  // gap checks only cover what this install received live — older rows may already be gone from the relay
  if (getKv('liveSince') === null) setKv('liveSince', String(cursor));
  setState({ liveSince: Number(getKv('liveSince') ?? '0') });

  // rows that failed to verify before may pass now (e.g. the sender's cert arrived later)
  const retry: StoredEnvelope[] = unverifiedEnvelopes().map((r) => ({
    cursor: r.cursor,
    envelope: r.envelope,
    held: r.held,
    release: null,
    ackedAt: null,
    receivedAt: 0,
  }));
  if (retry.length) saveReopened(await openInSlices(owner, retry, agents, signKeys));

  // held messages change state after the fact (released, dropped, expired)
  const held = heldIds();
  const chunks: string[][] = [];
  for (let i = 0; i < held.length; i += STATE_CHUNK) chunks.push(held.slice(i, i + STATE_CHUNK));
  const states = await Promise.all(chunks.map((ids) => owner.envelopeStates(ids)));
  for (const [n, ids] of chunks.entries()) {
    const rows = states[n] ?? [];
    const byId = new Map(rows.map((r) => [r.envelope.core.id, r]));
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        // gone from the relay (dropped and cleaned up, or expired)
        setHeldState(id, { held: false, released: false, dropped: true, acked: false });
        continue;
      }
      if (row.held) continue;
      const released = row.release !== null;
      setHeldState(id, { held: false, released, dropped: !released, acked: row.ackedAt !== null });
    }
  }

  publishItems(owner, agents);
  setState({ lastSyncAt: Date.now(), syncError: null });
  // the ack page found rows that arrived meanwhile: one more pass picks them up
  if (ack && (await ack.catch(() => ({ envelopes: [] }))).envelopes.length) again = true;
  if (rollback) throw rollback;
}

let running: Promise<void> | null = null;
let again = false;

export function sync(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  setState({ syncing: true });
  running = (async () => {
    try {
      do {
        again = false;
        await syncOnce();
      } while (again);
    } catch (e) {
      setState({ syncError: describeError(e) });
      throw e;
    } finally {
      running = null;
      setState({ syncing: false });
    }
  })();
  return running;
}

/** Sync without throwing — for background triggers that have nowhere to show an error but the banner. */
export function syncQuietly(): void {
  sync().catch(() => {
    // already in syncError
  });
}

/** Find an item after a sync (notification taps). */
export function findItem(id: string): OwnerItem | undefined {
  return getState().items.find((i) => i.id === id);
}

export function isStaleSeq(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'stale_seq';
}

/**
 * Run an owner send. If the relay says our envelope counter is behind (another phone with the same key, or an old
 * backup), catch up to the relay's counter and try once more.
 */
export async function withSeqRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!isStaleSeq(e)) throw e;
    const owner = getState().owner;
    if (!owner) throw e;
    const { senderSeq } = await owner.agents();
    owner.state.seq = Math.max(owner.state.seq, senderSeq[owner.state.ownerId] ?? 0);
    saveOwnerState(owner.state);
    return run();
  }
}
