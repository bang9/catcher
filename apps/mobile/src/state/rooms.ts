// Conversations. Three kinds, all shown with the same chat screen:
//   agent  — the owner and one agent (a:<agentId>)
//   pair   — two agents talking to each other, which the owner reads and can join (p:<agentId>~<agentId>, ids sorted)
//   group  — the owner and several agents at once, kept on this phone only (g:<groupId>)
// A message typed in a pair or group goes to every agent in it, one envelope each, and is remembered locally
// (roomSends) so it shows in that conversation; agents' replies point back to it (ref) and show there too.

import { useMemo } from 'react';
import type { AgentSummary } from '@catcher/protocol';
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
): LocalItem[] {
  if (room.kind === 'agent') {
    const id = room.agentId;
    return items.filter((i) => {
      const direct = (i.from === ownerId && i.to === id) || (i.from === id && i.to === ownerId);
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
    if (room.kind === 'pair') {
      const between = (i.from === room.a && i.to === room.b) || (i.from === room.b && i.to === room.a);
      if (between) return true;
    }
    if (i.from === ownerId && mine.has(i.id)) {
      const send = roomSends[i.id]?.send ?? i.id;
      if (shownSends.has(send)) return false;
      shownSends.add(send);
      return true;
    }
    // an agent answering something the owner sent here
    return i.to === ownerId && members.has(i.from) && !!i.ref && mine.has(i.ref);
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
  return useMemo(() => {
    const byId = new Map(agents.map((a) => [a.agentId, a]));
    const waitingFrom = new Map<string, number>();
    for (const r of pending.requests) waitingFrom.set(r.from, (waitingFrom.get(r.from) ?? 0) + 1);
    const heldIn = new Map<string, number>();
    for (const h of pending.held) heldIn.set(pairKey(h.from, h.to), (heldIn.get(pairKey(h.from, h.to)) ?? 0) + 1);

    const out: RoomSummary[] = [];
    const lastOf = (room: Room) => roomItems(room, items, ownerId, roomSends).at(-1);

    for (const a of agents) {
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
    for (const i of items) if (byId.has(i.from) && byId.has(i.to)) pairs.add(pairId(i.from, i.to));
    for (const g of grants)
      if (!g.revoked && !g.expired && byId.has(g.from) && byId.has(g.to)) pairs.add(pairId(g.from, g.to));
    for (const s of Object.values(roomSends)) if (s.room.startsWith('p:')) pairs.add(s.room.slice(2));
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
      const members = g.members.map((m) => byId.get(m)).filter((m): m is AgentSummary => !!m);
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
  }, [agents, items, grants, groups, roomSends, ownerId, pending]);
}
