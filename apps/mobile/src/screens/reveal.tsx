// Recovery code, shown only after device authentication (Face ID / Touch ID / passcode).

import { useState } from 'react';
import { Alert } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { t } from '@/i18n';
import { useApp } from '@/state/store';
import { Banner, Button, Code, Lede, Screen, Title } from '@/ui/kit';

async function unlock(): Promise<'ok' | 'failed' | 'no-lock'> {
  const level = await LocalAuthentication.getEnrolledLevelAsync();
  if (level === LocalAuthentication.SecurityLevel.NONE) return 'no-lock';
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: t('reveal.prompt'),
    disableDeviceFallback: false,
  });
  if (result.success) return 'ok';
  return 'failed';
}

export function RevealScreen() {
  const owner = useApp((s) => s.owner);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!owner) return null;

  const reveal = async () => {
    setError(null);
    const result = await unlock();
    if (result === 'ok') {
      setShown(true);
      return;
    }
    if (result === 'failed') {
      setError(t('reveal.failed'));
      return;
    }
    // no screen lock at all: the code is no safer behind a prompt that cannot be shown; say so and let them choose
    Alert.alert(t('reveal.title'), t('reveal.noLock'), [
      { text: t('common.close'), style: 'cancel' },
      { text: t('reveal.showAnyway'), onPress: () => setShown(true) },
    ]);
  };

  if (!shown) {
    return (
      <Screen
        testID="reveal"
        footer={<Button testID="reveal-unlock" label={t('reveal.button')} onPress={() => void reveal()} />}
      >
        <Title>{t('reveal.prompt')}</Title>
        <Lede>{t('recovery.secret')}</Lede>
        {error && <Banner tone="danger" title={error} />}
      </Screen>
    );
  }
  const code = owner.recoveryCode();
  return (
    <Screen testID="reveal-shown">
      <Code testID="reveal-code" value={code} size={20} />
      <Banner tone="danger" title={t('recovery.warning')} body={t('recovery.secret')} />
    </Screen>
  );
}
