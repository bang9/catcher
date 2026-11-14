// Pairing: get an 8-character code (10 minutes), show the exact command to paste, and list registrations as
// they come in so the person can go straight to comparing fingerprints.

import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { NAME_PATTERN } from '@catcher/protocol';
import { t } from '@/i18n';
import { describeError } from '@/lib/errors';
import { countdown, groupedCode } from '@/lib/format';
import { useNow } from '@/state/selectors';
import { requireOwner, useApp } from '@/state/store';
import { sync } from '@/state/sync';
import { colors, mono } from '@/ui/colors';
import {
  Banner,
  Button,
  CopyButton,
  Field,
  Group,
  Lede,
  Pill,
  Row,
  Screen,
  SectionTitle,
  Small,
  Spinner,
} from '@/ui/kit';

interface Pairing {
  code: string;
  expiresAt: number;
}

export function AddAgentScreen() {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('my-agent');
  const now = useNow(1000);
  const pending = useApp((s) => s.agents).filter((a) => a.status === 'pending');

  const fresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setPairing(await requireOwner().createPairing());
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void fresh();
  }, [fresh]);

  const nameOk = NAME_PATTERN.test(name);
  let nameError: string | null = null;
  if (!nameOk) nameError = t('add.nameHint');
  const expired = pairing !== null && pairing.expiresAt <= now;

  if (!pairing) {
    return (
      <Screen footer={error && <Button label={t('common.retry')} busy={busy} onPress={() => void fresh()} />}>
        <Lede>{t('add.lede')}</Lede>
        {error && <Banner tone="danger" title={error} />}
        {!error && <Spinner />}
      </Screen>
    );
  }

  const command = `catcher register --code ${pairing.code} --name ${(nameOk && name) || '<name>'}`;

  let footer = <CopyButton testID="add-copy" value={command} label={t('add.copy')} />;
  if (expired)
    footer = <Button testID="add-new-code" label={t('add.newCode')} busy={busy} onPress={() => void fresh()} />;

  return (
    <Screen keyboard testID="add-agent" onRefresh={sync} footer={footer}>
      <Lede>{t('add.lede')}</Lede>
      {error && <Banner tone="danger" title={error} />}
      <View style={{ alignItems: 'center', gap: 6 }}>
        <Small>{t('add.code')}</Small>
        <Text
          testID="add-code"
          selectable
          style={{
            fontFamily: mono,
            fontSize: 40,
            fontWeight: '700',
            letterSpacing: 4,
            color: (expired && colors.tertiaryLabel) || colors.label,
          }}
        >
          {groupedCode(pairing.code)}
        </Text>
        {!expired && <Pill label={t('add.left', { time: countdown(pairing.expiresAt - now) })} tone="info" />}
        {expired && <Pill label={t('add.expired')} tone="danger" />}
      </View>
      <Field
        testID="add-name"
        label={t('add.name')}
        value={name}
        onChangeText={(v) => setName(v.toLowerCase().replace(/\s+/g, '-'))}
        autoCapitalize="none"
        autoCorrect={false}
        error={nameError}
      />
      <Group style={{ padding: 16 }}>
        <Text
          selectable
          testID="add-command"
          style={{ fontFamily: mono, fontSize: 14, lineHeight: 20, color: colors.label }}
        >
          {command}
        </Text>
      </Group>
      <SectionTitle>{t('add.incoming')}</SectionTitle>
      <Group>
        {pending.length === 0 && <Row first title={t('add.waiting')} subtitle="…" />}
        {pending.map((a, i) => (
          <Row
            key={a.agentId}
            first={i === 0}
            testID={`add-pending-${a.name}`}
            title={a.name}
            subtitle={`${a.provider} · ${a.device}`}
            accessory={<Pill label={t('kind.registration')} tone="info" />}
            onPress={() => router.push({ pathname: '/registration/[agentId]', params: { agentId: a.agentId } })}
          />
        ))}
      </Group>
    </Screen>
  );
}
