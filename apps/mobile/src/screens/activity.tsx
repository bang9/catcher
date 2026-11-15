// The record: what the owner decided and what was linked, kept in one place. Conversations stay in their chats; this
// screen answers "what did I allow, deny or pass on, and who can talk to whom?".
//
// Three views: Decisions (requests and held messages with their outcome — the default), Links (agents connected,
// permissions given, removed or expired) and All messages (everything, for looking something up). Grouped by day.
// Every row opens the conversation it happened in.

import { useMemo, useState } from 'react';
import { Pressable, SectionList, View } from 'react-native';
import { router } from 'expo-router';
import type { AgentSummary } from '@catcher/protocol';
import { pendingForOwner, seqGaps } from '@catcher/client';
import type { Key } from '@/i18n';
import { localeTag, t } from '@/i18n';
import { asConfirm, asGrantRequest } from '@/lib/bodies';
import type { LocalItem } from '@/lib/db';
import { clockTime } from '@/lib/format';
import { pairId } from '@/state/rooms';
import { answerFor, useOwnerId } from '@/state/selectors';
import { type GrantView, useApp } from '@/state/store';
import { sync } from '@/state/sync';
import { colors } from '@/ui/colors';
import { Banner, EDGE, Empty, Icon, SIZE, tap } from '@/ui/kit';
import { Text } from '@/ui/text';
import { preview, sealedToOldKey, SyncBanner } from './parts';

type View3 = 'decisions' | 'links' | 'messages';
type Tone = 'wait' | 'ok' | 'no' | 'muted' | 'bad';

interface Entry {
  key: string;
  at: number;
  icon: { ios: Parameters<typeof Icon>[0]['ios']; android: Parameters<typeof Icon>[0]['android'] };
  title: string;
  detail: string;
  status: { label: string; tone: Tone } | null;
  open: () => void;
}

const REQUESTS = new Set(['ask', 'confirm', 'otp', 'grant-request']);

// ─── where a row leads ───────────────────────────────────────────────────────

function openChat(agentId: string) {
  router.navigate({ pathname: '/chat/[agentId]', params: { agentId } });
}

function openPair(a: string, b: string) {
  router.navigate({ pathname: '/pair/[pairId]', params: { pairId: pairId(a, b) } });
}

/** The conversation an item belongs to: the two agents' room for agent ↔ agent, otherwise the agent's chat. */
function openItem(item: LocalItem, ownerId: string) {
  if (item.from !== ownerId && item.to !== ownerId) {
    openPair(item.from, item.to);
    return;
  }
  openChat((item.from === ownerId && item.to) || item.from);
}

// ─── building the rows ───────────────────────────────────────────────────────

function requestEntry(
  item: LocalItem,
  items: LocalItem[],
  pending: Set<string>,
  ownerId: string,
  name: (id: string) => string,
): Entry {
  let icon: Entry['icon'] = { ios: 'questionmark.bubble', android: 'help' };
  let titleKey: Key = 'record.ask';
  let detail = preview(item, name);
  if (item.type === 'confirm') {
    icon = { ios: 'checkmark.shield', android: 'verified_user' };
    titleKey = 'record.confirm';
    detail = asConfirm(item.body)?.action ?? detail;
  }
  if (item.type === 'otp') {
    icon = { ios: 'number', android: 'pin' };
    titleKey = 'record.otp';
  }
  const grant = (item.type === 'grant-request' && asGrantRequest(item.body)) || null;
  if (grant) {
    icon = { ios: 'link', android: 'link' };
    titleKey = 'record.grantAsk';
  }
  if (grant?.action === 'grant') detail = `${name(grant.from)} → ${name(grant.to)}`;

  let status: Entry['status'] = null;
  const reply = answerFor(items, item.id);
  if (pending.has(item.id)) status = { label: t('record.waiting'), tone: 'wait' };
  else if (reply) {
    // the outcome as a verb; what was answered stays in the chat
    const body = (reply.body ?? {}) as { approved?: boolean; code?: string };
    status = { label: t('record.answered'), tone: 'ok' };
    if (item.type === 'otp') status = { label: t('record.sent'), tone: 'ok' };
    if (body.approved === true) status = { label: t((grant && 'link.allowed') || 'chat.approved'), tone: 'ok' };
    if (body.approved === false) status = { label: t('chat.denied'), tone: 'no' };
  } else status = { label: t('record.expired'), tone: 'muted' };
  if (!item.verified && !sealedToOldKey(item)) status = { label: t('activity.unverified'), tone: 'bad' };

  return {
    key: item.id,
    at: item.createdAt,
    icon,
    title: t(titleKey, { name: item.fromName }),
    detail,
    status,
    open: () => openItem(item, ownerId),
  };
}

