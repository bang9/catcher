// One request, one decision: answer an ask, approve/deny a confirm, type an OTP, decide a grant request,
// or release/block a held agent → agent message. Agent text is shown as plain text only.

import { type ReactNode, useState } from 'react';
import { Alert, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { pendingForOwner } from '@catcher/client';
import type { AgentSummary, AnswerBody } from '@catcher/protocol';
import { t } from '@/i18n';
import { asAsk, asConfirm, asGrantRequest, asOtp, messageText } from '@/lib/bodies';
import type { LocalItem } from '@/lib/db';
import { describeError } from '@/lib/errors';
import { dateTime, remaining, shortDate } from '@/lib/format';
import { answerFor, useAgentMap, useNow } from '@/state/selectors';
import { getState, requireOwner, useApp } from '@/state/store';
import { sync, withSeqRetry } from '@/state/sync';
import { mono } from '@/ui/colors';
import { Banner, Button, Empty, Field, Group, Info, Lede, PlainText, Screen, Small, Title } from '@/ui/kit';
import { answerText, sealedToOldKey } from './parts';

type Names = (id: string) => string;

async function finish(): Promise<void> {
  await sync().catch(() => undefined);
  router.back();
}

/** Busy/error handling shared by every decision on this screen. */
function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await action();
      await finish();
    } catch (e) {
      setError(describeError(e));
      setBusy(null);
    }
  };
  return { busy, error, run };
}

function sender(item: LocalItem): AgentSummary {
  const agent = getState().agents.find((a) => a.agentId === item.from);
  if (!agent) throw new Error('requesting agent is gone');
  return agent;
}

function answer(item: LocalItem, body: AnswerBody): Promise<string> {
  const owner = requireOwner();
  return withSeqRetry(() => owner.answer(item, sender(item), body));
}

function Frame({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <Screen keyboard testID="request" footer={footer}>
      {children}
    </Screen>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <Banner tone="danger" title={error} />;
}

function Expiry({ item }: { item: LocalItem }) {
  if (!item.expiresAt) return null;
  return <Small>{t('inbox.expiresIn', { time: remaining(item.expiresAt - Date.now()) })}</Small>;
}

// ─── ask ─────────────────────────────────────────────────────────────────────

function AskView({ item }: { item: LocalItem }) {
  const ask = asAsk(item.body);
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  if (!ask) return <Malformed />;
  const send = (value: string) => void run(value, () => answer(item, { answer: value }));
  return (
    <Frame
      footer={
        <Button
          testID="ask-send"
          label={t('ask.send')}
          busy={busy === text && text !== ''}
          disabled={!text.trim() || busy !== null}
          onPress={() => send(text.trim())}
        />
      }
    >
      <Small>{t('ask.title', { name: item.fromName })}</Small>
      <PlainText size={22}>{ask.question}</PlainText>
      <Expiry item={item} />
      <ErrorLine error={error} />
      {(ask.choices ?? []).length > 0 && (
        <View style={{ gap: 8 }}>
          {(ask.choices ?? []).map((choice, i) => (
            <Button
              key={`${i}-${choice}`}
              testID={`ask-choice-${i}`}
              kind="secondary"
              label={choice}
              busy={busy === choice}
              disabled={busy !== null}
              onPress={() => send(choice)}
            />
          ))}
        </View>
      )}
      <Field
        testID="ask-input"
        value={text}
        onChangeText={setText}
        placeholder={t('ask.placeholder')}
        multiline
        style={{ minHeight: 80, textAlignVertical: 'top' }}
      />
    </Frame>
  );
}

// ─── confirm ─────────────────────────────────────────────────────────────────

function ConfirmView({ item }: { item: LocalItem }) {
  const confirm = asConfirm(item.body);
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  if (!confirm) return <Malformed />;
  const decide = (approved: boolean) => {
    const body: AnswerBody = { approved };
    if (note.trim()) body.note = note.trim();
    void run(String(approved), () => answer(item, body));
  };
  return (
    <Frame
      footer={
        <>
          <Button
            testID="confirm-approve"
            label={t('confirm.approve')}
            busy={busy === 'true'}
            disabled={busy !== null}
            onPress={() => decide(true)}
          />
          <Button
            testID="confirm-deny"
            kind="danger"
            label={t('confirm.deny')}
            busy={busy === 'false'}
            disabled={busy !== null}
            onPress={() => decide(false)}
          />
        </>
      }
    >
      <Small>{t('confirm.title', { name: item.fromName })}</Small>
      <PlainText size={22}>{confirm.action}</PlainText>
      {confirm.details && <PlainText>{confirm.details}</PlainText>}
      <Expiry item={item} />
      <ErrorLine error={error} />
      <Field value={note} onChangeText={setNote} placeholder={t('confirm.notePlaceholder')} />
    </Frame>
  );
}

// ─── otp ─────────────────────────────────────────────────────────────────────

function OtpView({ item }: { item: LocalItem }) {
  const otp = asOtp(item.body);
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();
  if (!otp) return <Malformed />;
  return (
    <Frame
      footer={
        <Button
          testID="otp-send"
          label={t('otp.send')}
          busy={busy !== null}
          disabled={code.length < 3}
          onPress={() => void run('otp', () => answer(item, { code }))}
        />
      }
    >
      <Title>{t('otp.title', { service: otp.service })}</Title>
      <Lede>{t('otp.lede', { name: item.fromName })}</Lede>
      {otp.hint && <PlainText color={undefined}>{otp.hint}</PlainText>}
      <ErrorLine error={error} />
      <Field
        testID="otp-input"
        value={code}
        onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 12))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        autoFocus
        placeholder={t('otp.placeholder')}
        style={{ fontFamily: mono, fontSize: 28, letterSpacing: 6, textAlign: 'center' }}
      />
    </Frame>
  );
}

