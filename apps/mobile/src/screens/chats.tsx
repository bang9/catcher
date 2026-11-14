// Agents to talk to, most recent conversation first, with a connected dot from lastSeenAt.

import { useMemo } from 'react';
import { router } from 'expo-router';
import type { AgentSummary } from '@catcher/protocol';
import { t } from '@/i18n';
import type { LocalItem } from '@/lib/db';
import { ago, isOnline } from '@/lib/format';
import { useNow, useOwnerId } from '@/state/selectors';
import { useApp } from '@/state/store';
import { sync } from '@/state/sync';
import { Button, Dot, Empty, Group, Row, Screen } from '@/ui/kit';
import { preview, SyncBanner } from './parts';

/** Owner ↔ agent items only (agent ↔ agent traffic lives in Activity). */
export function isThreadItem(item: LocalItem, ownerId: string, agentId: string): boolean {
  return (item.from === ownerId && item.to === agentId) || (item.from === agentId && item.to === ownerId);
}

export function presence(agent: AgentSummary, now: number): string {
  if (isOnline(agent.lastSeenAt, now)) return t('presence.online');
  if (agent.lastSeenAt === null) return t('presence.never');
  return t('presence.seen', { time: ago(agent.lastSeenAt, now) });
}

export function ChatsScreen() {
  const agents = useApp((s) => s.agents);
  const items = useApp((s) => s.items);
  const ownerId = useOwnerId();
  const now = useNow(30_000);

  const rows = useMemo(() => {
    const last = new Map<string, LocalItem>();
    for (const i of items) {
      if (i.from === ownerId) last.set(i.to, i);
      else if (i.to === ownerId) last.set(i.from, i);
    }
    return agents
      .filter((a) => a.status === 'active' || last.has(a.agentId))
      .map((a) => ({ agent: a, last: last.get(a.agentId) }))
      .sort((x, y) => (y.last?.cursor ?? 0) - (x.last?.cursor ?? 0));
  }, [agents, items, ownerId]);

  const names = (id: string) => agents.find((a) => a.agentId === id)?.name ?? id;

  return (
    <Screen testID="chats" onRefresh={sync}>
      <SyncBanner />
      {rows.length === 0 && (
        <Empty
          title={t('chats.empty')}
          body={t('chats.emptyBody')}
          action={<Button label={t('inbox.addAgent')} onPress={() => router.push('/add-agent')} />}
        />
      )}
      {rows.length > 0 && (
        <Group>
          {rows.map(({ agent, last }, i) => {
            let subtitle = presence(agent, now);
            if (last) subtitle = preview(last, names);
            return (
              <Row
                key={agent.agentId}
                first={i === 0}
                testID={`chat-row-${agent.name}`}
                title={agent.name}
                subtitle={subtitle}
                accessory={<Dot on={isOnline(agent.lastSeenAt, now)} />}
                onPress={() => router.push({ pathname: '/chat/[agentId]', params: { agentId: agent.agentId } })}
              />
            );
          })}
        </Group>
      )}
    </Screen>
  );
}
