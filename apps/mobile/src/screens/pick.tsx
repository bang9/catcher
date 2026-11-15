// Picking agents: start a conversation (one agent → a 1:1 chat, two → the two of them, more → a group), or pass a
// message on to other agents (one copy each, in each 1:1 chat).

import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { AgentSummary } from '@catcher/protocol';
import { t } from '@/i18n';
import { isOnline } from '@/lib/format';
import { agentKey, openGroup, pairId, sendToRoom } from '@/state/rooms';
import { useNow } from '@/state/selectors';
import { useApp } from '@/state/store';
import { colors } from '@/ui/colors';
import { Button, Icon, Lede, Screen, tap } from '@/ui/kit';
import { Text } from '@/ui/text';
import { presence } from './parts';
import { Avatar } from './sidebar';

/** A check circle on the right of a row: filled ink when picked. */
function Check({ on }: { on: boolean }) {
  let border = 1.5;
  if (on) border = 0;
  return (
    <View
      style={{
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: border,
        borderColor: colors.tertiaryLabel,
        backgroundColor: (on && colors.ink) || undefined,
      }}
    >
      {on && <Icon ios="checkmark" android="check" size={15} color={colors.onInk} />}
    </View>
  );
}

export function AgentPicker({
  agents,
  picked,
  onToggle,
}: {
  agents: AgentSummary[];
  picked: string[];
  onToggle: (agentId: string) => void;
}) {
  const now = useNow(30_000);
  return (
    <View style={{ marginHorizontal: -6 }}>
      {agents.map((a) => {
        const on = picked.includes(a.agentId);
        return (
          <Pressable
            key={a.agentId}
            testID={`pick-${a.name}`}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            onPress={() => {
              tap();
              onToggle(a.agentId);
            }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              minHeight: 60,
              paddingHorizontal: 6,
              paddingVertical: 8,
              borderRadius: 14,
              borderCurve: 'continuous',
              backgroundColor: (pressed && colors.fill) || undefined,
            })}
          >
            <Avatar name={a.name} size={40} online={isOnline(a.lastSeenAt, now)} />
            <View style={{ flex: 1, gap: 1 }}>
              <Text numberOfLines={1} style={{ fontSize: 16, lineHeight: 22, fontWeight: '500', color: colors.label }}>
                {a.name}
              </Text>
              <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: colors.secondaryLabel }}>
                {`${a.provider} · ${presence(a, now)}`}
              </Text>
            </View>
            <Check on={on} />
          </Pressable>
        );
      })}
    </View>
  );
}

function useActiveAgents(): AgentSummary[] {
  const agents = useApp((s) => s.agents);
  return agents.filter((a) => a.status === 'active');
}

function toggle(list: string[], id: string): string[] {
  if (list.includes(id)) return list.filter((x) => x !== id);
  return [...list, id];
}

export function NewChatScreen() {
  const agents = useActiveAgents();
  const [picked, setPicked] = useState<string[]>([]);

  const start = () => {
    router.back();
    if (picked.length === 1) {
      router.navigate({ pathname: '/chat/[agentId]', params: { agentId: picked[0]! } });
      return;
    }
    if (picked.length === 2) {
      router.navigate({ pathname: '/pair/[pairId]', params: { pairId: pairId(picked[0]!, picked[1]!) } });
      return;
    }
    const group = openGroup(picked);
    router.navigate({ pathname: '/group/[groupId]', params: { groupId: group.id } });
  };

  let label = t('new.start');
  if (picked.length > 1) label = t('new.startCount', { count: picked.length });
  return (
    <Screen
      testID="new-chat"
      footer={<Button testID="new-start" label={label} disabled={picked.length === 0} onPress={start} />}
    >
      <Lede>{t('new.lede')}</Lede>
      <Pressable
        testID="new-connect"
        accessibilityRole="button"
        onPress={() => {
          router.back();
          router.push('/add-agent');
        }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          minHeight: 56,
          marginHorizontal: -6,
          paddingHorizontal: 6,
          borderRadius: 14,
          backgroundColor: (pressed && colors.fill) || undefined,
        })}
      >
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: colors.ink,
          }}
        >
          <Icon ios="plus" android="add" size={20} color={colors.onInk} />
        </View>
        <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: '500', color: colors.label }}>{t('new.connect')}</Text>
      </Pressable>
      <AgentPicker agents={agents} picked={picked} onToggle={(id) => setPicked((p) => toggle(p, id))} />
    </Screen>
  );
}

export function ForwardScreen() {
  const { text, from } = useLocalSearchParams<{ text: string; from?: string }>();
  const agents = useActiveAgents();
  const [picked, setPicked] = useState<string[]>([]);
  // an agent's words go on marked as quoted: agents give the owner's messages the owner's authority, so passed-on
  // text must not read as an instruction from the owner. The owner's own words go as they are.
  let body = text ?? '';
  if (from) body = `${t('forward.quote', { name: from })}\n\n${body}`;

  const send = () => {
    // one copy each, in each agent's own conversation
    for (const id of picked) sendToRoom(agentKey(id), [id], body);
    router.back();
  };

  let label = t('chat.send');
  if (picked.length > 0) label = t('forward.send', { count: picked.length });
  return (
    <Screen
      testID="forward"
      footer={<Button testID="forward-send" label={label} disabled={picked.length === 0 || !body} onPress={send} />}
    >
      <View style={{ borderRadius: 18, borderCurve: 'continuous', backgroundColor: colors.card, padding: 14 }}>
        <Text numberOfLines={6} style={{ fontSize: 15, lineHeight: 22, color: colors.label }}>
          {body}
        </Text>
      </View>
      <Text style={{ fontSize: 13, lineHeight: 18, fontWeight: '500', color: colors.tertiaryLabel, marginBottom: -12 }}>
        {t('forward.pick')}
      </Text>
      <AgentPicker agents={agents} picked={picked} onToggle={(id) => setPicked((p) => toggle(p, id))} />
    </Screen>
  );
}
