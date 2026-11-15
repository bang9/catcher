// Derived views over the store, memoized per render.

import { useEffect, useMemo, useState } from 'react';
import { pendingForOwner } from '@catcher/client';
import type { AgentSummary } from '@catcher/protocol';
import type { LocalItem } from '@/lib/db';
import { newestFirst } from '@/lib/format';
import { useApp } from './store';

export function useOwnerId(): string {
  return useApp((s) => s.owner?.state.ownerId ?? '');
}

/** Re-render every `ms` (expiry labels, countdowns, "seen 3 min ago"). */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function useAgentMap(): Map<string, AgentSummary> {
  const agents = useApp((s) => s.agents);
  return useMemo(() => new Map(agents.map((a) => [a.agentId, a])), [agents]);
}

export interface Pending {
  requests: LocalItem[];
  held: LocalItem[];
  count: number;
}

export function usePending(): Pending {
  const items = useApp((s) => s.items);
  const agents = useApp((s) => s.agents);
  const settled = useApp((s) => s.settled);
  const ownerId = useOwnerId();
  const now = useNow();
  return useMemo(() => {
    // `now` re-runs this so expired requests drop out without a sync
    void now;
    // answered on this phone a moment ago: gone from the list before the sync confirms it
    const waiting = (pendingForOwner(items, ownerId) as LocalItem[]).filter((i) => !(i.id in settled));
    const held = newestFirst(waiting.filter((i) => i.held));
    const requests = newestFirst(waiting.filter((i) => !i.held));
    return { requests, held, count: requests.length + held.length };
  }, [items, agents, settled, ownerId, now]);
}

/** The owner's answer to a request, if there is one. */
export function answerFor(items: LocalItem[], requestId: string): LocalItem | undefined {
  return items.find((i) => i.type === 'answer' && i.ref === requestId);
}

export interface Thread {
  agent: AgentSummary;
  last: LocalItem | undefined;
  /** requests from this agent waiting on the owner */
  waiting: number;
}

/** One conversation per agent, most recent first: the sidebar and the home screen read this. */
export function useThreads(): Thread[] {
  const agents = useApp((s) => s.agents);
  const items = useApp((s) => s.items);
  const ownerId = useOwnerId();
  const pending = usePending();
  return useMemo(() => {
    const last = new Map<string, LocalItem>();
    for (const i of items) {
      if (i.from === ownerId) last.set(i.to, i);
      else if (i.to === ownerId) last.set(i.from, i);
    }
    const waiting = new Map<string, number>();
    for (const r of pending.requests) waiting.set(r.from, (waiting.get(r.from) ?? 0) + 1);
    return agents
      .filter((a) => a.status === 'active' || last.has(a.agentId))
      .map((a) => ({ agent: a, last: last.get(a.agentId), waiting: waiting.get(a.agentId) ?? 0 }))
      .sort((x, y) => (y.last?.cursor ?? 0) - (x.last?.cursor ?? 0));
  }, [agents, items, ownerId, pending]);
}
