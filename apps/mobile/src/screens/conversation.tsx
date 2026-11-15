// A conversation, built like the allob app's chat: the messages (newest at the bottom, an inverted list) and a composer
// floating over them. Used by all three kinds of conversation (state/rooms.ts): one agent, two agents talking to each
// other, a group.
//
// Messages: the owner's own in a grey bubble on the right; an agent's as plain text (with its name on top when more
// than one agent talks here); a request (question, confirmation, code, permission) or a held agent → agent message as a
// bordered card the owner decides right there. Sending shows the message at once; the relay round trips happen behind
// it. Long-press a message to copy it or pass it on to other agents.
//
// Keyboard (react-native-keyboard-controller): the composer rides the keyboard on the same curve (KeyboardStickyView),
// and the list lifts its latest message above the keyboard in the same frame (KeyboardChatScrollView). Both rise less by
// what the keyboard covers below the chat (the gesture bar — ui/keyboard.ts). Dragging the list down pulls the keyboard
// with the finger. At the bottom, new messages stick to it; scrolled up, the list keeps its place and a "↓" button shows
// (lib/follow.ts).

import { type ComponentRef, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  type LayoutChangeEvent,
  Pressable,
  type ScrollViewProps,
  type StyleProp,
  StyleSheet,
  TextInput,
  View,
  type ViewStyle,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import {
  KeyboardChatScrollView,
  type KeyboardChatScrollViewProps,
  KeyboardController,
  KeyboardGestureArea,
  KeyboardStickyView,
  useKeyboardState,
} from 'react-native-keyboard-controller';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { pendingForOwner } from '@catcher/client';
import { t } from '@/i18n';
import { asAsk, asConfirm, asGrantRequest, messageText } from '@/lib/bodies';
import type { LocalItem } from '@/lib/db';
import { describeError } from '@/lib/errors';
import { contentChanged, type Follow, type Jump, jumpOf, scrolled, sent, startFollow } from '@/lib/follow';
import { clockTime, remaining, shortDate } from '@/lib/format';
import { answerRequest, decideGrant, dropHeld, releaseHeld } from '@/state/actions';
import { discardMessage, outSent, retryMessage, type Room, roomItems, sendToRoom } from '@/state/rooms';
import { answerFor, useNow, useOwnerId } from '@/state/selectors';
import { type OutMessage, useApp } from '@/state/store';
import { colors } from '@/ui/colors';
import { useAreaGap, useDragFollow } from '@/ui/keyboard';
import { Icon, tap } from '@/ui/kit';
import { fontFamily, Text } from '@/ui/text';
import { answerText, kindKey, preview } from './parts';

export type Names = (id: string) => string;

type Row =
  | { kind: 'item'; key: string; at: number; item: LocalItem }
  | { kind: 'out'; key: string; at: number; out: OutMessage }
  | { kind: 'time'; key: string; at: number };

const REQUEST_TYPES = new Set(['ask', 'confirm', 'otp', 'grant-request']);
/** a time label above a message that comes after a pause this long */
const GAP_MS = 15 * 60_000;
/** chat text size and line heights (bubble a little tighter than the agent's running text) */
const CHAT = 15.5;
const BUBBLE_LINE = Math.round(CHAT * 1.45);
const TEXT_LINE = Math.round(CHAT * 1.55);
/** composer: one line is a 48 pill around a 36 round send button; it grows to 6 lines, then scrolls inside */
const COMPOSER_MIN = 48;
const SEND = 36;
const INPUT_LINES = 6;
/** inline actions in a card */
const ACTION = 40;
const INPUT_ID = 'chat-input';
/** scrolled up to read: keep the visible message in place while new ones arrive at the bottom */
const KEEP_POSITION = { minIndexForVisible: 0 };

export const dismissKeyboard = () => void KeyboardController.dismiss();

/** Long-press on a message: copy it, or pass it on to other agents. */
function messageMenu(text: string, from?: string): void {
  if (!text) return;
  // the message itself, shortened, so it is clear which one the menu is for
  let shown = text;
  if (shown.length > 140) shown = `${shown.slice(0, 140)}…`;
  Alert.alert(t('chat.messageMenu'), shown, [
    { text: t('common.copy'), onPress: () => void Clipboard.setStringAsync(text) },
    {
      text: t('chat.forward'),
      onPress: () => {
        dismissKeyboard();
        // who said it travels with it, so the receiving agent knows it is passing on someone else's words
        router.push({ pathname: '/forward', params: { text, from: from ?? '' } });
      },
    },
    { text: t('common.close'), style: 'cancel' },
  ]);
}

// ─── messages ────────────────────────────────────────────────────────────────

function MyBubble({ text, faded, children }: { text: string; faded?: boolean; children?: ReactNode }) {
  return (
    <View style={styles.mine}>
      <Pressable onLongPress={() => messageMenu(text)} delayLongPress={350}>
        <View style={[styles.bubble, (faded && styles.faded) || null]}>
          <Text selectable dataDetectorType="none" style={styles.bubbleText}>
            {text}
          </Text>
        </View>
      </Pressable>
      {children}
    </View>
  );
}

function AgentText({ item, names, label }: { item: LocalItem; names: Names; label: string | null }) {
  const text = preview(item, names);
  return (
    <Pressable style={styles.agent} onLongPress={() => messageMenu(text, item.fromName)} delayLongPress={350}>
      {label && <Text style={styles.sender}>{label}</Text>}
      {!item.verified && <Text style={styles.problem}>{item.problem ?? t('request.unverifiedTitle')}</Text>}
      <Text dataDetectorType="none" style={styles.agentText}>
        {text}
      </Text>
    </Pressable>
  );
}

/** The owner's own answer to a request not shown here: a quiet receipt on the right. */
function AnswerReceipt({ item }: { item: LocalItem }) {
  return (
    <View style={styles.receipt}>
      <Icon ios="checkmark.circle.fill" android="check_circle" size={15} color={colors.tertiaryLabel} />
      <Text numberOfLines={2} style={styles.receiptText}>
        {answerText(item.body)}
      </Text>
    </View>
  );
}

function Action({
  label,
  onPress,
  kind = 'ink',
  busy,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  kind?: 'ink' | 'outline';
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  const ink = kind === 'ink';
  let fg = colors.label;
  if (ink) fg = colors.onInk;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled || busy}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [
        styles.action,
        (ink && styles.actionInk) || styles.actionOutline,
        { opacity: (disabled && !busy && 0.4) || (pressed && 0.7) || 1 },
      ]}
    >
      {busy && <ActivityIndicator size="small" color={fg} />}
      {!busy && <Text style={[styles.actionText, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

function useQuick() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const quick = (key: string, run: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    run()
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => setBusy(null));
  };
  return { busy, error, quick };
}

/** The frame shared by request and held cards: kind line, the text, then the actions or the outcome. */
function Card({
  pending,
  kind,
  meta,
  title,
  detail,
  problem,
  error,
  actions,
  answered,
  closedText,
}: {
  pending: boolean;
  kind: string;
  meta?: string;
  title: string;
  detail?: string | null;
  problem?: string | null;
  error: string | null;
  actions: ReactNode;
  answered: string | null;
  closedText: string;
}) {
  // after deciding, the outcome line takes the buttons' height so the card does not shrink under the finger
  let outcome: ReactNode = null;
  if (answered !== null) {
    outcome = (
      <View style={styles.result}>
        <Icon ios="checkmark.circle.fill" android="check_circle" size={16} color={colors.success} />
        <Text style={styles.resultText}>{answered}</Text>
      </View>
    );
  } else if (!pending) {
    outcome = (
      <View style={styles.result}>
        <Text style={styles.expired}>{closedText}</Text>
      </View>
    );
  }
  return (
    <Pressable
      style={[styles.card, (pending && styles.cardPending) || null]}
      onLongPress={() => messageMenu([title, detail].filter(Boolean).join('\n'))}
      delayLongPress={350}
    >
      <View style={styles.cardHead}>
        <Text style={[styles.kind, (pending && styles.kindPending) || null]}>{kind}</Text>
        <View style={styles.flex} />
        {!!meta && <Text style={styles.meta}>{meta}</Text>}
      </View>
      {!!problem && <Text style={styles.problem}>{problem}</Text>}
      <Text dataDetectorType="none" style={styles.cardText}>
        {title}
      </Text>
      {!!detail && (
        <Text dataDetectorType="none" style={styles.cardDetail}>
          {detail}
        </Text>
      )}
      {error && <Text style={styles.problem}>{error}</Text>}
      {pending && actions}
      {outcome}
    </Pressable>
  );
}

function RequestCard({
  item,
  names,
  pending,
  answered,
  now,
}: {
  item: LocalItem;
  names: Names;
  pending: boolean;
  answered: string | null;
  now: number;
}) {
  const { busy, error, quick } = useQuick();
  const open = () => {
    dismissKeyboard();
    router.push({ pathname: '/request/[id]', params: { id: item.id } });
  };
  const actionable = pending && item.verified;

  let title = preview(item, names);
  let detail: string | null = null;
  let actions: ReactNode = null;
  if (item.type === 'confirm') detail = asConfirm(item.body)?.details ?? null;

  if (actionable && item.type === 'confirm') {
    const decide = (approved: boolean) =>
      quick(String(approved), () =>
        answerRequest(item, { approved }, t((approved && 'chat.approved') || 'chat.denied')),
      );
    actions = (
      <View style={styles.actions}>
        <Action
          testID="card-approve"
          label={t('confirm.approve')}
          busy={busy === 'true'}
          disabled={busy !== null}
          onPress={() => decide(true)}
        />
        <Action
          testID="card-deny"
          kind="outline"
          label={t('confirm.deny')}
          busy={busy === 'false'}
          disabled={busy !== null}
          onPress={() => decide(false)}
        />
      </View>
    );
  }
  if (actionable && item.type === 'ask') {
    const choices = asAsk(item.body)?.choices ?? [];
    actions = (
      <View style={styles.actions}>
        {choices.map((choice, i) => (
          <Action
            key={`${i}-${choice}`}
            testID={`card-choice-${i}`}
            kind="outline"
            label={choice}
            busy={busy === choice}
            disabled={busy !== null}
            onPress={() => quick(choice, () => answerRequest(item, { answer: choice }, choice))}
          />
        ))}
        <Action testID="chat-answer-ask" label={t('chat.answer')} disabled={busy !== null} onPress={open} />
      </View>
    );
  }
  const grant = (item.type === 'grant-request' && asGrantRequest(item.body)) || null;
  if (grant?.action === 'grant') {
    // a permission request reads as a sentence, and is decided right here
    title = t('link.askSentence', { from: names(grant.from), to: names(grant.to) });
    const parts: string[] = [];
    if (grant.requireApproval) parts.push(t('link.everyMessage'));
    if (grant.note) parts.push(grant.note);
    detail = parts.join(' · ') || null;
    if (actionable) {
      const decide = (approved: boolean) =>
        quick(String(approved), () => decideGrant(item, approved, t((approved && 'link.allowed') || 'chat.denied')));
      actions = (
        <View style={styles.actions}>
          <Action
            testID="card-allow"
            label={t('link.allow')}
            busy={busy === 'true'}
            disabled={busy !== null}
            onPress={() => decide(true)}
          />
          <Action
            testID="card-deny"
            kind="outline"
            label={t('confirm.deny')}
            busy={busy === 'false'}
            disabled={busy !== null}
            onPress={() => decide(false)}
          />
        </View>
      );
    }
  } else if (actionable && (item.type === 'otp' || item.type === 'grant-request')) {
    actions = (
      <View style={styles.actions}>
        <Action testID={`chat-answer-${item.type}`} label={t('chat.answer')} onPress={open} />
      </View>
    );
  }

  let meta = '';
  if (pending && item.expiresAt) meta = t('inbox.expiresIn', { time: remaining(item.expiresAt - now) });
  let problem: string | null = null;
  if (!item.verified) problem = item.problem ?? t('request.unverifiedTitle');
  return (
    <Card
      pending={pending}
      kind={t(kindKey(item))}
      meta={meta}
      title={title}
      detail={detail}
      problem={problem}
      error={error}
      actions={actions}
      answered={answered}
      closedText={t('request.expired')}
    />
  );
}

/** An agent → agent message waiting for the owner (the permission says "every message needs my OK"). */
function HeldCard({ item, names, pending }: { item: LocalItem; names: Names; pending: boolean }) {
  const { busy, error, quick } = useQuick();
  let answered: string | null = null;
  if (item.released) answered = t('held.released');
  if (item.dropped) answered = t('held.dropped');
  const drop = () =>
    Alert.alert(t('held.drop'), undefined, [
      { text: t('common.close'), style: 'cancel' },
      {
        text: t('held.drop'),
        style: 'destructive',
        onPress: () => quick('drop', () => dropHeld(item, t('held.dropped'))),
      },
    ]);
  const actions = (
    <View style={styles.actions}>
      {item.verified && (
        <Action
          testID="card-release"
          label={t('held.release')}
          busy={busy === 'release'}
          disabled={busy !== null}
          onPress={() => quick('release', () => releaseHeld(item, t('held.released')))}
        />
      )}
      <Action
        testID="card-drop"
        kind="outline"
        label={t('held.drop')}
        busy={busy === 'drop'}
        disabled={busy !== null}
        onPress={drop}
      />
    </View>
  );
  let problem: string | null = null;
  if (!item.verified) problem = item.problem ?? t('request.unverifiedTitle');
  return (
    <Card
      pending={pending}
      kind={`${item.fromName} → ${item.toName}`}
      title={messageText(item.body) || preview(item, names)}
      problem={problem}
      error={error}
      actions={actions}
      answered={answered}
      closedText={t('held.dropped')}
    />
  );
}

function OutRow({ out }: { out: OutMessage }) {
  let footer: ReactNode = null;
  if (out.failed) {
    footer = (
      <View style={styles.failedRow}>
        <Text style={styles.failedText}>{t('chat.failed')}</Text>
        <Pressable accessibilityRole="button" hitSlop={10} onPress={() => retryMessage(out.key)}>
          <Text style={styles.failedAction}>{t('chat.retry')}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" hitSlop={10} onPress={() => discardMessage(out.key)}>
          <Text style={styles.failedDiscard}>{t('chat.discard')}</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <MyBubble text={out.text} faded={!outSent(out) && !out.failed}>
      {footer}
    </MyBubble>
  );
}

function TimeRow({ at }: { at: number }) {
  return <Text style={styles.time}>{`${shortDate(at)} ${clockTime(at)}`}</Text>;
}

function JumpButton({ jump, onPress }: { jump: Jump; onPress: () => void }) {
  if (jump === 'hidden') return null;
  return (
    <Pressable
      testID="chat-jump"
      accessibilityRole="button"
      accessibilityLabel={t('chat.toLatest')}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.jump,
        (jump === 'new' && styles.jumpWide) || styles.jumpRound,
        { backgroundColor: (pressed && colors.fill) || colors.background },
      ]}
    >
      <Icon ios="arrow.down" android="arrow_downward" size={16} />
      {jump === 'new' && <Text style={styles.jumpText}>{t('chat.newMessage')}</Text>}
    </Pressable>
  );
}

// ─── composer ────────────────────────────────────────────────────────────────

function Composer({
  placeholder,
  inactive,
  onSend,
}: {
  placeholder: string;
  /** why nothing can be sent here (shown instead of the composer) */
  inactive: string | null;
  onSend: (text: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const [value, setValue] = useState('');
  // the text as typed, read on send (two taps in one frame send once)
  const draft = useRef('');
  const bottom = insets.bottom + 10;

  if (inactive) {
    return (
      <View style={[styles.composerWrap, { paddingBottom: bottom }]}>
        <Text style={styles.inactive}>{inactive}</Text>
      </View>
    );
  }

  const ready = value.trim().length > 0;
  const submit = () => {
    const text = draft.current.trim();
    if (!text) return;
    draft.current = '';
    tap();
    onSend(text);
    // clear at once (the native field too) and keep focus so the owner can keep typing
    input.current?.clear();
    setValue('');
  };

  return (
    <View style={[styles.composerWrap, { paddingBottom: bottom }]}>
      <View style={styles.composer}>
        <TextInput
          ref={input}
          testID="chat-input"
          nativeID={INPUT_ID}
          value={value}
          onChangeText={(text) => {
            draft.current = text;
            setValue(text);
          }}
          placeholder={placeholder}
          placeholderTextColor={colors.tertiaryLabel}
          selectionColor={colors.accent}
          cursorColor={colors.label}
          multiline
          scrollEnabled
          textAlignVertical="top"
          submitBehavior="newline"
          accessibilityLabel={placeholder}
          style={styles.input}
        />
        <Pressable
          testID="chat-send"
          accessibilityRole="button"
          accessibilityLabel={t('chat.send')}
          accessibilityState={{ disabled: !ready }}
          disabled={!ready}
          onPress={submit}
          hitSlop={4}
          style={({ pressed }) => [
            styles.send,
            { backgroundColor: (!ready && colors.fill) || (pressed && colors.secondaryLabel) || colors.ink },
          ]}
        >
          <Icon
            ios="arrow.up"
            android="arrow_upward"
            size={20}
            color={(ready && colors.onInk) || colors.tertiaryLabel}
          />
        </Pressable>
      </View>
    </View>
  );
}

// ─── the view ────────────────────────────────────────────────────────────────

export interface ChatViewProps {
  room: Room;
  /** agents a typed message goes to (one envelope each) */
  targets: string[];
  placeholder: string;
  /** why nothing can be sent here, or null */
  inactive: string | null;
  /** shown when there are no messages yet (the inverted list's empty slot, right above the composer) */
  empty: ReactNode;
  /** a line pinned above the messages (e.g. "these two cannot talk yet — Link") */
  notice?: ReactNode;
}

export function ChatView({ room, targets, placeholder, inactive, empty, notice }: ChatViewProps) {
  const insets = useSafeAreaInsets();
  const ownerId = useOwnerId();
  const items = useApp((s) => s.items);
  const agents = useApp((s) => s.agents);
  const outbox = useApp((s) => s.outbox);
  const settled = useApp((s) => s.settled);
  const roomSends = useApp((s) => s.roomSends);
  const now = useNow(30_000);
  const several = room.kind !== 'agent';

  // another screen opens, or the drawer: the keyboard closes
  useFocusEffect(useCallback(() => dismissKeyboard, []));

  const thread = useMemo(() => roomItems(room, items, ownerId, roomSends), [room, items, ownerId, roomSends]);
  const threadIds = useMemo(() => new Set(thread.map((i) => i.id)), [thread]);
  const pendingIds = useMemo(() => {
    // `now`: an expired request stops being actionable without a sync
    void now;
    return new Set(pendingForOwner(items, ownerId).map((i) => i.id));
  }, [items, ownerId, now]);
  const names: Names = (id) => {
    if (id === ownerId) return 'owner';
    return agents.find((a) => a.agentId === id)?.name ?? id;
  };

  // oldest → newest with a time label at each long pause, then newest first for the inverted list
  const rows = useMemo(() => {
    const all: Row[] = [];
    for (const item of thread) {
      // an answer to a request in this conversation shows on that request's card, not as its own row
      if (item.from === ownerId && item.type === 'answer' && item.ref && threadIds.has(item.ref)) continue;
      all.push({ kind: 'item', key: item.id, at: item.createdAt, item });
    }
    for (const out of outbox)
      if (out.room === room.key) all.push({ kind: 'out', key: out.key, at: out.createdAt, out });
    all.sort((x, y) => x.at - y.at);
    const out: Row[] = [];
    let prev = 0;
    for (const row of all) {
      if (row.at - prev > GAP_MS) out.push({ kind: 'time', key: `time-${row.key}`, at: row.at });
      prev = row.at;
      out.push(row);
    }
    return out.toReversed();
  }, [thread, threadIds, ownerId, outbox, room.key]);

  // ── following the bottom ──
  const list = useRef<FlatList<Row>>(null);
  const follow = useRef<Follow>(startFollow(''));
  const [jump, setJump] = useState<Jump>('hidden');
  const update = useCallback((next: Follow) => {
    follow.current = next;
    setJump(jumpOf(next));
  }, []);
  // the scroll offset of the bottom: the inverted list's top inset (keyboard + composer) as a negative number
  const endOffset = useRef(0);
  const onInset = useCallback((i: { top: number }) => {
    endOffset.current = -i.top;
  }, []);
  const toLatest = useCallback(
    (animated: boolean) => list.current?.scrollToOffset({ offset: endOffset.current, animated }),
    [],
  );
  // leaving the bottom only counts when a finger moved the list: layout changes (the composer measuring itself, the
  // keyboard inset) can report "not at the end" for a frame and must not freeze the list in place
  const dragged = useRef(false);
  const onEnd = useCallback(
    (atEnd: boolean) => {
      if (!atEnd && !dragged.current) return;
      // back at the bottom: the next "not at the end" needs a new drag
      if (atEnd) dragged.current = false;
      update(scrolled(follow.current, atEnd));
    },
    [update],
  );
  const latest = rows[0]?.key ?? '';
  useEffect(() => update(contentChanged(follow.current, latest)), [latest, update]);
  // another conversation picked from the sidebar: start at the bottom
  const shown = useRef(room.key);
  useEffect(() => {
    if (shown.current === room.key) return;
    shown.current = room.key;
    dragged.current = false;
    update(startFollow(''));
    toLatest(false);
  }, [room.key, update, toLatest]);
  const send = useCallback(
    (text: string) => {
      const wasUp = !follow.current.atEnd;
      sendToRoom(room.key, targets, text);
      update(sent(follow.current.mark));
      if (wasUp) toLatest(true);
    },
    [room.key, targets, update, toLatest],
  );

  // ── keyboard ──
  const { ref: area, gap, onLayout: measureArea } = useAreaGap();
  // the keyboard also covers the bottom safe area the composer pads itself with. A floating or split keyboard can
  // report almost no height: never move the composer below where it rests (0 is "closed": keep the full value so a
  // normal keyboard opens in one smooth move)
  const keyboardHeight = useKeyboardState((k) => k.height);
  let lift = gap + insets.bottom;
  if (keyboardHeight > 0 && keyboardHeight < lift) lift = keyboardHeight;
  const dragFollow = useDragFollow(lift);
  const [composerHeight, setComposerHeight] = useState(0);
  const onComposerLayout = useCallback(
    (e: LayoutChangeEvent) => setComposerHeight(Math.round(e.nativeEvent.layout.height)),
    [],
  );
  // the composer measures itself after the first frame; at the bottom, stay there once its room is added below
  useEffect(() => {
    if (composerHeight > 0 && follow.current.atEnd) toLatest(false);
  }, [composerHeight, toLatest]);
  const renderScroll = useCallback(
    (props: ScrollViewProps) => (
      <KeyboardChatScrollView
        {...(props as KeyboardChatScrollViewProps)}
        inverted
        offset={lift}
        keyboardLiftBehavior="always"
        onEndVisible={onEnd}
        onContentInsetChange={onInset}
      />
    ),
    [lift, onEnd, onInset],
  );

  const renderRow = ({ item: row, index }: { item: Row; index: number }) => {
    if (row.kind === 'time') return <TimeRow at={row.at} />;
    if (row.kind === 'out') return <OutRow out={row.out} />;
    const item = row.item;
    if (item.from === ownerId && item.type === 'answer') return <AnswerReceipt item={item} />;
    if (item.from === ownerId) return <MyBubble text={preview(item, names)} />;
    if (item.held || (item.from !== ownerId && item.to !== ownerId && (item.released || item.dropped))) {
      return <HeldCard item={item} names={names} pending={pendingIds.has(item.id)} />;
    }
    if (REQUEST_TYPES.has(item.type)) {
      const reply = answerFor(items, item.id);
      let answered: string | null = settled[item.id] ?? null;
      if (reply) answered = answerText(reply.body);
      // a permission that was granted reads as "allowed", not "approved"
      if (reply && item.type === 'grant-request' && answered === t('chat.approved')) answered = t('link.allowed');
      return (
        <RequestCard
          item={item}
          names={names}
          pending={pendingIds.has(item.id) && !(item.id in settled)}
          answered={answered}
          now={now}
        />
      );
    }
    // several agents here: name the speaker at the start of each run (the row above, in time, is index + 1)
    let label: string | null = null;
    if (several) {
      const above = rows[index + 1];
      const sameRun = above?.kind === 'item' && above.item.from === item.from && above.item.to === item.to;
      if (!sameRun) {
        label = item.fromName;
        if (item.to !== ownerId) label = `${item.fromName} → ${item.toName}`;
      }
    }
    return <AgentText item={item} names={names} label={label} />;
  };

  // the inverted list's top padding is the screen bottom: room for the floating composer
  let base: StyleProp<ViewStyle> = styles.list;
  if (rows.length === 0) base = styles.emptyList;
  const contentStyle = [base, { paddingTop: composerHeight + 10 }];

  return (
    <View style={styles.screen}>
      {notice}
      {/* dragging the list pulls the keyboard down once the finger reaches the composer */}
      <KeyboardGestureArea interpolator="ios" offset={composerHeight} textInputNativeID={INPUT_ID} style={styles.flex}>
        <View ref={area} collapsable={false} onLayout={measureArea} style={styles.flex}>
          <Animated.View style={[styles.flex, dragFollow]}>
            <FlatList
              ref={list}
              testID="chat-thread"
              inverted
              data={rows}
              keyExtractor={(r) => r.key}
              renderItem={renderRow}
              renderScrollComponent={renderScroll}
              contentContainerStyle={contentStyle}
              contentInsetAdjustmentBehavior="never"
              automaticallyAdjustKeyboardInsets={false}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              onScrollBeginDrag={() => {
                dragged.current = true;
              }}
              maintainVisibleContentPosition={(jump === 'hidden' && undefined) || KEEP_POSITION}
              ListEmptyComponent={<EmptySlot>{empty}</EmptySlot>}
              initialNumToRender={12}
              windowSize={11}
            />
          </Animated.View>
          <KeyboardStickyView offset={{ closed: 0, opened: lift }} style={styles.bottom}>
            <View style={styles.jumpSlot} pointerEvents="box-none">
              <JumpButton jump={jump} onPress={() => toLatest(true)} />
            </View>
            <View onLayout={onComposerLayout} style={{ backgroundColor: colors.background }}>
              {/* keyed by conversation: a half-typed message never carries over to another one */}
              <Composer key={room.key} placeholder={placeholder} inactive={inactive} onSend={send} />
            </View>
          </KeyboardStickyView>
        </View>
      </KeyboardGestureArea>
    </View>
  );
}

/** The inverted list hands its empty slot a flip style so it reads the right way up. */
function EmptySlot({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.empty, style]}>{children}</View>;
}

/** Header title for a conversation: name on top, a status line below. */
export function ChatTitle({
  title,
  sub,
  dot,
  onPress,
}: {
  title: string;
  sub: string;
  dot?: boolean;
  onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => {
        if (!onPress) return;
        dismissKeyboard();
        onPress();
      }}
      style={styles.headerTitle}
    >
      <Text numberOfLines={1} style={styles.headerName}>
        {title}
      </Text>
      <View style={styles.headerPresence}>
        {dot !== undefined && (
          <View style={[styles.presenceDot, { backgroundColor: (dot && colors.success) || colors.tertiaryLabel }]} />
        )}
        <Text numberOfLines={1} style={styles.headerSub}>
          {sub}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  // 16 at the sides, 14 between messages (the allob chat)
  list: { paddingHorizontal: 16, paddingBottom: 14, gap: 14 },
  emptyList: { flexGrow: 1, paddingHorizontal: 16 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  jumpSlot: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: '100%',
    alignItems: 'center',
    paddingBottom: 8,
  },

  mine: { alignItems: 'flex-end', gap: 6, paddingLeft: 48 },
  bubble: {
    borderRadius: 20,
    borderCurve: 'continuous',
    paddingHorizontal: 15,
    paddingVertical: 10,
    backgroundColor: colors.card,
  },
  faded: { opacity: 0.55 },
  bubbleText: { fontSize: CHAT, lineHeight: BUBBLE_LINE, color: colors.label },
  agent: { gap: 4 },
  sender: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.secondaryLabel },
  agentText: { fontSize: CHAT, lineHeight: TEXT_LINE, color: colors.label },
  problem: { fontSize: 13, lineHeight: 18, color: colors.danger },
  receipt: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, paddingLeft: 48 },
  receiptText: { flexShrink: 1, fontSize: 14, lineHeight: 20, color: colors.secondaryLabel },
  time: { textAlign: 'center', fontSize: 12, lineHeight: 16, color: colors.tertiaryLabel, paddingTop: 6 },

  // a card: border 1, corner 18, inside 14 (the allob action card)
  card: {
    borderRadius: 18,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: colors.separator,
    padding: 14,
    gap: 8,
  },
  cardPending: { borderColor: colors.accent },
  cardHead: { flexDirection: 'row', alignItems: 'center', minHeight: 18 },
  kind: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: colors.secondaryLabel },
  kindPending: { color: colors.accent },
  meta: { fontSize: 12.5, lineHeight: 18, color: colors.tertiaryLabel },
  cardText: { fontSize: 16, lineHeight: 23, fontWeight: '600', color: colors.label },
  cardDetail: { fontSize: 14.5, lineHeight: 21, color: colors.secondaryLabel },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 4 },
  action: {
    minHeight: ACTION,
    paddingHorizontal: 16,
    borderRadius: ACTION / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionInk: { backgroundColor: colors.ink },
  actionOutline: { borderWidth: 1, borderColor: colors.separator },
  actionText: { fontSize: 15, fontWeight: '600' },
  result: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: ACTION + 4, paddingTop: 4 },
  resultText: { flex: 1, fontSize: 14.5, lineHeight: 20, color: colors.secondaryLabel },
  expired: { fontSize: 14.5, lineHeight: 20, color: colors.tertiaryLabel },

  failedRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  failedText: { fontSize: 13, color: colors.danger },
  failedAction: { fontSize: 13, fontWeight: '600', color: colors.label },
  failedDiscard: { fontSize: 13, color: colors.secondaryLabel },

  jump: {
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.separator,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.08)',
  },
  jumpRound: { width: 40 },
  jumpWide: { paddingHorizontal: 16 },
  jumpText: { fontSize: 14, fontWeight: '600', color: colors.label },

  // composer: 8 above, 12 at the sides, 10 + safe area below; a 48 pill with a 1 border, 5 inside
  composerWrap: { paddingHorizontal: 12, paddingTop: 8 },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    minHeight: COMPOSER_MIN,
    borderRadius: COMPOSER_MIN / 2,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: colors.separator,
    backgroundColor: colors.background,
    paddingLeft: 12,
    paddingRight: 5,
    paddingVertical: 5,
  },
  // one line is as tall as the send button, so text and button share a center line
  input: {
    flex: 1,
    minHeight: SEND,
    maxHeight: BUBBLE_LINE * INPUT_LINES + 12,
    paddingHorizontal: 4,
    paddingTop: (SEND - BUBBLE_LINE) / 2,
    paddingBottom: (SEND - BUBBLE_LINE) / 2,
    fontSize: CHAT,
    lineHeight: BUBBLE_LINE,
    fontFamily: fontFamily['400'],
    color: colors.label,
  },
  send: { width: SEND, height: SEND, borderRadius: SEND / 2, alignItems: 'center', justifyContent: 'center' },
  inactive: { textAlign: 'center', fontSize: 14, lineHeight: 20, color: colors.secondaryLabel, paddingVertical: 14 },

  headerTitle: { alignItems: 'center', maxWidth: 240 },
  headerName: { fontSize: 16, lineHeight: 21, fontWeight: '600', color: colors.label },
  headerPresence: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  presenceDot: { width: 6, height: 6, borderRadius: 3 },
  headerSub: { fontSize: 12, lineHeight: 16, color: colors.secondaryLabel },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingBottom: 40 },
});