// ─── grant request ───────────────────────────────────────────────────────────

function GrantView({ item, names }: { item: LocalItem; names: Names }) {
  const g = asGrantRequest(item.body);
  const { busy, error, run } = useAction();
  if (!g) return <Malformed />;
  const decide = (approved: boolean) =>
    void run(String(approved), () => requireOwner().decideGrantRequest(item, getState().agents, approved));

  let approveLabel = t('grant.approve');
  let content: ReactNode;
  if (g.action === 'grant') {
    let expires = t('grant.forever');
    if (g.expiresInSec) expires = t('grant.until', { date: dateTime(Date.now() + g.expiresInSec * 1000) });
    let approval = t('grant.noApproval');
    if (g.requireApproval) approval = t('grant.requireApproval');
    content = (
      <>
        <Title>{t('grant.title', { from: names(g.from), to: names(g.to) })}</Title>
        <Small>{t('grant.asker', { name: item.fromName })}</Small>
        <Group>
          <Info first label={t('field.scopes')} value={g.scopes.join(', ')} mono />
          <Info label={t('field.expires')} value={expires} />
          <Info label={t('field.status')} value={approval} />
        </Group>
      </>
    );
  } else {
    approveLabel = t('grant.revokeApprove');
    let title = t('grant.revokeGrantTitle');
    if (g.agentId) title = t('grant.revokeAgentTitle', { name: names(g.agentId) });
    content = (
      <>
        <Title>{title}</Title>
        <Small>{t('grant.asker', { name: item.fromName })}</Small>
        {g.grantId && <GrantSummary grantId={g.grantId} names={names} />}
      </>
    );
  }
  return (
    <Frame
      footer={
        <>
          <Button
            testID="grant-approve"
            label={approveLabel}
            busy={busy === 'true'}
            disabled={busy !== null}
            onPress={() => decide(true)}
          />
          <Button
            testID="grant-deny"
            kind="danger"
            label={t('grant.deny')}
            busy={busy === 'false'}
            disabled={busy !== null}
            onPress={() => decide(false)}
          />
        </>
      }
    >
      {content}
      {g.note && (
        <Group style={{ padding: 16 }}>
          <Small>{t('field.note')}</Small>
          <PlainText>{g.note}</PlainText>
        </Group>
      )}
      <ErrorLine error={error} />
    </Frame>
  );
}

function GrantSummary({ grantId, names }: { grantId: string; names: Names }) {
  const grant = useApp((s) => s.grants.find((g) => g.grantId === grantId));
  if (!grant) return <Info first label="grant" value={grantId} mono />;
  return (
    <Group>
      <Info first label={t('field.from')} value={names(grant.from)} />
      <Info label={t('field.to')} value={names(grant.to)} />
      <Info label={t('field.scopes')} value={grant.scopes.join(', ')} mono />
    </Group>
  );
}

