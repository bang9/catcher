// All agents grouped by state. "Connect" in the header is this screen's one action.

import { router, Stack } from 'expo-router';
import type { AgentSummary, AgentStatus } from '@catcher/protocol';
import { t } from '@/i18n';
import { isOnline } from '@/lib/format';
import { useNewest } from '@/state/rooms';
import { useNow } from '@/state/selectors';
import { useApp } from '@/state/store';
import { sync } from '@/state/sync';
import { colors } from '@/ui/colors';
import { Button, Dot, Empty, Group, Icon, IconButton, Row, Screen, SectionTitle } from '@/ui/kit';
import { providerLabel } from '@/ui/platforms';
import { presence } from './parts';
import { Avatar } from './sidebar';
import { SyncBanner } from './parts';

export function statusLabel(status: AgentStatus): string {
  return t(`status.${status}`);
}

function Section({ title, agents, now }: { title: string; agents: AgentSummary[]; now: number }) {
  if (!agents.length) return null;
  return (
    <>
      <SectionTitle>{title}</SectionTitle>
      <Group>
        {agents.map((a, i) => {
          let sub = `${providerLabel(a.provider)} · ${a.device}`;
          if (a.status === 'active') sub = `${sub} · ${presence(a, now)}`;
          const open = () => router.push({ pathname: '/agent/[agentId]', params: { agentId: a.agentId } });
          return (
            <Row
              key={a.agentId}
              first={i === 0}
              testID={`agent-row-${a.name}`}
              title={a.name}
              leading={<Avatar name={a.name} agent={a} size={40} surface={colors.card} />}
              subtitle={sub}
              accessory={(a.status === 'active' && <Dot on={isOnline(a.lastSeenAt, now)} />) || undefined}
              detail={(a.status !== 'active' && statusLabel(a.status)) || undefined}
              onPress={open}
            />
          );
        })}
      </Group>
    </>
  );
}

export function AgentsScreen() {
  const agents = useApp((s) => s.agents);
  const now = useNow(30_000);
  const same = useNewest();
  const active = agents.filter((a) => a.status === 'active');
  // a disconnected agent another one continues lives on in it; one the owner removed is gone from here
  const closed = agents.filter((a) => a.status === 'revoked' && !a.removedAt && same(a.agentId) === a.agentId);
  return (
    <Screen testID="agents" onRefresh={sync}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <IconButton testID="agents-add" label={t('agents.add')} onPress={() => router.push('/add-agent')}>
              <Icon ios="plus" android="add" />
            </IconButton>
          ),
        }}
      />
      <SyncBanner />
      {agents.length === 0 && (
        <Empty
          title={t('agents.empty')}
          body={t('agents.emptyBody')}
          action={<Button label={t('inbox.addAgent')} onPress={() => router.push('/add-agent')} />}
        />
      )}
      {active.length > 1 && (
        <Button testID="agents-link" kind="secondary" label={t('link.title')} onPress={() => router.push('/link')} />
      )}
      <Section title={t('agents.active')} agents={active} now={now} />
      <Section title={t('agents.closed')} agents={closed} now={now} />
    </Screen>
  );
}
