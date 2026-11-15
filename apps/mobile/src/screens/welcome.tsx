// First launch: what catcher does, then one main action (start). Restore is the quieter option; the relay server is a
// setting (Settings → Server), not something a new owner should have to think about here.

import { useState } from 'react';
import { Image } from 'react-native';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { describeError } from '@/lib/errors';
import { chosenServer } from '@/lib/server';
import { t } from '@/i18n';
import { useApp } from '@/state/store';
import { createOwner } from '@/state/sync';
import { Banner, Button, Lede, Screen, Title } from '@/ui/kit';

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
      bare
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
        </>
      }
    >
      {/* the app icon: the one brand moment on an otherwise black-and-white screen */}
      <Image
        source={require('../../assets/icon.png')}
        accessibilityIgnoresInvertColors
        style={{ width: 56, height: 56, borderRadius: 14, borderCurve: 'continuous' }}
      />
      <Title>{t('welcome.title')}</Title>
      <Lede>{t('welcome.lede')}</Lede>
      {error && <Banner tone="danger" title={error} />}
    </Screen>
  );
}