function heldEntry(item: LocalItem, pending: Set<string>, ownerId: string, name: (id: string) => string): Entry {
  let status: Entry['status'] = { label: t('record.waiting'), tone: 'wait' };
  if (!pending.has(item.id)) {
    if (item.released) status = { label: t('held.released'), tone: 'ok' };
    else status = { label: t('held.dropped'), tone: 'no' };
  }
  return {
    key: item.id,
    at: item.createdAt,
    icon: { ios: 'hand.raised', android: 'back_hand' },
    title: t('record.held', { from: item.fromName, to: item.toName }),
    detail: preview(item, name),
    status,
    open: () => openItem(item, ownerId),
  };
}

function grantEntry(g: GrantView, name: (id: string) => string): Entry {
  const parts = [t((g.requireApproval && 'link.everyMessage') || 'grant.noApproval')];
  let status: Entry['status'] = { label: t('record.active'), tone: 'ok' };
  if (g.expired) status = { label: t('grant.expired'), tone: 'muted' };
  if (g.revoked) status = { label: t('grant.revoked'), tone: 'no' };
  return {
    key: g.grantId,
    at: g.issuedAt,
    icon: { ios: 'link', android: 'link' },
    title: t('record.grant', { from: name(g.from), to: name(g.to) }),
    detail: parts.join(' · '),
    status,
    open: () => openPair(g.from, g.to),
  };
}

function agentEntry(a: AgentSummary): Entry {
  let status: Entry['status'] = null;
  if (a.status !== 'active') status = { label: t('status.revoked'), tone: 'no' };
  return {
    key: `agent-${a.agentId}`,
    at: a.createdAt,
    icon: { ios: 'plus.circle', android: 'add_circle' },
    title: t('record.agent', { name: a.name }),
    detail: `${a.provider} · ${a.device}`,
    status,
    open: () => openChat(a.agentId),
  };
}

function messageEntry(item: LocalItem, ownerId: string, name: (id: string) => string): Entry {
  return {
    key: item.id,
    at: item.createdAt,
    icon: { ios: 'bubble.left', android: 'chat_bubble' },
    title: `${item.fromName} → ${item.toName}`,
    detail: preview(item, name),
    status: (!item.verified && !sealedToOldKey(item) && { label: t('activity.unverified'), tone: 'bad' }) || null,
    open: () => openItem(item, ownerId),
  };
}

const day = (x: number) => new Date(x).toDateString();

