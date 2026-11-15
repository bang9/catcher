// One agent: fingerprint, certificate, grants from/to it, chat, create access, disconnect.

import { useState } from 'react';
import { Alert } from 'react-native';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { t } from '@/i18n';
import { describeError } from '@/lib/errors';
import { ago, shortDate } from '@/lib/format';
import { useNow } from '@/state/selectors';
import { type GrantView, requireOwner, useApp } from '@/state/store';
import { sync } from '@/state/sync';
import { Banner, Button, Code, Empty, Group, Info, Pill, Row, Screen, SectionTitle } from '@/ui/kit';
import { statusLabel } from './agents';

function grantLine(g: GrantView): string {
  const parts = [g.scopes.join(', ')];
  if (g.requireApproval) parts.push(t('grant.requireApproval'));
  if (g.expiresAt) parts.push(t('grant.until', { date: shortDate(g.expiresAt) }));
  return parts.join(' · ');
}

function GrantList({
  grants,
  names,
  side,
  onRevoke,
}: {
  grants: GrantView[];
  names: (id: string) => string;
  side: 'from' | 'to';
  onRevoke: (g: GrantView) => void;
}) {
  if (!grants.length) {
    return (
      <Group>
        <Row first title={t('agent.noGrants')} />
      </Group>
    );
  }
  return (
    <Group>
      {grants.map((g, i) => {
        let other = names(g.to);
        if (side === 'to') other = names(g.from);
        let tag = null;
        if (g.revoked) tag = <Pill label={t('grant.revoked')} tone="danger" />;
        else if (g.expired) tag = <Pill label={t('grant.expired')} />;
        const live = !g.revoked && !g.expired;
        return (
          <Row
            key={g.grantId}
            first={i === 0}
            testID={`grant-row-${g.grantId}`}
            title={other}
            subtitle={grantLine(g)}
            accessory={tag}
            onPress={(live && (() => onRevoke(g))) || undefined}
          />
        );
      })}
    </Group>
  );
}

export function AgentScreen() {
  const { agentId, connected } = useLocalSearchParams<{ agentId: string; connected?: string }>();
  const agent = useApp((s) => s.agents.find((a) => a.agentId === agentId));
  const agents = useApp((s) => s.agents);
  const grants = useApp((s) => s.grants);
  const owner = useApp((s) => s.owner);
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!agent || !owner) {
    return (
      <Screen onRefresh={sync}>
        <Empty title={t('agent.missing')} />
      </Screen>
    );
  }

  const names = (id: string) => agents.find((a) => a.agentId === id)?.name ?? id;
  const from = grants.filter((g) => g.from === agent.agentId);
  const to = grants.filter((g) => g.to === agent.agentId);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await sync().catch(() => undefined);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const revokeGrant = (g: GrantView) => {
    Alert.alert(
      t('grant.revokeConfirmTitle'),
      t('grant.revokeConfirmBody', { from: names(g.from), to: names(g.to), scopes: g.scopes.join(', ') }),
      [
        { text: t('common.close'), style: 'cancel' },
        {
          text: t('grant.revokeApprove'),
          style: 'destructive',
          onPress: () => void act(() => requireOwner().revoke({ grants: [g.grantId] })),
        },
      ],
    );
  };

  const revokeAgent = () => {
    Alert.alert(t('agent.revokeTitle', { name: agent.name }), t('agent.revokeBody'), [
      { text: t('common.close'), style: 'cancel' },
      {
        text: t('agent.revoke'),
        style: 'destructive',
        onPress: () => void act(() => requireOwner().revoke({ agents: [agent.agentId] })),
      },
    ]);
  };

  let lastSeen = t('presence.never');
  if (agent.lastSeenAt) lastSeen = ago(agent.lastSeenAt, now);
  let certExpiry = '—';
  if (agent.cert) certExpiry = shortDate(agent.cert.payload.expiresAt);
  const active = agent.status === 'active';

  let footer = null;
  if (active) {
    footer = (
      <Button
        testID="agent-chat"
        label={t('agent.chat')}
        onPress={() => router.push({ pathname: '/chat/[agentId]', params: { agentId: agent.agentId } })}
      />
    );
  }

  return (
    <Screen testID="agent-detail" onRefresh={sync} footer={footer}>
      <Stack.Screen options={{ title: agent.name }} />
      {connected === '1' && active && (
        <Banner
          testID="agent-connected"
          tone="info"
          title={t('agent.connectedTitle')}
          body={t('agent.connectedBody')}
        />
      )}
      {error && <Banner tone="danger" title={error} />}
      <SectionTitle>{t('field.fingerprint')}</SectionTitle>
      <Code testID="agent-fingerprint" value={owner.agentFingerprint(agent)} size={22} />
      <Group>
        <Info first label={t('field.status')} value={statusLabel(agent.status)} />
        <Info label={t('field.provider')} value={agent.provider} />
        <Info label={t('field.device')} value={agent.device} />
        <Info label={t('field.lastSeen')} value={lastSeen} />
        <Info label={t('field.certExpiry')} value={certExpiry} />
        <Info label={t('field.registered')} value={shortDate(agent.createdAt)} />
      </Group>
      {active && (
        <>
          <SectionTitle>{t('agent.grantsFrom')}</SectionTitle>
          <GrantList grants={from} names={names} side="from" onRevoke={revokeGrant} />
          <SectionTitle>{t('agent.grantsTo')}</SectionTitle>
          <GrantList grants={to} names={names} side="to" onRevoke={revokeGrant} />
          <Button
            testID="agent-new-grant"
            kind="secondary"
            label={t('link.title')}
            onPress={() => router.push({ pathname: '/link', params: { a: agent.agentId } })}
          />
          <Button testID="agent-revoke" kind="danger" label={t('agent.revoke')} busy={busy} onPress={revokeAgent} />
        </>
      )}
    </Screen>
  );
}
