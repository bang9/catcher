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
  const ownerId = useOwnerId();
  const now = useNow();
  return useMemo(() => {
    // `now` re-runs this so expired requests drop out without a sync
    void now;
    const waiting = pendingForOwner(items, ownerId) as LocalItem[];
    const held = newestFirst(waiting.filter((i) => i.held));
    const requests = newestFirst(waiting.filter((i) => !i.held));
    return { requests, held, count: requests.length + held.length };
  }, [items, agents, ownerId, now]);
}

/** The owner's answer to a request, if there is one. */
export function answerFor(items: LocalItem[], requestId: string): LocalItem | undefined {
  return items.find((i) => i.type === 'answer' && i.ref === requestId);
}
