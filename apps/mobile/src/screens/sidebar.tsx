// The sidebar: what waits on the owner and the activity log on top, then every conversation (one agent, two agents
// talking, a group), most recent first; agents and settings at the bottom. ✎ starts a new conversation.

import type { ReactNode } from 'react';
import { type ColorValue, Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import type { DrawerContentComponentProps } from 'expo-router/drawer';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AgentSummary } from '@catcher/protocol';
import { t } from '@/i18n';
import { isOnline } from '@/lib/format';
import { type RoomSummary, useRoomList } from '@/state/rooms';
import { useNow, useOwnerId, usePending } from '@/state/selectors';
import { useApp } from '@/state/store';
import { colors } from '@/ui/colors';
import { EDGE, GLYPH, HIT, Icon, IconButton, tap } from '@/ui/kit';
import { Text } from '@/ui/text';
import { preview } from './parts';

/** Which drawer screen and conversation is showing. */
function current(state: DrawerContentComponentProps['state']): { name: string; id?: string } {
  const route = state.routes[state.index];
  const params = (route?.params ?? {}) as { agentId?: string; pairId?: string; groupId?: string };
  return { name: route?.name ?? '', id: params.agentId ?? params.pairId ?? params.groupId };
}

function Item({
  selected,
  onPress,
  children,
  testID,
}: {
  selected: boolean;
  onPress: () => void;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 44,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 12,
        borderCurve: 'continuous',
        backgroundColor: ((selected || pressed) && colors.fill) || undefined,
      })}
    >
      {children}
    </Pressable>
  );
}

function Count({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <View
      style={{
        minWidth: 20,
        height: 20,
        paddingHorizontal: 6,
        borderRadius: 10,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.accent,
      }}
    >
      <Text style={{ fontSize: 12, fontWeight: '600', color: colors.onAccent }}>{String(n)}</Text>
    </View>
  );
}

/** A round initial for an agent, with a green dot while it is connected. */
export function Avatar({
  name,
  online,
  size = 32,
  ring,
  surface = colors.background,
}: {
  name: string;
  online?: boolean;
  size?: number;
  /** outline in the surface color, so stacked avatars read as separate */
  ring?: boolean;
  /** what the avatar sits on: rings and the online dot's border are cut out in this color */
  surface?: ColorValue;
}) {
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.card,
          borderWidth: (ring && 2) || 1,
          borderColor: (ring && surface) || colors.separator,
        }}
      >
        <Text style={{ fontSize: size * 0.42, fontWeight: '600', color: colors.label }}>
          {(name.trim()[0] ?? '?').toUpperCase()}
        </Text>
      </View>
      {online && (
        <View
          style={{
            position: 'absolute',
            right: -1,
            bottom: -1,
            width: 11,
            height: 11,
            borderRadius: 6,
            borderWidth: 2,
            borderColor: surface,
            backgroundColor: colors.success,
          }}
        />
      )}
    </View>
  );
}

/** One avatar for one agent; two or more overlap in the same square, so every row's text starts on the same line. */
export function AvatarStack({
  agents,
  size = 32,
  now,
  surface = colors.background,
}: {
  agents: AgentSummary[];
  size?: number;
  now?: number;
  surface?: ColorValue;
}) {
  if (agents.length <= 1) {
    const a = agents[0];
    return (
      <Avatar
        name={a?.name ?? '?'}
        size={size}
        online={!!a && now !== undefined && isOnline(a.lastSeenAt, now)}
        surface={surface}
      />
    );
  }
  const small = Math.round(size * 0.72);
  const extra = agents.length - 2;
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ position: 'absolute', left: 0, top: 0 }}>
        <Avatar name={agents[0]?.name ?? '?'} size={small} ring surface={surface} />
      </View>
      <View style={{ position: 'absolute', right: 0, bottom: 0 }}>
        {extra <= 0 && <Avatar name={agents[1]?.name ?? '?'} size={small} ring surface={surface} />}
        {extra > 0 && (
          <View
            style={{
              width: small,
              height: small,
              borderRadius: small / 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.fill,
              borderWidth: 2,
              borderColor: surface,
            }}
          >
            <Text style={{ fontSize: small * 0.4, fontWeight: '600', color: colors.label }}>{`+${extra + 1}`}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

function RoomRow({
  room,
  selected,
  now,
  names,
  onPress,
}: {
  room: RoomSummary;
  selected: boolean;
  now: number;
  names: (id: string) => string;
  onPress: () => void;
}) {
  let sub = '';
  if (room.last) {
    sub = preview(room.last, names);
    if (room.room.kind !== 'agent') sub = `${room.last.fromName}: ${sub}`;
  }
  return (
    <Item selected={selected} onPress={onPress} testID={`room-${room.title}`}>
      <AvatarStack agents={room.agents} now={now} surface={colors.sidebar} />
      <View style={{ flex: 1, gap: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 20, fontWeight: '500', color: colors.label }}>
          {room.title}
        </Text>
        {sub !== '' && (
          <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: colors.secondaryLabel }}>
            {sub}
          </Text>
        )}
      </View>
      <Count n={room.waiting} />
    </Item>
  );
}

