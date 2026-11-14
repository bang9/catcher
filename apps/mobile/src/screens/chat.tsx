// One agent's thread: owner ↔ agent messages, replies, requests and answers in relay order, plus a composer.

import { useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, Text, TextInput, View } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { pendingForOwner } from '@catcher/client';
import { t } from '@/i18n';
import type { LocalItem } from '@/lib/db';
import { describeError } from '@/lib/errors';
import { clockTime, newestFirst, shortDate } from '@/lib/format';
import { useNow, useOwnerId } from '@/state/selectors';
import { requireOwner, useApp } from '@/state/store';
import { sync, withSeqRetry } from '@/state/sync';
import { colors } from '@/ui/colors';
import { Banner, Empty, Pill, tap } from '@/ui/kit';
import { isThreadItem, presence } from './chats';
import { answerText, kindKey, preview } from './parts';

function bubbleText(item: LocalItem, names: (id: string) => string): string {
  if (item.type === 'answer') return answerText(item.body);
  return preview(item, names);
}

function Bubble({
  item,
  mine,
  names,
  pending,
}: {
  item: LocalItem;
  mine: boolean;
  names: (id: string) => string;
  pending: boolean;
}) {
  let bg = colors.agentBubble;
  let fg = colors.label;
  let align: 'flex-start' | 'flex-end' = 'flex-start';
  if (mine) {
    bg = colors.ownBubble;
    fg = colors.onAccent;
    align = 'flex-end';
  }
  const showKind = item.type !== 'message' && item.type !== 'reply';
  return (
    <View style={{ alignItems: align, gap: 4, paddingHorizontal: 16, paddingVertical: 4 }}>
      <View
        style={{
          maxWidth: '82%',
          borderRadius: 18,
          borderCurve: 'continuous',
          paddingHorizontal: 14,
          paddingVertical: 10,
          gap: 6,
          backgroundColor: bg,
        }}
      >
        {showKind && mine && (
          <Text style={{ color: fg, opacity: 0.75, fontSize: 12, fontWeight: '600' }}>{t(kindKey(item))}</Text>
        )}
        {showKind && !mine && (
          <View style={{ flexDirection: 'row' }}>
            <Pill label={t(kindKey(item))} tone={(item.verified && 'muted') || 'danger'} />
          </View>
        )}
        {!item.verified && <Text style={{ color: colors.danger, fontSize: 13 }}>{item.problem ?? ''}</Text>}
        <Text selectable dataDetectorType="none" style={{ color: fg, fontSize: 16, lineHeight: 22 }}>
          {bubbleText(item, names)}
        </Text>
        {pending && (
          <Pressable
            testID={`chat-answer-${item.type}`}
            accessibilityRole="button"
            onPress={() => router.push({ pathname: '/request/[id]', params: { id: item.id } })}
            style={{ paddingVertical: 4 }}
          >
            <Text style={{ color: colors.accent, fontSize: 16, fontWeight: '600' }}>{t('chat.answer')} ›</Text>
          </Pressable>
        )}
      </View>
      <Text style={{ fontSize: 11, color: colors.tertiaryLabel }}>{clockTime(item.createdAt)}</Text>
    </View>
  );
}

