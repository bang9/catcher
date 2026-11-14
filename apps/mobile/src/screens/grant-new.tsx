// Create access between two connected agents by hand: who sends, who receives, scopes, approval, expiry.

import { useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SCOPE_PATTERN } from '@catcher/protocol';
import type { Key } from '@/i18n';
import { t } from '@/i18n';
import { describeError } from '@/lib/errors';
import { requireOwner, useApp } from '@/state/store';
import { sync } from '@/state/sync';
import { colors } from '@/ui/colors';
import { Banner, Button, Empty, Field, Group, Row, Screen, SectionTitle, Small, Title } from '@/ui/kit';

const EXPIRY: { key: Key; ms: number | null }[] = [
  { key: 'expiry.none', ms: null },
  { key: 'expiry.hour', ms: 3_600_000 },
  { key: 'expiry.day', ms: 86_400_000 },
  { key: 'expiry.week', ms: 7 * 86_400_000 },
  { key: 'expiry.month', ms: 30 * 86_400_000 },
];

function Picker<T extends string>({
  options,
  value,
  onChange,
  testID,
}: {
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (v: T) => void;
  testID: string;
}) {
  return (
    <Group>
      {options.map((o, i) => (
        <Row
          key={o.value}
          first={i === 0}
          testID={`${testID}-${o.label}`}
          title={o.label}
          accessory={
            value === o.value && <Text style={{ color: colors.accent, fontSize: 17, fontWeight: '600' }}>✓</Text>
          }
          onPress={() => onChange(o.value)}
        />
      ))}
    </Group>
  );
}

function parseScopes(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

export function GrantNewScreen() {
  const params = useLocalSearchParams<{ from?: string }>();
  const agents = useApp((s) => s.agents).filter((a) => a.status === 'active');
  const [from, setFrom] = useState<string | null>(params.from ?? null);
  const [to, setTo] = useState<string | null>(null);
  const [scopes, setScopes] = useState('message');
  const [requireApproval, setRequireApproval] = useState(false);
  const [expiry, setExpiry] = useState<string>('expiry.none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (agents.length < 2) {
    return (
      <Screen>
        <Empty
          title={t('grantNew.needTwo')}
          action={<Button label={t('common.close')} onPress={() => router.back()} />}
        />
      </Screen>
    );
  }

  const list = parseScopes(scopes);
  const badScope = list.find((s) => !SCOPE_PATTERN.test(s));
  let problem: string | null = null;
  if (!from || !to) problem = t('grantNew.pickBoth');
  else if (from === to) problem = t('grantNew.same');
  else if (!list.length) problem = t('grantNew.noScope');
  else if (badScope) problem = t('grantNew.badScope', { scope: badScope });

  const submit = async () => {
    if (problem || !from || !to) return;
    setBusy(true);
    setError(null);
    const ms = EXPIRY.find((e) => e.key === expiry)?.ms ?? null;
    let expiresAt: number | null = null;
    if (ms) expiresAt = Date.now() + ms;
    try {
      await requireOwner().grant({ from, to, scopes: list, requireApproval, expiresAt });
      await sync().catch(() => undefined);
      router.back();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  };

  const options = agents.map((a) => ({ value: a.agentId, label: a.name }));
  let scopeError: string | null = null;
  if (badScope) scopeError = t('grantNew.badScope', { scope: badScope });

  return (
    <Screen
      keyboard
      testID="grant-new"
      footer={
        <>
          {problem && !badScope && <Small>{problem}</Small>}
          <Button
            testID="grant-new-submit"
            label={t('grantNew.submit')}
            busy={busy}
            disabled={problem !== null}
            onPress={() => void submit()}
          />
        </>
      }
    >
      <Title>{t('grantNew.title')}</Title>
      {error && <Banner tone="danger" title={error} />}
      <SectionTitle>{t('field.from')}</SectionTitle>
      <Picker testID="grant-from" options={options} value={from} onChange={setFrom} />
      <SectionTitle>{t('field.to')}</SectionTitle>
      <Picker testID="grant-to" options={options} value={to} onChange={setTo} />
      <Field
        testID="grant-scopes"
        label={t('field.scopes')}
        value={scopes}
        onChangeText={setScopes}
        autoCapitalize="none"
        autoCorrect={false}
        hint={t('grantNew.scopesHint')}
        error={scopeError}
      />
      <Group>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, gap: 12 }}>
          <Text style={{ flex: 1, fontSize: 17, color: colors.label }}>{t('grantNew.requireApproval')}</Text>
          <Switch testID="grant-approval" value={requireApproval} onValueChange={setRequireApproval} />
        </View>
      </Group>
      <SectionTitle>{t('field.expires')}</SectionTitle>
      <Picker
        testID="grant-expiry"
        options={EXPIRY.map((e) => ({ value: e.key as string, label: t(e.key) }))}
        value={expiry}
        onChange={setExpiry}
      />
    </Screen>
  );
}