export function openRoom(room: RoomSummary['room']): void {
  if (room.kind === 'agent') router.navigate({ pathname: '/chat/[agentId]', params: { agentId: room.agentId } });
  if (room.kind === 'pair') router.navigate({ pathname: '/pair/[pairId]', params: { pairId: room.key.slice(2) } });
  if (room.kind === 'group') router.navigate({ pathname: '/group/[groupId]', params: { groupId: room.group.id } });
}

function isHere(room: RoomSummary, here: { name: string; id?: string }): boolean {
  const r = room.room;
  if (r.kind === 'agent') return here.name === 'chat/[agentId]' && here.id === r.agentId;
  if (r.kind === 'pair') return here.name === 'pair/[pairId]' && here.id === r.key.slice(2);
  return here.name === 'group/[groupId]' && here.id === r.group.id;
}

export function Sidebar(props: DrawerContentComponentProps) {
  const insets = useSafeAreaInsets();
  const rooms = useRoomList();
  const pending = usePending();
  const agents = useApp((s) => s.agents);
  const ownerId = useOwnerId();
  const now = useNow(30_000);
  const here = current(props.state);
  const names = (id: string) => {
    if (id === ownerId) return 'owner';
    return agents.find((a) => a.agentId === id)?.name ?? id;
  };

  const go = (fn: () => void) => {
    props.navigation.closeDrawer();
    fn();
  };
  const label = { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '500' as const, color: colors.label };
  // rows are inset 10 inside a 6 gutter: icons and text start on the 16 edge
  const gutter = EDGE - 10;

  return (
    <View style={{ flex: 1, backgroundColor: colors.sidebar, paddingTop: insets.top }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: EDGE,
          paddingRight: EDGE - (HIT - GLYPH) / 2,
          height: 56,
        }}
      >
        <Text style={{ fontSize: 22, fontWeight: '700', letterSpacing: -0.8, color: colors.label }}>catcher</Text>
        <IconButton testID="sidebar-new" label={t('new.title')} onPress={() => go(() => router.push('/new-chat'))}>
          <Icon ios="square.and.pencil" android="edit_square" />
        </IconButton>
      </View>

      <ScrollView contentContainerStyle={{ paddingHorizontal: gutter, paddingBottom: 16 }}>
        <Item testID="nav-inbox" selected={here.name === 'inbox'} onPress={() => go(() => router.navigate('/inbox'))}>
          <Icon ios="tray" android="inbox" size={20} />
          <Text style={label}>{t('inbox.title')}</Text>
          <Count n={pending.count} />
        </Item>
        <Item
          testID="nav-activity"
          selected={here.name === 'activity'}
          onPress={() => go(() => router.navigate('/activity'))}
        >
          <Icon ios="clock" android="history" size={20} />
          <Text style={label}>{t('activity.title')}</Text>
        </Item>

        <Text
          style={{
            fontSize: 13,
            lineHeight: 18,
            fontWeight: '500',
            color: colors.tertiaryLabel,
            marginTop: 22,
            marginBottom: 6,
            paddingHorizontal: 10,
          }}
        >
          {t('sidebar.chats')}
        </Text>
        {rooms.length === 0 && (
          <Text style={{ fontSize: 14, lineHeight: 20, color: colors.secondaryLabel, paddingHorizontal: 10 }}>
            {t('sidebar.noAgents')}
          </Text>
        )}
        {rooms.map((room) => (
          <RoomRow
            key={room.room.key}
            room={room}
            now={now}
            names={names}
            selected={isHere(room, here)}
            onPress={() => go(() => openRoom(room.room))}
          />
        ))}
      </ScrollView>

      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: colors.separator,
          paddingHorizontal: gutter,
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 12),
        }}
      >
        <Item
          testID="nav-agents"
          selected={here.name === 'agents'}
          onPress={() => go(() => router.navigate('/agents'))}
        >
          <Icon ios="cpu" android="smart_toy" size={20} />
          <Text style={label}>{t('agents.title')}</Text>
        </Item>
        <Item
          testID="nav-settings"
          selected={here.name === 'settings'}
          onPress={() => go(() => router.navigate('/settings'))}
        >
          <Icon ios="gearshape" android="settings" size={20} />
          <Text style={label}>{t('settings.title')}</Text>
        </Item>
      </View>
    </View>
  );
}