function Composer({ agentId, active }: { agentId: string; active: boolean }) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = useApp((s) => s.agents.find((a) => a.agentId === agentId));

  if (!active || !agent) {
    return (
      <View style={{ padding: 16, paddingBottom: Math.max(insets.bottom, 16) }}>
        <Text style={{ textAlign: 'center', color: colors.secondaryLabel }}>{t('chat.inactive')}</Text>
      </View>
    );
  }

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    tap();
    setBusy(true);
    setError(null);
    try {
      const owner = requireOwner();
      await withSeqRetry(() => owner.send('message', agent, { text: body }));
      setText('');
      await sync().catch(() => undefined);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingTop: 8,
        paddingBottom: Math.max(insets.bottom, 8),
        gap: 6,
        backgroundColor: colors.background,
      }}
    >
      {error && <Banner tone="danger" title={error} />}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
        <TextInput
          testID="chat-input"
          value={text}
          onChangeText={setText}
          placeholder={t('chat.placeholder')}
          placeholderTextColor={colors.tertiaryLabel as string}
          multiline
          style={{
            flex: 1,
            minHeight: 40,
            maxHeight: 140,
            borderRadius: 20,
            paddingHorizontal: 14,
            paddingTop: 10,
            paddingBottom: 10,
            fontSize: 16,
            color: colors.label,
            backgroundColor: colors.card,
          }}
        />
        <Pressable
          testID="chat-send"
          accessibilityRole="button"
          accessibilityLabel={t('chat.send')}
          disabled={busy || !text.trim()}
          onPress={() => void send()}
          style={{
            height: 40,
            borderRadius: 20,
            paddingHorizontal: 16,
            justifyContent: 'center',
            backgroundColor: colors.accent,
            opacity: ((busy || !text.trim()) && 0.4) || 1,
          }}
        >
          <Text style={{ color: colors.onAccent, fontWeight: '600', fontSize: 16 }}>{t('chat.send')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function HeaderTitle({ name, subtitle }: { name: string; subtitle: string }) {
  return (
    <View style={{ alignItems: 'center' }}>
      <Text style={{ fontSize: 17, fontWeight: '600', color: colors.label }}>{name}</Text>
      <Text style={{ fontSize: 12, color: colors.secondaryLabel }}>{subtitle}</Text>
    </View>
  );
}

export function ChatScreen() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const ownerId = useOwnerId();
  const items = useApp((s) => s.items);
  const agents = useApp((s) => s.agents);
  const agent = agents.find((a) => a.agentId === agentId);
  const headerHeight = useHeaderHeight();
  const now = useNow(30_000);
  const [refreshing, setRefreshing] = useState(false);

  const thread = useMemo(
    () => newestFirst(items.filter((i) => isThreadItem(i, ownerId, agentId))),
    [items, ownerId, agentId],
  );
  const pendingIds = useMemo(() => new Set(pendingForOwner(thread, ownerId).map((i) => i.id)), [thread, ownerId]);
  const names = (id: string) => {
    if (id === ownerId) return 'owner';
    return agents.find((a) => a.agentId === id)?.name ?? id;
  };

  let behavior: 'padding' | undefined;
  if (process.env.EXPO_OS === 'ios') behavior = 'padding';
  const name = agent?.name ?? agentId;
  let subtitle = '';
  if (agent) subtitle = presence(agent, now);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={behavior}
      keyboardVerticalOffset={headerHeight}
    >
      <Stack.Screen
        options={{
          headerTitle: () => <HeaderTitle name={name} subtitle={subtitle} />,
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={name}
              onPress={() => router.push({ pathname: '/agent/[agentId]', params: { agentId } })}
              hitSlop={12}
            >
              <Text style={{ color: colors.accent, fontSize: 22 }}>ⓘ</Text>
            </Pressable>
          ),
        }}
      />
      <FlatList
        testID="chat-thread"
        inverted
        data={thread}
        keyExtractor={(i) => i.id}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        refreshing={refreshing}
        onRefresh={() => {
          setRefreshing(true);
          sync()
            .catch(() => undefined)
            .finally(() => setRefreshing(false));
        }}
        contentContainerStyle={{ paddingVertical: 12, flexGrow: 1 }}
        ListEmptyComponent={
          <View style={{ flex: 1, transform: [{ scaleY: -1 }] }}>
            <Empty title={t('chats.noMessages')} />
          </View>
        }
        ListFooterComponent={
          (thread.length > 0 && (
            <Text style={{ textAlign: 'center', fontSize: 12, color: colors.tertiaryLabel, paddingVertical: 8 }}>
              {shortDate(thread.at(-1)?.createdAt ?? Date.now())}
            </Text>
          )) ||
          undefined
        }
        renderItem={({ item }) => (
          <Bubble item={item} mine={item.from === ownerId} names={names} pending={pendingIds.has(item.id)} />
        )}
      />
      <Composer agentId={agentId} active={agent?.status === 'active'} />
    </KeyboardAvoidingView>
  );
}
