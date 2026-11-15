// Pieces several screens share: the sync banner and one-line summaries of items.

import type { Key } from '@/i18n';
import { t } from '@/i18n';
import { asAnswer, asAsk, asConfirm, asGrantRequest, asOtp, messageText } from '@/lib/bodies';
import type { AgentSummary } from '@catcher/protocol';
import type { LocalItem } from '@/lib/db';
import { ago, isOnline } from '@/lib/format';
import { getState, useApp } from '@/state/store';
import { Banner } from '@/ui/kit';

export function SyncBanner() {
  const error = useApp((s) => s.syncError);
  if (!error) return null;
  return <Banner testID="sync-error" tone="warning" title={t('error.syncTitle')} body={error} />;
}

export function kindKey(item: LocalItem): Key {
  if (item.held) return 'kind.held';
  if (item.type === 'grant-request') {
    if (asGrantRequest(item.body)?.action === 'revoke') return 'kind.revoke';
    return 'kind.grant';
  }
  const map: Record<string, Key> = {
    ask: 'kind.ask',
    confirm: 'kind.confirm',
    otp: 'kind.otp',
    message: 'kind.message',
    reply: 'kind.reply',
    answer: 'kind.answer',
  };
  return map[item.type] ?? 'kind.message';
}

/** One line of plain text describing an item's content. */
/** Sealed to an owner key from before the last rotation: this phone no longer has that key. */
export function sealedToOldKey(item: LocalItem): boolean {
  return !item.verified && item.createdAt < getState().ownerKeySince;
}

export function preview(item: LocalItem, names: (id: string) => string): string {
  if (sealedToOldKey(item)) return t('activity.oldKey');
  if (!item.verified) return t('request.unverifiedTitle');
  const body = item.body;
  switch (item.type) {
    case 'ask':
      return asAsk(body)?.question ?? '';
    case 'confirm':
      return asConfirm(body)?.action ?? '';
    case 'otp': {
      const otp = asOtp(body);
      if (!otp) return '';
      return [otp.service, otp.hint].filter(Boolean).join(' · ');
    }
    case 'grant-request': {
      const g = asGrantRequest(body);
      if (!g) return '';
      if (g.action === 'grant') return `${names(g.from)} → ${names(g.to)} · ${g.scopes.join(', ')}`;
      return [g.agentId && names(g.agentId), g.grantId, g.note].filter(Boolean).join(' · ');
    }
    case 'answer':
      return answerText(body);
    default:
      return messageText(body);
  }
}

export function answerText(body: unknown): string {
  const a = asAnswer(body);
  if (!a) return '';
  if (a.answer !== undefined) return a.answer;
  if (a.code !== undefined) return t('chat.codeSent');
  let decided = '';
  if (a.approved === true) decided = t('chat.approved');
  if (a.approved === false) decided = t('chat.denied');
  return [decided, a.note].filter(Boolean).join(' · ');
}

/** Owner ↔ agent items only (agent ↔ agent traffic lives in Activity). */
export function isThreadItem(item: LocalItem, ownerId: string, agentId: string): boolean {
  return (item.from === ownerId && item.to === agentId) || (item.from === agentId && item.to === ownerId);
}

export function presence(agent: AgentSummary, now: number): string {
  if (isOnline(agent.lastSeenAt, now)) return t('presence.online');
  if (agent.lastSeenAt === null) return t('presence.never');
  return t('presence.seen', { time: ago(agent.lastSeenAt, now) });
}
