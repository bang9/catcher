// Conversations. Three kinds, all shown with the same chat screen:
//   agent  — the owner and one agent (a:<agentId>)
//   pair   — two agents talking to each other, which the owner reads and can join (p:<agentId>~<agentId>, ids sorted)
//   group  — the owner and several agents at once, kept on this phone only (g:<groupId>)
// A message typed in a pair or group goes to every agent in it, one envelope each, and is remembered locally
// (roomSends) so it shows in that conversation; agents' replies point back to it (ref) and show there too.

import { useMemo } from 'react';
import { type AgentSummary, verifyStatement } from '@catcher/protocol';
import { getKv, type LocalItem, setKv } from '@/lib/db';
import { describeError } from '@/lib/errors';
import { usePending, useOwnerId } from './selectors';
import { getState, type Group, type OutMessage, requireOwner, type RoomSend, setState, useApp } from './store';
import { syncQuietly, withSeqRetry } from './sync';

export type Room =
  | { kind: 'agent'; key: string; agentId: string }
  | { kind: 'pair'; key: string; a: string; b: string }
  | { kind: 'group'; key: string; group: Group };

export function agentKey(agentId: string): string {
  return `a:${agentId}`;
}

export function pairId(x: string, y: string): string {
  return [x, y].sort().join('~');
}

export function pairKey(x: string, y: string): string {
  return `p:${pairId(x, y)}`;
}

export function groupKey(id: string): string {
  return `g:${id}`;
}

/** The two agents of a pair id, or null when it is not one. */
export function splitPair(id: string): [string, string] | null {
  const parts = id.split('~');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return [parts[0], parts[1]];
}

// ─── an agent and the agents it continues ────────────────────────────────────
// When an agent's machine is rebuilt it comes back with a new key, so a new id. The owner can connect it as the
// continuation of the old one (its cert says `continues`): both ids are then one conversation, under the newest.

/** old agent id → the agent that continues it, from certs signed by the owner chain. */
export function successors(agents: AgentSummary[], ownerSignKeys: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of agents) {
    const cert = a.cert;
    const old = cert?.payload.continues;
    if (!cert || !old || old === a.agentId || !ownerSignKeys.includes(cert.signer)) continue;
    try {
      const c = verifyStatement(cert, 'cert', cert.signer);
      if (c.agentId === a.agentId && c.continues === old) out.set(old, a.agentId);
    } catch {
      // not the owner's signature: not a continuation
    }
  }
  return out;
}

/** The newest agent in an id's line (the id itself when nothing continues it). */
export function newest(next: Map<string, string>, id: string): string {
  let cur = id;
  // a chain can only be as long as the agents list; a loop (never signed that way) stops here too
  for (let i = 0; i <= next.size; i += 1) {
    const n = next.get(cur);
    if (!n) return cur;
    cur = n;
  }
  return cur;
}

/** `newest` for every id, from the agents in the store. */
export function useNewest(): (id: string) => string {
  const agents = useApp((s) => s.agents);
  const keys = useApp((s) => s.ownerSignKeys);
  return useMemo(() => {
    const next = successors(agents, keys);
    return (id: string) => newest(next, id);
  }, [agents, keys]);
}

/** Move an agent's place in groups to the agent that continues it (kept on this phone only). */
export function moveGroups(oldId: string, newId: string): void {
  const groups = getState().groups.map((g) => {
    if (!g.members.includes(oldId)) return g;
    const members = [...new Set(g.members.map((m) => (m === oldId && newId) || m))].sort();
    return { ...g, members };
  });
  saveGroups(groups.filter((g) => g.members.length > 1));
}

// ─── on-disk state (kv) ──────────────────────────────────────────────────────

const GROUPS = 'groups';
const SENDS = 'roomSends';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = getKv(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** App start (after the owner key loads): bring back groups and which pair/group each sent message belongs to. */
export function loadRooms(): void {
  setState({ groups: readJson<Group[]>(GROUPS, []), roomSends: readJson<Record<string, RoomSend>>(SENDS, {}) });
}

function saveGroups(groups: Group[]): void {
  setKv(GROUPS, JSON.stringify(groups));
  setState({ groups });
}

/** A group with exactly these members, made if it does not exist yet. */
export function openGroup(members: string[]): Group {
  const sorted = [...new Set(members)].sort();
  const same = getState().groups.find((g) => g.members.join(',') === sorted.join(','));
  if (same) return same;
  const group: Group = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    members: sorted,
    createdAt: Date.now(),
  };
  saveGroups([...getState().groups, group]);
  return group;
}

