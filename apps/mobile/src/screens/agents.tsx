// All agents grouped by state. "Connect" in the header is this screen's one action.

import { Pressable, Text } from 'react-native';
import { router, Stack } from 'expo-router';
import type { AgentSummary, AgentStatus } from '@catcher/protocol';
import { t } from '@/i18n';
import { isOnline } from '@/lib/format';
import { useNow } from '@/state/selectors';
import { useApp } from '@/state/store';
import { sync } from '@/state/sync';
import { colors } from '@/ui/colors';
import { Button, Dot, Empty, Group, Row, Screen, SectionTitle } from '@/ui/kit';
import { presence } from './chats';
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
          let sub = `${a.provider} · ${a.device}`;
          if (a.status === 'active') sub = `${sub} · ${presence(a, now)}`;
          const open = () => router.push({ pathname: '/agent/[agentId]', params: { agentId: a.agentId } });
          return (
            <Row
              key={a.agentId}
              first={i === 0}
              testID={`agent-row-${a.name}`}
              title={a.name}
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
  const active = agents.filter((a) => a.status === 'active');
  const closed = agents.filter((a) => a.status === 'revoked');
  return (
    <Screen testID="agents" onRefresh={sync}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              testID="agents-add"
              accessibilityRole="button"
              hitSlop={12}
              onPress={() => router.push('/add-agent')}
            >
              <Text style={{ color: colors.accent, fontSize: 17 }}>{t('agents.add')}</Text>
            </Pressable>
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
      <Section title={t('agents.active')} agents={active} now={now} />
      <Section title={t('agents.closed')} agents={closed} now={now} />
    </Screen>
  );
}
