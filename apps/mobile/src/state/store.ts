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
  /** first feed cursor this install received live; seq gap checks start here */
  liveSince: number;
  items: LocalItem[];
  syncing: boolean;
  syncError: string | null;
  lastSyncAt: number | null;
  live: LiveState;
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
  liveSince: 0,
  items: [],
  syncing: false,
  syncError: null,
  lastSyncAt: null,
  live: 'off',
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