export function deleteGroup(id: string): void {
  saveGroups(getState().groups.filter((g) => g.id !== id));
}

function rememberSend(id: string, room: string, send: string): void {
  if (room.startsWith('a:')) return;
  const roomSends = { ...getState().roomSends, [id]: { room, send } };
  setKv(SENDS, JSON.stringify(roomSends));
  setState({ roomSends });
}

// ─── sending ─────────────────────────────────────────────────────────────────

let nextKey = 0;

function patchOut(key: string, patch: Partial<OutMessage>): void {
  setState({
    outbox: getState().outbox.map((m) => {
      if (m.key !== key) return m;
      return { ...m, ...patch };
    }),
  });
}

async function deliver(key: string): Promise<void> {
  const msg = getState().outbox.find((m) => m.key === key);
  if (!msg) return;
  const owner = requireOwner();
  const ids = [...msg.ids];
  try {
    // one after another: each envelope takes the next sequence number, and the relay wants them in order
    for (const target of msg.targets.slice(ids.length)) {
      const agent = getState().agents.find((a) => a.agentId === target);
      if (!agent) throw new Error('agent is gone');
      const id = await withSeqRetry(() => owner.send('message', agent, { text: msg.text }));
      ids.push(id);
      rememberSend(id, msg.room, key);
      patchOut(key, { ids: [...ids] });
    }
    patchOut(key, { failed: null });
    syncQuietly();
  } catch (e) {
    patchOut(key, { ids, failed: describeError(e) });
  }
}

/** Show the message in its conversation now; send it to every target in the background. */
export function sendToRoom(room: string, targets: string[], text: string): void {
  nextKey += 1;
  const key = `out-${Date.now()}-${nextKey}`;
  setState({
    outbox: [...getState().outbox, { key, room, targets, ids: [], text, createdAt: Date.now(), failed: null }],
  });
  void deliver(key);
}

export function retryMessage(key: string): void {
  patchOut(key, { failed: null });
  void deliver(key);
}

export function discardMessage(key: string): void {
  setState({ outbox: getState().outbox.filter((m) => m.key !== key) });
}

/** Sent to all its targets: done once a sync brought every envelope back. */
export function outSent(m: OutMessage): boolean {
  return m.ids.length === m.targets.length;
}

// ─── what each conversation shows ────────────────────────────────────────────

/** Items of one conversation, oldest first. */
export function roomItems(
  room: Room,
  items: LocalItem[],
  ownerId: string,
  roomSends: Record<string, RoomSend>,
  /** an old agent's items count as its newest continuation's */
  same: (id: string) => string = (id) => id,
): LocalItem[] {
  if (room.kind === 'agent') {
    const id = room.agentId;
    return items.filter((i) => {
      const from = same(i.from);
      const to = same(i.to);
      const direct = (i.from === ownerId && to === id) || (from === id && i.to === ownerId);
      if (!direct) return false;
      // sent from a pair or group: it lives there
      if (i.from === ownerId && i.type === 'message' && roomSends[i.id]) return false;
      // a reply to something sent from a pair or group: it lives there too
      if (i.to === ownerId && i.ref && roomSends[i.ref]) return false;
      return true;
    });
  }
  const mine = new Set(
    Object.entries(roomSends)
      .filter(([, s]) => s.room === room.key)
      .map(([id]) => id),
  );
  let members = new Set<string>();
  if (room.kind === 'pair') members = new Set([room.a, room.b]);
  if (room.kind === 'group') members = new Set(room.group.members);
  // the owner's message went out once per agent: show it once
  const shownSends = new Set<string>();
  return items.filter((i) => {
    const from = same(i.from);
    if (room.kind === 'pair') {
      const to = same(i.to);
      const between = (from === room.a && to === room.b) || (from === room.b && to === room.a);
      if (between) return true;
    }
    if (i.from === ownerId && mine.has(i.id)) {
      const send = roomSends[i.id]?.send ?? i.id;
      if (shownSends.has(send)) return false;
      shownSends.add(send);
      return true;
    }
    // an agent answering something the owner sent here
    return i.to === ownerId && members.has(from) && !!i.ref && mine.has(i.ref);
  });
}

