// First launch: what catcher does, then one main action (start). Restore is the quieter option. Running your own relay
// is for few people, so it sits behind the gear in the corner (the account is made on the relay picked here), and the
// address only shows once it is not the default.

import { useState } from 'react';
import { Image, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { describeError } from '@/lib/errors';
import { DEFAULT_SERVER } from '@/lib/format';
import { chosenServer } from '@/lib/server';
import { t } from '@/i18n';
import { useApp } from '@/state/store';
import { createOwner } from '@/state/sync';
import { colors } from '@/ui/colors';
import { Banner, Button, EDGE, GLYPH, HIT, Icon, IconButton, Lede, Screen, Small, Title } from '@/ui/kit';

export function WelcomeScreen() {
  const owner = useApp((s) => s.owner);
  const insets = useSafeAreaInsets();
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

  const custom = server !== DEFAULT_SERVER;
  return (
    <View style={{ flex: 1 }}>
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
        {custom && <Small>{t('welcome.server', { server: server.replace(/^https?:\/\//, '') })}</Small>}
        {error && <Banner tone="danger" title={error} />}
      </Screen>
      {/* the relay this account will live on: a corner setting, glyph on the 16 edge */}
      <View style={{ position: 'absolute', top: insets.top + 6, right: EDGE - (HIT - GLYPH) / 2 }}>
        <IconButton testID="welcome-server" label={t('settings.server')} onPress={() => router.push('/server')}>
          <Icon ios="gearshape" android="settings" color={colors.secondaryLabel} />
        </IconButton>
      </View>
    </View>
  );
}
