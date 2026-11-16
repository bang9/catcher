// App state in one small external store (useSyncExternalStore). Screens select fields; sync.ts writes them.

import { useSyncExternalStore } from 'react';
import type { OwnerClient } from '@catcher/client';
import type { AgentSummary, GrantPayload } from '@catcher/protocol';
import type { LocalItem } from '@/lib/db';

export type LiveState = 'off' | 'connecting' | 'live';

export interface GrantView extends GrantPayload {
  revoked: boolean;
  expired: boolean;
}

/**
 * A message typed in a conversation, shown right away while it is still on its way. One message can go to several
 * agents (a pair or a group conversation): the relay gets one envelope per agent, one after another.
 */
export interface OutMessage {
  /** local key until the relay accepts it */
  key: string;
  /** the conversation it was typed in (state/rooms.ts roomKey) */
  room: string;
  /** agents it goes to */
  targets: string[];
  /** envelope ids the relay accepted so far, in target order; dropped once all of them come back from a sync */
  ids: string[];
  text: string;
  createdAt: number;
  failed: string | null;
}

/** Where a sent envelope belongs: its conversation, and the one typed message it is a copy of. */
export interface RoomSend {
  room: string;
  /** the outbox key of the typed message (one per send, shared by its copies to each agent) */
  send: string;
}

/** A conversation with several agents at once, kept on this phone only (the relay has no groups). */
export interface Group {
  id: string;
  members: string[];
  createdAt: number;
}

export interface AppState {
  /** owner key loaded (or confirmed missing) */
  ready: boolean;
  owner: OwnerClient | null;
  /** finished onboarding (saved the recovery code) */
  onboarded: boolean;
  agents: AgentSummary[];
  senderSeq: Record<string, number>;
  grants: GrantView[];
  revokedAgents: string[];
  /** when the current owner key was issued — older envelopes were sealed to a previous key */
  ownerKeySince: number;
  /** every signing key in the verified owner chain (certs of old agents may carry an older one) */
  ownerSignKeys: string[];
  /** first feed cursor this install received live; seq gap checks start here */
  liveSince: number;
  items: LocalItem[];
  syncing: boolean;
  syncError: string | null;
  lastSyncAt: number | null;
  live: LiveState;
  /** a registration code that arrived by link, waiting until the owner can confirm it */
  heldEnrollCode: string | null;
  /** chat messages not yet back from a sync */
  outbox: OutMessage[];
  /** requests this phone just answered (id → what was answered), until the answer comes back from a sync */
  settled: Record<string, string>;
  groups: Group[];
  /** envelope id → the pair or group conversation it was sent from (1:1 messages need no entry) */
  roomSends: Record<string, RoomSend>;
}

let state: AppState = {
  ready: false,
  owner: null,
  onboarded: false,
  agents: [],
  senderSeq: {},
  grants: [],
  revokedAgents: [],
  ownerKeySince: 0,
  ownerSignKeys: [],
  liveSince: 0,
  items: [],
  syncing: false,
  syncError: null,
  lastSyncAt: null,
  live: 'off',
  heldEnrollCode: null,
  outbox: [],
  settled: {},
  groups: [],
  roomSends: {},
};

const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Select one stable value (a field or something derived from fields with stable identity). */
export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

/** The owner client for screens that only render after onboarding. */
export function requireOwner(): OwnerClient {
  if (!state.owner) throw new Error('no owner key on this phone');
  return state.owner;
}
