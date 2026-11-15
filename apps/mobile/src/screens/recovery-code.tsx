// Right after creating the key: show the recovery code once, explain what losing it means, confirm it is saved.

import { Alert } from 'react-native';
import { Redirect, router } from 'expo-router';
import { t } from '@/i18n';
import { useApp } from '@/state/store';
import { Banner, Button, Code, Lede, Screen, Title } from '@/ui/kit';

function saved() {
  Alert.alert(t('recovery.confirmTitle'), t('recovery.confirmBody'), [
    { text: t('common.close'), style: 'cancel' },
    { text: t('recovery.confirmYes'), onPress: () => router.replace('/notifications') },
  ]);
}

export function RecoveryCodeScreen() {
  const owner = useApp((s) => s.owner);
  if (!owner) return <Redirect href="/welcome" />;
  const code = owner.recoveryCode();

  return (
    <Screen
      bare
      testID="recovery-code"
      footer={<Button testID="recovery-saved" label={t('recovery.saved')} onPress={saved} />}
    >
      <Title>{t('recovery.title')}</Title>
      <Lede>{t('recovery.lede')}</Lede>
      <Code testID="recovery-code-value" value={code} size={20} />
      <Banner tone="danger" title={t('recovery.warning')} body={t('recovery.secret')} />
    </Screen>
  );
}
