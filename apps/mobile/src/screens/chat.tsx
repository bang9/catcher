// The three kinds of conversation on one chat view (conversation.tsx): one agent, two agents talking to each other, and
// a group of agents.

import { useMemo } from 'react';
import { Pressable, View } from 'react-native';
import { Redirect, router, Stack, useLocalSearchParams } from 'expo-router';
import type { AgentSummary } from '@catcher/protocol';
import { t } from '@/i18n';
import { isOnline } from '@/lib/format';
import { agentKey, groupKey, pairKey, type Room, splitPair, useNewest } from '@/state/rooms';
import { useNow } from '@/state/selectors';
import { type GrantView, useApp } from '@/state/store';
import { colors } from '@/ui/colors';
import { Icon, IconButton } from '@/ui/kit';
import { Text } from '@/ui/text';
import { ChatTitle, ChatView, dismissKeyboard } from './conversation';
import { presence } from './parts';
import { Avatar, AvatarStack } from './sidebar';

function EmptyLines({ agents, text }: { agents: AgentSummary[]; text: string }) {
  return (
    <View style={{ alignItems: 'center', gap: 12 }}>
      <AvatarStack agents={agents} size={48} />
      <Text style={{ fontSize: 15, lineHeight: 22, textAlign: 'center', color: colors.secondaryLabel }}>{text}</Text>
    </View>
  );
}

function InfoButton({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <IconButton
      testID="chat-info"
      label={label}
      onPress={() => {
        dismissKeyboard();
        onPress();
      }}
    >
      <Icon ios="info.circle" android="info" />
    </IconButton>
  );
}

// ─── one agent ───────────────────────────────────────────────────────────────

export function ChatScreen() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const agent = useApp((s) => s.agents.find((a) => a.agentId === agentId));
  const now = useNow(30_000);
  const room = useMemo<Room>(() => ({ kind: 'agent', key: agentKey(agentId), agentId }), [agentId]);
  const targets = useMemo(() => [agentId], [agentId]);
  const openAgent = () => router.push({ pathname: '/agent/[agentId]', params: { agentId } });
  const name = agent?.name ?? '';
  let inactive: string | null = null;
  if (agent?.status !== 'active') inactive = t('chat.inactive');
  // an old agent that a newer one continues: its conversation is the newer one's
  const newest = useNewest()(agentId);
  if (newest !== agentId) return <Redirect href={{ pathname: '/chat/[agentId]', params: { agentId: newest } }} />;
  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () =>
            agent && (
              <ChatTitle
                title={name}
                sub={presence(agent, now)}
                dot={isOnline(agent.lastSeenAt, now)}
                onPress={openAgent}
              />
            ),
          headerRight: () => <InfoButton label={t('chat.info')} onPress={openAgent} />,
        }}
      />
      <ChatView
        room={room}
        targets={targets}
        placeholder={t('chat.placeholder')}
        inactive={inactive}
        empty={
          <View style={{ alignItems: 'center', gap: 10 }}>
            <Avatar name={name} agent={agent} size={48} />
            <Text style={{ fontSize: 18, lineHeight: 24, fontWeight: '600', color: colors.label }}>{name}</Text>
            <Text style={{ fontSize: 15, lineHeight: 22, textAlign: 'center', color: colors.secondaryLabel }}>
              {t('chat.emptyLede', { name })}
            </Text>
          </View>
        }
      />
    </>
  );
}

// ─── two agents ──────────────────────────────────────────────────────────────

/** The live message permissions between two agents, each way. */
export function linksBetween(grants: GrantView[], a: string, b: string) {
  const live = grants.filter((g) => !g.revoked && !g.expired && g.scopes.includes('message'));
  const ab = live.find((g) => g.from === a && g.to === b) ?? null;
  const ba = live.find((g) => g.from === b && g.to === a) ?? null;
  return { ab, ba };
}