/** "Today", "Yesterday", or the date. */
function dayLabel(ms: number, now: number): string {
  if (day(ms) === day(now)) return t('record.today');
  if (day(ms) === day(now - 86_400_000)) return t('record.yesterday');
  try {
    return new Date(ms).toLocaleDateString(localeTag(), { month: 'long', day: 'numeric', weekday: 'short' });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

// ─── pieces ──────────────────────────────────────────────────────────────────

function Tabs({ value, onChange }: { value: View3; onChange: (v: View3) => void }) {
  const tabs: { value: View3; label: string }[] = [
    { value: 'decisions', label: t('record.decisions') },
    { value: 'links', label: t('record.links') },
    { value: 'messages', label: t('record.messages') },
  ];
  return (
    <View style={{ flexDirection: 'row', padding: 3, borderRadius: 12, backgroundColor: colors.card }}>
      {tabs.map((tab) => {
        const on = tab.value === value;
        return (
          <Pressable
            key={tab.value}
            testID={`record-${tab.value}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              tap();
              onChange(tab.value);
            }}
            style={{
              flex: 1,
              minHeight: SIZE.sm + 4,
              borderRadius: 9,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: (on && colors.background) || undefined,
              boxShadow: (on && '0 1px 3px rgba(0, 0, 0, 0.08)') || undefined,
            }}
          >
            <Text
              style={{
                fontSize: 14,
                fontWeight: (on && '600') || '500',
                color: (on && colors.label) || colors.secondaryLabel,
              }}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function StatusLabel({ status }: { status: NonNullable<Entry['status']> }) {
  let color = colors.secondaryLabel;
  if (status.tone === 'wait') color = colors.accent;
  if (status.tone === 'ok') color = colors.success;
  if (status.tone === 'no' || status.tone === 'bad') color = colors.danger;
  if (status.tone === 'muted') color = colors.tertiaryLabel;
  return (
    <Text numberOfLines={1} style={{ maxWidth: 120, fontSize: 13, lineHeight: 18, fontWeight: '600', color }}>
      {status.label}
    </Text>
  );
}

function Row({ entry }: { entry: Entry }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        tap();
        entry.open();
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 64,
        marginHorizontal: EDGE - 10,
        paddingHorizontal: 10,
        paddingVertical: 10,
        borderRadius: 14,
        borderCurve: 'continuous',
        backgroundColor: (pressed && colors.fill) || undefined,
      })}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.card,
        }}
      >
        <Icon ios={entry.icon.ios} android={entry.icon.android} size={18} color={colors.secondaryLabel} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 20, fontWeight: '500', color: colors.label }}>
          {entry.title}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 13, lineHeight: 18, color: colors.secondaryLabel }}>
          {`${clockTime(entry.at)} · ${entry.detail}`}
        </Text>
      </View>
      {entry.status && <StatusLabel status={entry.status} />}
    </Pressable>
  );
}

// ─── screen ──────────────────────────────────────────────────────────────────

const LEDE: Record<View3, Key> = {
  decisions: 'record.decisionsLede',
  links: 'record.linksLede',
  messages: 'record.messagesLede',
};

export function ActivityScreen() {
  const items = useApp((s) => s.items);
  const agents = useApp((s) => s.agents);
  const grants = useApp((s) => s.grants);
  const senderSeq = useApp((s) => s.senderSeq);
  const liveSince = useApp((s) => s.liveSince);
  const ownerId = useOwnerId();
  const [view, setView] = useState<View3>('decisions');
  const [refreshing, setRefreshing] = useState(false);

  const name = (id: string) => {
    if (id === ownerId) return 'owner';
    return agents.find((a) => a.agentId === id)?.name ?? id;
  };
  const pending = useMemo(() => new Set(pendingForOwner(items, ownerId).map((i) => i.id)), [items, ownerId]);
  const gaps = useMemo(
    () => seqGaps(items, senderSeq, { ownerId, sinceCursor: liveSince + 1 }),
    [items, senderSeq, ownerId, liveSince],
  );

  const sections = useMemo(() => {
    const label = (id: string) => {
      if (id === ownerId) return 'owner';
      return agents.find((a) => a.agentId === id)?.name ?? id;
    };
    let entries: Entry[] = [];
    if (view === 'decisions') {
      for (const i of items) {
        if (i.from !== ownerId && i.to !== ownerId && (i.held || i.released || i.dropped)) {
          entries.push(heldEntry(i, pending, ownerId, label));
        } else if (i.to === ownerId && REQUESTS.has(i.type)) {
          entries.push(requestEntry(i, items, pending, ownerId, label));
        }
      }
    }
    if (view === 'links') {
      entries = [...agents.map(agentEntry), ...grants.map((g) => grantEntry(g, label))];
    }
    if (view === 'messages') {
      entries = items
        .filter((i) => i.type === 'message' || i.type === 'reply')
        .map((i) => messageEntry(i, ownerId, label));
    }
    entries.sort((x, y) => y.at - x.at);
    const now = Date.now();
    const out: { title: string; data: Entry[] }[] = [];
    for (const e of entries) {
      const title = dayLabel(e.at, now);
      const last = out.at(-1);
      if (last && last.title === title) last.data.push(e);
      else out.push({ title, data: [e] });
    }
    return out;
  }, [view, items, agents, grants, pending, ownerId]);

  const header = (
    <View style={{ paddingHorizontal: EDGE, paddingTop: 8, paddingBottom: 4, gap: 12 }}>
      <SyncBanner />
      {gaps.map((g) => (
        <Banner
          key={g.sender}
          testID="seq-gap"
          title={t('activity.gapTitle')}
          body={t('activity.gapBody', { name: name(g.sender), count: g.missing })}
        />
      ))}
      <Tabs value={view} onChange={setView} />
      <Text style={{ fontSize: 13, lineHeight: 18, color: colors.secondaryLabel }}>{t(LEDE[view])}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SectionList
        testID="activity"
        sections={sections}
        keyExtractor={(e) => e.key}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={header}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: 32 }}
        ListEmptyComponent={<Empty title={t('record.empty')} />}
        renderSectionHeader={({ section }) => (
          <Text
            style={{
              fontSize: 13,
              lineHeight: 18,
              fontWeight: '500',
              color: colors.tertiaryLabel,
              paddingHorizontal: EDGE,
              paddingTop: 18,
              paddingBottom: 4,
            }}
          >
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => <Row entry={item} />}
        refreshing={refreshing}
        onRefresh={() => {
          setRefreshing(true);
          sync()
            .catch(() => undefined)
            .finally(() => setRefreshing(false));
        }}
      />
    </View>
  );
}
