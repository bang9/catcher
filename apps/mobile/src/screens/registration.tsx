// Approve a new agent: the person compares the fingerprint with what `catcher register` printed.
// Approving signs the agent's certificate with the owner key.

import { useState } from 'react';
import { Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { t } from '@/i18n';
import { describeError } from '@/lib/errors';
import { useApp } from '@/state/store';
import { sync } from '@/state/sync';
import { Banner, Button, Code, Empty, Group, Info, Lede, Screen, SectionTitle, Small, Title } from '@/ui/kit';

export function RegistrationScreen() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const owner = useApp((s) => s.owner);
  const agent = useApp((s) => s.agents.find((a) => a.agentId === agentId));
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!owner || !agent)
    return (
      <Screen onRefresh={sync}>
        <Empty title={t('agent.missing')} />
      </Screen>
    );
  if (agent.status !== 'pending') {
    return (
      <Screen>
        <Empty
          title={t('registration.done')}
          action={<Button label={t('common.close')} onPress={() => router.back()} />}
        />
      </Screen>
    );
  }

  const run = async (kind: 'approve' | 'reject') => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'approve') await owner.approveAgent(agent);
      if (kind === 'reject') await owner.rejectAgent(agent.agentId);
      await sync().catch(() => undefined);
      router.back();
    } catch (e) {
      setError(describeError(e));
      setBusy(null);
    }
  };

  const reject = () => {
    Alert.alert(t('registration.rejectTitle'), t('registration.rejectBody'), [
      { text: t('common.close'), style: 'cancel' },
      { text: t('registration.reject'), style: 'destructive', onPress: () => void run('reject') },
    ]);
  };

  return (
    <Screen
      testID="registration"
      footer={
        <>
          <Button
            testID="registration-approve"
            label={t('registration.approve')}
            busy={busy === 'approve'}
            disabled={busy !== null}
            onPress={() => void run('approve')}
          />
          <Button
            testID="registration-reject"
            kind="plain"
            label={t('registration.reject')}
            disabled={busy !== null}
            onPress={reject}
          />
        </>
      }
    >
      <Title>{t('registration.title')}</Title>
      <Lede>{t('registration.lede')}</Lede>
      {error && <Banner tone="danger" title={error} />}
      <SectionTitle>{t('registration.agentFingerprint')}</SectionTitle>
      <Code testID="registration-fingerprint" value={owner.agentFingerprint(agent)} size={26} />
      <Small>{t('registration.mismatch')}</Small>
      <Group>
        <Info first label={t('field.name')} value={agent.name} />
        <Info label={t('field.provider')} value={agent.provider} />
        <Info label={t('field.device')} value={agent.device} />
      </Group>
      <SectionTitle>{t('registration.ownerFingerprint')}</SectionTitle>
      <Code value={owner.fingerprint()} size={17} />
    </Screen>
  );
}
