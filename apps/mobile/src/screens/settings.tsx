// Settings: owner fingerprint, recovery code (behind device auth), key rotation, push, server, version.

import { useState } from 'react';
import { Switch } from 'react-native';
import * as Application from 'expo-application';
import { router } from 'expo-router';
import { t } from '@/i18n';
import { disablePush, enablePush, pushEnabled } from '@/state/push';
import { useApp } from '@/state/store';
import { Banner, Code, Group, Info, Row, Screen, SectionTitle, Small } from '@/ui/kit';

export function SettingsScreen() {
  const owner = useApp((s) => s.owner);
  const [push, setPush] = useState(pushEnabled());
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  if (!owner) return null;

  const togglePush = async (on: boolean) => {
    setPushBusy(true);
    setPushMessage(null);
    let result = await disablePush();
    if (on) result = await enablePush();
    setPushBusy(false);
    if (!result.ok) {
      setPushMessage(result.message);
      return;
    }
    setPush(on);
  };

  const version = `${Application.nativeApplicationVersion ?? '?'} (${Application.nativeBuildVersion ?? '?'})`;

  return (
    <Screen testID="settings">
      <SectionTitle>{t('settings.fingerprint')}</SectionTitle>
      <Code testID="settings-fingerprint" value={owner.fingerprint()} size={20} />
      <Small>{t('settings.fingerprintHint')}</Small>

      <SectionTitle>{t('settings.security')}</SectionTitle>
      <Group>
        <Row first testID="settings-recovery" title={t('settings.recovery')} onPress={() => router.push('/reveal')} />
        <Row testID="settings-rotate" title={t('settings.rotate')} onPress={() => router.push('/rotate')} />
      </Group>

      <SectionTitle>{t('settings.app')}</SectionTitle>
      <Group>
        <Row
          first
          title={t('settings.push')}
          accessory={
            <Switch testID="settings-push" value={push} disabled={pushBusy} onValueChange={(v) => void togglePush(v)} />
          }
        />
        <Row
          testID="settings-server"
          title={t('settings.server')}
          subtitle={owner.state.server}
          onPress={() => router.push('/move-server')}
        />
        <Info label={t('settings.version')} value={version} />
      </Group>
      {pushMessage && <Banner title={pushMessage} />}
    </Screen>
  );
}
