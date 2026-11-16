// Home: what waits on the owner, the agents (tap one to talk), and the latest conversations. With no agent yet, the
// one thing to do — the line to send an agent so it connects. On Android, back here asks for a second press to leave.

import { useCallback, useRef, useState } from 'react';
import { BackHandler, Pressable, ToastAndroid, View } from 'react-native';
import { router, useFocusEffect, useNavigation } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import type { AgentSummary } from '@catcher/protocol';
import { t } from '@/i18n';
import { isOnline } from '@/lib/format';
import { SITE_URL } from '@/lib/site';
import { useRoomList } from '@/state/rooms';
import { useNow, useOwnerId, usePending } from '@/state/selectors';
import { useApp } from '@/state/store';
import { sync } from '@/state/sync';
import { colors } from '@/ui/colors';
import { Button, EDGE, Group, Icon, Lede, Pill, Row, Screen, SectionTitle, SIZE, tap, useBottomGap } from '@/ui/kit';
import { Text } from '@/ui/text';
import { kindKey, preview, SyncBanner } from './parts';
import { Avatar, AvatarStack, openRoom } from './sidebar';

export const AGENT_PROMPT = `Read ${SITE_URL}/agent.md and install catcher.`;

const EXIT_WINDOW_MS = 2000;

/**
 * Android back on home: the first press says "press again to exit", a second press within two seconds leaves. An open
 * sidebar closes first, as usual.
 */
function useBackTwiceToExit(): void {
  const navigation = useNavigation();
  const last = useRef(0);
  useFocusEffect(
    useCallback(() => {
      if (process.env.EXPO_OS !== 'android') return undefined;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        const state = navigation.getState();
        // the drawer's own handler closes an open sidebar
        const drawerOpen = state?.history?.some((h) => typeof h === 'object' && h !== null && 'status' in h);
        if (drawerOpen) return false;
        const now = Date.now();
        if (now - last.current < EXIT_WINDOW_MS) return false;
        last.current = now;
        ToastAndroid.show(t('home.backAgain'), ToastAndroid.SHORT);
        return true;
      });
      return () => sub.remove();
    }, [navigation]),
  );
}

function PromptCard() {
  const [copied, setCopied] = useState(false);
  return (
    <View style={{ borderRadius: 24, borderCurve: 'continuous', backgroundColor: colors.card, padding: 18, gap: 14 }}>
      <Text selectable testID="home-prompt" style={{ fontSize: 17, lineHeight: 25, color: colors.label }}>
        {AGENT_PROMPT}
      </Text>
      <Pressable
        testID="home-copy"
        accessibilityRole="button"
        onPress={() => {
          tap();
          void Clipboard.setStringAsync(AGENT_PROMPT).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        style={({ pressed }) => ({
          alignSelf: 'flex-end',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          height: SIZE.md,
          paddingHorizontal: 16,
          borderRadius: SIZE.md / 2,
          backgroundColor: colors.ink,
          opacity: (pressed && 0.75) || 1,
        })}
      >
        <Icon
          ios={(copied && 'checkmark') || 'doc.on.doc'}
          android={(copied && 'check') || 'content_copy'}
          size={16}
          color={colors.onInk}
        />
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.onInk }}>
          {(copied && t('common.copied')) || t('common.copy')}
        </Text>
      </Pressable>
    </View>
  );
}

/** No agent yet: the line to send one. */
function FirstAgent() {
  const bottom = useBottomGap();
  return (
    <View
      testID="home"
      style={{ flex: 1, backgroundColor: colors.background, paddingHorizontal: EDGE, paddingBottom: bottom, gap: 16 }}
    >
      <SyncBanner />
      {/* optical center: a little above the middle, the way the eye expects a centered block to sit */}
      <View style={{ flex: 1, justifyContent: 'center', gap: 20, paddingBottom: 56 }}>
        <View style={{ gap: 10 }}>
          <Text style={{ fontSize: 28, lineHeight: 36, fontWeight: '700', letterSpacing: -0.8, color: colors.label }}>
            {t('home.title')}
          </Text>
          <Lede>{t('home.lede')}</Lede>
        </View>
        <PromptCard />
      </View>
      <Button
        testID="inbox-add-agent"
        kind="plain"
        label={t('home.haveCode')}
        onPress={() => router.push('/add-agent')}
      />
    </View>
  );
}

const TILE = 76;