export function PairScreen() {
  const { pairId } = useLocalSearchParams<{ pairId: string }>();
  const split = splitPair(pairId ?? '');
  const a = split?.[0] ?? '';
  const b = split?.[1] ?? '';
  const agents = useApp((s) => s.agents);
  const grants = useApp((s) => s.grants);
  const A = agents.find((x) => x.agentId === a);
  const B = agents.find((x) => x.agentId === b);
  const room = useMemo<Room>(() => ({ kind: 'pair', key: pairKey(a, b), a, b }), [a, b]);
  const targets = useMemo(
    () => [A, B].filter((x): x is AgentSummary => x?.status === 'active').map((x) => x.agentId),
    [A, B],
  );
  const { ab, ba } = linksBetween(grants, a, b);
  const nameA = A?.name ?? a;
  const nameB = B?.name ?? b;
  let sub = t('pair.none');
  if (ab && ba) sub = t('pair.both');
  else if (ab) sub = t('pair.oneWay', { from: nameA, to: nameB });
  else if (ba) sub = t('pair.oneWay', { from: nameB, to: nameA });
  if (ab?.requireApproval || ba?.requireApproval) sub = `${sub} · ${t('link.everyMessage')}`;
  const openLink = () => router.push({ pathname: '/link', params: { a, b } });

  let notice = null;
  if (!ab && !ba && A && B) {
    notice = (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          marginHorizontal: 16,
          marginVertical: 4,
          paddingLeft: 14,
          paddingRight: 6,
          paddingVertical: 6,
          borderRadius: 24,
          backgroundColor: colors.card,
        }}
      >
        <Text style={{ flex: 1, fontSize: 14, lineHeight: 20, color: colors.secondaryLabel }}>{t('pair.notice')}</Text>
        <Pressable
          testID="pair-link"
          accessibilityRole="button"
          onPress={openLink}
          style={({ pressed }) => ({
            height: 36,
            paddingHorizontal: 14,
            borderRadius: 18,
            justifyContent: 'center',
            backgroundColor: colors.ink,
            opacity: (pressed && 0.75) || 1,
          })}
        >
          <Text style={{ fontSize: 14, fontWeight: '600', color: colors.onInk }}>{t('pair.link')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => <ChatTitle title={`${nameA} ↔ ${nameB}`} sub={sub} onPress={openLink} />,
          headerRight: () => <InfoButton label={t('link.manage')} onPress={openLink} />,
        }}
      />
      <ChatView
        room={room}
        targets={targets}
        placeholder={t('pair.placeholder')}
        inactive={(targets.length === 0 && t('chat.inactive')) || null}
        notice={notice}
        empty={<EmptyLines agents={[A, B].filter((x): x is AgentSummary => !!x)} text={t('pair.empty')} />}
      />
    </>
  );
}

// ─── a group ─────────────────────────────────────────────────────────────────

export function GroupScreen() {
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const group = useApp((s) => s.groups.find((g) => g.id === groupId));
  const agents = useApp((s) => s.agents);
  const members = useMemo(
    () => (group?.members ?? []).map((m) => agents.find((a) => a.agentId === m)).filter((m): m is AgentSummary => !!m),
    [group, agents],
  );
  const room = useMemo<Room | null>(() => {
    if (!group) return null;
    return { kind: 'group', key: groupKey(group.id), group };
  }, [group]);
  const targets = useMemo(() => members.filter((m) => m.status === 'active').map((m) => m.agentId), [members]);
  if (!room) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
        <Text style={{ fontSize: 15, color: colors.secondaryLabel }}>{t('group.missing')}</Text>
      </View>
    );
  }
  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <ChatTitle title={members.map((m) => m.name).join(', ')} sub={t('group.sub', { count: members.length })} />
          ),
          headerRight: () => null,
        }}
      />
      <ChatView
        room={room}
        targets={targets}
        placeholder={t('group.placeholder', { count: targets.length })}
        inactive={(targets.length === 0 && t('chat.inactive')) || null}
        empty={<EmptyLines agents={members} text={t('group.empty')} />}
      />
    </>
  );
}