// ─── the sidebar list ────────────────────────────────────────────────────────

export interface RoomSummary {
  room: Room;
  title: string;
  /** agents shown as avatars */
  agents: AgentSummary[];
  last: LocalItem | undefined;
  /** requests in it waiting on the owner */
  waiting: number;
  at: number;
}

/** Every conversation, most recent first. */
export function useRoomList(): RoomSummary[] {
  const agents = useApp((s) => s.agents);
  const items = useApp((s) => s.items);
  const grants = useApp((s) => s.grants);
  const groups = useApp((s) => s.groups);
  const roomSends = useApp((s) => s.roomSends);
  const ownerId = useOwnerId();
  const pending = usePending();
  const same = useNewest();
  return useMemo(() => {
    const byId = new Map(agents.map((a) => [a.agentId, a]));
    const waitingFrom = new Map<string, number>();
    for (const r of pending.requests) waitingFrom.set(same(r.from), (waitingFrom.get(same(r.from)) ?? 0) + 1);
    const heldIn = new Map<string, number>();
    for (const h of pending.held) {
      const key = pairKey(same(h.from), same(h.to));
      heldIn.set(key, (heldIn.get(key) ?? 0) + 1);
    }

    const out: RoomSummary[] = [];
    const lastOf = (room: Room) => roomItems(room, items, ownerId, roomSends, same).at(-1);

    for (const a of agents) {
      // continued by a newer agent (its conversation lives there), or taken off the lists by the owner
      if (same(a.agentId) !== a.agentId || a.removedAt) continue;
      const room: Room = { kind: 'agent', key: agentKey(a.agentId), agentId: a.agentId };
      const last = lastOf(room);
      if (a.status !== 'active' && !last) continue;
      out.push({
        room,
        title: a.name,
        agents: [a],
        last,
        waiting: waitingFrom.get(a.agentId) ?? 0,
        at: last?.createdAt ?? 0,
      });
    }

    // pairs: any two agents that talked, or that the owner linked
    const pairs = new Set<string>();
    const addPair = (x: string, y: string) => {
      const a = same(x);
      const b = same(y);
      if (a !== b && byId.has(a) && byId.has(b)) pairs.add(pairId(a, b));
    };
    for (const i of items) addPair(i.from, i.to);
    for (const g of grants) if (!g.revoked && !g.expired) addPair(g.from, g.to);
    for (const s of Object.values(roomSends)) {
      const split = (s.room.startsWith('p:') && splitPair(s.room.slice(2))) || null;
      if (split) addPair(split[0], split[1]);
    }
    for (const id of pairs) {
      const split = splitPair(id);
      if (!split) continue;
      const a = byId.get(split[0]);
      const b = byId.get(split[1]);
      if (!a || !b) continue;
      const room: Room = { kind: 'pair', key: `p:${id}`, a: split[0], b: split[1] };
      const last = lastOf(room);
      out.push({
        room,
        title: `${a.name} ↔ ${b.name}`,
        agents: [a, b],
        last,
        waiting: heldIn.get(room.key) ?? 0,
        at: last?.createdAt ?? 0,
      });
    }

    for (const g of groups) {
      const room: Room = { kind: 'group', key: groupKey(g.id), group: g };
      const members = [...new Set(g.members.map(same))].map((m) => byId.get(m)).filter((m): m is AgentSummary => !!m);
      const last = lastOf(room);
      out.push({
        room,
        title: members.map((m) => m.name).join(', '),
        agents: members,
        last,
        waiting: 0,
        at: last?.createdAt ?? g.createdAt,
      });
    }

    return out.sort((x, y) => y.at - x.at);
  }, [agents, items, grants, groups, roomSends, ownerId, pending, same]);
}