function AgentTile({ agent, now }: { agent: AgentSummary; now: number }) {
  return (
    <Pressable
      testID={`home-agent-${agent.name}`}
      accessibilityRole="button"
      accessibilityLabel={agent.name}
      onPress={() => {
        tap();
        router.navigate({ pathname: '/chat/[agentId]', params: { agentId: agent.agentId } });
      }}
      style={({ pressed }) => ({ width: TILE, alignItems: 'center', gap: 6, opacity: (pressed && 0.6) || 1 })}
    >
      <Avatar name={agent.name} agent={agent} size={56} online={isOnline(agent.lastSeenAt, now)} />
      <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, fontWeight: '500', color: colors.label }}>
        {agent.name}
      </Text>
    </Pressable>
  );
}

function AddTile() {
  return (
    <Pressable
      testID="home-add-agent"
      accessibilityRole="button"
      accessibilityLabel={t('nav.addAgent')}
      onPress={() => {
        tap();
        router.push('/add-agent');
      }}
      style={({ pressed }) => ({ width: TILE, alignItems: 'center', gap: 6, opacity: (pressed && 0.6) || 1 })}
    >
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1,
          borderStyle: 'dashed',
          borderColor: colors.separator,
        }}
      >
        <Icon ios="plus" android="add" size={22} color={colors.secondaryLabel} />
      </View>
      <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: colors.secondaryLabel }}>
        {t('agents.add')}
      </Text>
    </Pressable>
  );
}

const SHOW_REQUESTS = 3;
const SHOW_ROOMS = 5;

export function HomeScreen() {
  useBackTwiceToExit();
  const rooms = useRoomList();
  const agents = useApp((s) => s.agents);
  const pending = usePending();
  const ownerId = useOwnerId();
  const now = useNow(30_000);
  const active = agents.filter((a) => a.status === 'active' && !a.removedAt);
  if (active.length === 0 && rooms.length === 0) return <FirstAgent />;

  const byId = new Map(agents.map((a) => [a.agentId, a]));
  const names = (id: string) => {
    if (id === ownerId) return 'owner';
    return byId.get(id)?.name ?? id;
  };
  // agents in the order of their latest conversation, the quiet ones after
  const order = new Map<string, number>();
  for (const [i, r] of rooms.entries()) if (r.room.kind === 'agent') order.set(r.room.agentId, i);
  const tiles = [...active].sort((x, y) => (order.get(x.agentId) ?? 1e9) - (order.get(y.agentId) ?? 1e9));
  const requests = pending.requests.slice(0, SHOW_REQUESTS);
  const recent = rooms.filter((r) => r.last).slice(0, SHOW_ROOMS);

  return (
    <Screen testID="home" onRefresh={sync}>
      <SyncBanner />
      {pending.count > 0 && (
        <>
          <SectionTitle>{t('home.waiting', { count: pending.count })}</SectionTitle>
          <Group>
            {requests.map((item, i) => {
              let tone: 'info' | 'danger' = 'info';
              if (!item.verified) tone = 'danger';
              return (
                <Row
                  key={item.id}
                  first={i === 0}
                  testID={`home-request-${item.type}`}
                  leading={<Avatar name={item.fromName} agent={byId.get(item.from)} size={36} />}
                  title={item.fromName}
                  subtitle={preview(item, names)}
                  accessory={<Pill label={t(kindKey(item))} tone={tone} />}
                  onPress={() => router.push({ pathname: '/request/[id]', params: { id: item.id } })}
                />
              );
            })}
            {pending.count > requests.length && (
              <Row
                testID="home-all-requests"
                title={t('home.allRequests', { count: pending.count })}
                onPress={() => router.navigate('/inbox')}
              />
            )}
          </Group>
        </>
      )}

      <SectionTitle>{t('home.agents')}</SectionTitle>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: 16, columnGap: 8, paddingTop: 4 }}>
        {tiles.map((a) => (
          <AgentTile key={a.agentId} agent={a} now={now} />
        ))}
        <AddTile />
      </View>

      {recent.length > 0 && (
        <>
          <SectionTitle>{t('home.recent')}</SectionTitle>
          <Group>
            {recent.map((r, i) => {
              let sub = '';
              if (r.last) {
                sub = preview(r.last, names);
                if (r.room.kind !== 'agent') sub = `${r.last.fromName}: ${sub}`;
              }
              let badge = null;
              if (r.waiting > 0) badge = <Pill label={String(r.waiting)} tone="info" />;
              return (
                <Row
                  key={r.room.key}
                  first={i === 0}
                  testID={`home-room-${r.title}`}
                  leading={<AvatarStack agents={r.agents} size={36} now={now} surface={colors.card} />}
                  title={r.title}
                  subtitle={sub}
                  accessory={badge}
                  onPress={() => openRoom(r.room)}
                />
              );
            })}
          </Group>
        </>
      )}
    </Screen>
  );
}
