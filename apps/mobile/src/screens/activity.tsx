// Full timeline, including agent ↔ agent traffic (the owner is a recipient of every envelope).
// Unverified items are marked; seq gaps warn that the relay may have withheld or lost something.

import { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { pendingForOwner, seqGaps } from '@catcher/client';
import { t } from '@/i18n';
import type { LocalItem } from '@/lib/db';
import { dateTime, newestFirst } from '@/lib/format';
import { useOwnerId } from '@/state/selectors';
import { useApp } from '@/state/store';
import { sync } from '@/state/sync';
import { colors } from '@/ui/colors';
import { Banner, Dot, Empty, Pill, tap } from '@/ui/kit';
import { kindKey, preview, sealedToOldKey, SyncBanner } from './parts';

function Chip({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID?: string }) {
  let bg = colors.card;
  let fg = colors.label;
  if (on) {
    bg = colors.accent;
    fg = colors.onAccent;
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={{ borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: bg }}
    >
      <Text style={{ color: fg, fontSize: 15, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );
}

function StateTag({ item }: { item: LocalItem }) {
  if (sealedToOldKey(item)) return <Pill label={t('activity.oldKeyTag')} />;
  if (!item.verified) return <Pill label={t('activity.unverified')} tone="danger" />;
  if (item.held) return <Pill label={t('activity.held')} tone="warning" />;
  if (item.dropped) return <Pill label={t('activity.dropped')} tone="danger" />;
  if (item.released) return <Pill label={t('activity.released')} tone="success" />;
  return null;
}

function LiveState() {
  const live = useApp((s) => s.live);
  let label = t('activity.offline');
  if (live === 'live') label = t('activity.live');
  if (live === 'connecting') label = t('activity.connecting');
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Dot on={live === 'live'} />
      <Text style={{ fontSize: 13, color: colors.secondaryLabel }}>{label}</Text>
    </View>
  );
}

export function ActivityScreen() {
  const items = useApp((s) => s.items);
  const agents = useApp((s) => s.agents);
  const senderSeq = useApp((s) => s.senderSeq);
  const ownerId = useOwnerId();
  const [filter, setFilter] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const names = (id: string) => {
    if (id === ownerId) return 'owner';
    return agents.find((a) => a.agentId === id)?.name ?? id;
  };
  const shown = useMemo(() => {
    const list = items.filter((i) => !filter || i.from === filter || i.to === filter);
    return newestFirst(list);
  }, [items, filter]);
  const liveSince = useApp((s) => s.liveSince);
  const gaps = useMemo(
    () => seqGaps(items, senderSeq, { ownerId, sinceCursor: liveSince + 1 }),
    [items, senderSeq, ownerId, liveSince],
  );
  const pendingIds = useMemo(() => new Set(pendingForOwner(items, ownerId).map((i) => i.id)), [items, ownerId]);

  const open = (item: LocalItem) => {
    if (pendingIds.has(item.id)) {
      router.push({ pathname: '/request/[id]', params: { id: item.id } });
      return;
    }
    let other: string | null = null;
    if (item.from === ownerId) other = item.to;
    if (item.to === ownerId) other = item.from;
    if (other) router.push({ pathname: '/chat/[agentId]', params: { agentId: other } });
  };

  const header = (
    <View style={{ gap: 12, paddingBottom: 8 }}>
      <SyncBanner />
      <LiveState />
      {gaps.map((g) => (
        <Banner
          key={g.sender}
          testID="seq-gap"
          title={t('activity.gapTitle')}
          body={t('activity.gapBody', { name: names(g.sender), count: g.missing })}
        />
      ))}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <Chip
          testID="activity-filter-all"
          label={t('activity.all')}
          on={filter === null}
          onPress={() => setFilter(null)}
        />
        {agents.map((a) => (
          <Chip
            key={a.agentId}
            testID={`activity-filter-${a.name}`}
            label={a.name}
            on={filter === a.agentId}
            onPress={() => setFilter(a.agentId)}
          />
        ))}
      </ScrollView>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <FlatList
        testID="activity"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, gap: 8 }}
        data={shown}
        keyExtractor={(i) => i.id}
        ListHeaderComponent={header}
        ListEmptyComponent={<Empty title={t('activity.empty')} body={t('activity.emptyBody')} />}
        refreshing={refreshing}
        onRefresh={() => {
          setRefreshing(true);
          sync()
            .catch(() => undefined)
            .finally(() => setRefreshing(false));
        }}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => open(item)}
            style={({ pressed }) => ({
              borderRadius: 14,
              borderCurve: 'continuous',
              padding: 14,
              gap: 6,
              backgroundColor: (pressed && colors.fill) || colors.card,
            })}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ flex: 1, fontSize: 15, fontWeight: '600', color: colors.label }} numberOfLines={1}>
                {`${item.fromName} → ${item.toName}`}
              </Text>
              <Text style={{ fontSize: 12, color: colors.tertiaryLabel }}>{dateTime(item.createdAt)}</Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
              <Pill label={t(kindKey(item))} />
              {item.scope && <Pill label={item.scope} tone="info" />}
              <StateTag item={item} />
            </View>
            <Text
              selectable
              dataDetectorType="none"
              numberOfLines={4}
              style={{ fontSize: 15, lineHeight: 21, color: colors.secondaryLabel }}
            >
              {preview(item, names)}
            </Text>
            {!item.verified && !sealedToOldKey(item) && item.problem && (
              <Text style={{ fontSize: 13, color: colors.danger }}>{item.problem}</Text>
            )}
          </Pressable>
        )}
      />
    </View>
  );
}
