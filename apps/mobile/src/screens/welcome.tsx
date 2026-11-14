// First launch: what catcher does, then one main action (start). Restore and server are quieter options.

import { useState } from 'react';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { describeError } from '@/lib/errors';
import { chosenServer } from '@/lib/server';
import { t } from '@/i18n';
import { useApp } from '@/state/store';
import { createOwner } from '@/state/sync';
import { Banner, Button, Lede, Screen, Small, Title } from '@/ui/kit';

export function WelcomeScreen() {
  const owner = useApp((s) => s.owner);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState(chosenServer());
  useFocusEffect(useCallback(() => setServer(chosenServer()), []));

  // created a key but quit before saving the recovery code: continue there
  if (owner) return <Redirect href="/recovery-code" />;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await createOwner(server);
      router.replace('/recovery-code');
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      testID="welcome"
      footer={
        <>
          <Button testID="welcome-start" label={t('welcome.start')} busy={busy} onPress={start} />
          <Button
            testID="welcome-restore"
            kind="plain"
            label={t('welcome.restore')}
            onPress={() => router.push('/restore')}
          />
          <Button
            kind="plain"
            label={t('welcome.server', { server: server.replace(/^https?:\/\//, '') })}
            onPress={() => router.push('/server')}
          />
        </>
      }
    >
      <Title>
        {'\n'}
        {t('welcome.title')}
      </Title>
      <Lede>{t('welcome.lede')}</Lede>
      {error && <Banner tone="danger" title={error} />}
      <Small> </Small>
    </Screen>
  );
}