// ─── held agent → agent message ──────────────────────────────────────────────

function HeldView({ item }: { item: LocalItem }) {
  const { busy, error, run } = useAction();
  const owner = requireOwner();
  const drop = () =>
    Alert.alert(t('held.drop'), undefined, [
      { text: t('common.close'), style: 'cancel' },
      { text: t('held.drop'), style: 'destructive', onPress: () => void run('drop', () => owner.dropHeld(item.id)) },
    ]);
  return (
    <Frame
      footer={
        <>
          {item.verified && (
            <Button
              testID="held-release"
              label={t('held.release')}
              busy={busy === 'release'}
              disabled={busy !== null}
              onPress={() => void run('release', () => owner.release(item))}
            />
          )}
          <Button
            testID="held-drop"
            kind="danger"
            label={t('held.drop')}
            busy={busy === 'drop'}
            disabled={busy !== null}
            onPress={drop}
          />
        </>
      }
    >
      <Title>{t('held.title', { from: item.fromName, to: item.toName })}</Title>
      <Lede>{t('held.lede')}</Lede>
      <ErrorLine error={error} />
      {!item.verified && <Unverified item={item} />}
      {item.verified && (
        <Group style={{ padding: 16, gap: 8 }}>
          <PlainText>{messageText(item.body) || item.type}</PlainText>
        </Group>
      )}
      <Group>
        <Info first label={t('field.scopes')} value={item.scope ?? '—'} mono />
        <Info label={t('field.sent')} value={dateTime(item.createdAt)} />
      </Group>
    </Frame>
  );
}

// ─── states ──────────────────────────────────────────────────────────────────

function Malformed() {
  return (
    <Frame>
      <Banner tone="danger" title={t('request.unverifiedTitle')} body={t('request.unverifiedBody')} />
    </Frame>
  );
}

function Unverified({ item }: { item: LocalItem }) {
  if (sealedToOldKey(item)) return <Banner title={t('activity.oldKey')} />;
  return (
    <Banner
      tone="danger"
      title={t('request.unverifiedTitle')}
      body={`${t('request.unverifiedBody')} (${item.problem ?? '?'})`}
    />
  );
}

function Done({ item, title }: { item: LocalItem; title: string }) {
  const items = useApp((s) => s.items);
  const reply = answerFor(items, item.id);
  return (
    <Frame footer={<Button label={t('common.close')} kind="secondary" onPress={() => router.back()} />}>
      <Title>{title}</Title>
      <Small>{`${item.fromName} · ${shortDate(item.createdAt)}`}</Small>
      {reply && <PlainText>{t('chat.answered', { text: answerText(reply.body) })}</PlainText>}
    </Frame>
  );
}

export function RequestScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = useApp((s) => s.items.find((i) => i.id === id));
  const ownerId = useApp((s) => s.owner?.state.ownerId ?? '');
  const agentMap = useAgentMap();
  const now = useNow(5_000);
  const names: Names = (aid) => {
    if (aid === ownerId) return 'owner';
    return agentMap.get(aid)?.name ?? aid;
  };

  if (!item) {
    return (
      <Screen onRefresh={sync}>
        <Empty title={t('request.missing')} />
      </Screen>
    );
  }
  if (item.held) return <HeldView item={item} />;
  if (item.expiresAt !== null && item.expiresAt <= now) return <Done item={item} title={t('request.expired')} />;
  if (!pendingForOwner([item], ownerId).length || answerFor(getState().items, item.id)) {
    return <Done item={item} title={t('request.done')} />;
  }
  if (!item.verified) {
    return (
      <Frame>
        <Unverified item={item} />
      </Frame>
    );
  }
  if (item.type === 'ask') return <AskView item={item} />;
  if (item.type === 'confirm') return <ConfirmView item={item} />;
  if (item.type === 'otp') return <OtpView item={item} />;
  if (item.type === 'grant-request') return <GrantView item={item} names={names} />;
  return <Done item={item} title={t('request.done')} />;
}
