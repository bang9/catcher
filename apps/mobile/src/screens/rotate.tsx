// Owner key rotation: explain, confirm, drain the feed with the old key, rotate, then show the new recovery code.

import { useState } from 'react';
import { Alert, View } from 'react-native';
import { Text } from '@/ui/text';
import { router } from 'expo-router';
import { t } from '@/i18n';
import { describeError } from '@/lib/errors';
import { restartRealtime } from '@/state/realtime';
import { requireOwner, setState } from '@/state/store';
import { makeClient, sync } from '@/state/sync';
import { colors } from '@/ui/colors';
import { Banner, Button, Code, Lede, Screen, Title } from '@/ui/kit';

function Point({ text }: { text: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <Text style={{ fontSize: 16, color: colors.secondaryLabel }}>•</Text>
      <Text style={{ flex: 1, fontSize: 16, lineHeight: 23, color: colors.label }}>{text}</Text>
    </View>
  );
}

export function RotateScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);

  const rotate = async () => {
    setBusy(true);
    setError(null);
    try {
      // everything already on the relay is opened with the old key first (owner-sent rows verify against it)
      await sync();
      const owner = requireOwner();
      const next = await owner.rotateKey();
      // a fresh client object so every screen re-renders with the new key (fingerprint, recovery code)
      setState({ owner: makeClient(owner.state) });
      setCode(next);
      restartRealtime();
      await sync().catch(() => undefined);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    Alert.alert(t('rotate.confirmTitle'), t('rotate.confirmBody'), [
      { text: t('common.close'), style: 'cancel' },
      { text: t('rotate.submit'), style: 'destructive', onPress: () => void rotate() },
    ]);
  };

  if (code) {
    return (
      <Screen testID="rotate-done" footer={<Button label={t('recovery.saved')} onPress={() => router.back()} />}>
        <Title>{t('rotate.doneTitle')}</Title>
        <Code testID="rotate-code" value={code} size={20} />
        <Banner tone="danger" title={t('recovery.warning')} body={t('recovery.secret')} />
      </Screen>
    );
  }

  return (
    <Screen
      testID="rotate"
      footer={<Button testID="rotate-submit" label={t('rotate.submit')} busy={busy} onPress={confirm} />}
    >
      <Title>{t('rotate.title')}</Title>
      <Lede>{t('rotate.lede')}</Lede>
      <View style={{ gap: 10 }}>
        <Point text={t('rotate.point1')} />
        <Point text={t('rotate.point2')} />
        <Point text={t('rotate.point3')} />
      </View>
      {error && <Banner tone="danger" title={error} />}
    </Screen>
  );
}
