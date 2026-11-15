// Everything waiting on the owner: requests from agents and held agent → agent messages.
// Each row opens a screen with the one decision to make.

import { router } from 'expo-router';
import { t } from '@/i18n';
import { remaining } from '@/lib/format';
import type { LocalItem } from '@/lib/db';
import { usePending } from '@/state/selectors';
import { useApp } from '@/state/store';
import { sync } from '@/state/sync';
import { Button, Empty, Group, Pill, Row, Screen, SectionTitle } from '@/ui/kit';
import { kindKey, preview, SyncBanner } from './parts';

function subtitle(item: LocalItem, names: (id: string) => string): string {
  const parts = [preview(item, names)];
  if (item.expiresAt) parts.push(t('inbox.expiresIn', { time: remaining(item.expiresAt - Date.now()) }));
  return parts.filter(Boolean).join(' · ');
}

function ItemRows({ items, names }: { items: LocalItem[]; names: (id: string) => string }) {
  return (
    <Group>
      {items.map((item, i) => {
        let title = item.fromName;
        if (item.held) title = `${item.fromName} → ${item.toName}`;
        let tone: 'info' | 'danger' = 'info';
        if (!item.verified) tone = 'danger';
        return (
          <Row
            key={item.id}
            first={i === 0}
            testID={`inbox-item-${item.type}`}
            title={title}
            subtitle={subtitle(item, names)}
            accessory={<Pill label={t(kindKey(item))} tone={tone} />}
            onPress={() => router.push({ pathname: '/request/[id]', params: { id: item.id } })}
          />
        );
      })}
    </Group>
  );
}

export function InboxScreen() {
  const pending = usePending();
  const agents = useApp((s) => s.agents);
  const ownerId = useApp((s) => s.owner?.state.ownerId);
  const byId = new Map(agents.map((a) => [a.agentId, a.name]));
  const names = (id: string) => {
    if (id === ownerId) return 'owner';
    return byId.get(id) ?? id;
  };

  const hasAgents = agents.some((a) => a.status === 'active');
  let empty = null;
  if (pending.count === 0 && hasAgents) empty = <Empty title={t('inbox.emptyTitle')} body={t('inbox.emptyBody')} />;
  if (pending.count === 0 && !hasAgents) {
    empty = (
      <Empty
        title={t('inbox.emptyTitle')}
        body={t('inbox.emptyNoAgents')}
        action={
          <Button testID="inbox-add-agent" label={t('inbox.addAgent')} onPress={() => router.push('/add-agent')} />
        }
      />
    );
  }

  return (
    <Screen testID="inbox" onRefresh={sync}>
      <SyncBanner />
      {pending.requests.length > 0 && (
        <>
          <SectionTitle>{t('inbox.requests')}</SectionTitle>
          <ItemRows items={pending.requests} names={names} />
        </>
      )}
      {pending.held.length > 0 && (
        <>
          <SectionTitle>{t('inbox.held')}</SectionTitle>
          <ItemRows items={pending.held} names={names} />
        </>
      )}
      {empty}
    </Screen>
  );
}
