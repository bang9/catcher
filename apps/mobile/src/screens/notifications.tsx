// Last onboarding step: offer push, with the reason first. "Not now" is a real choice.

import { useState } from 'react';
import { router } from 'expo-router';
import { t } from '@/i18n';
import { enablePush } from '@/state/push';
import { finishOnboarding } from '@/state/sync';
import { Banner, Button, Lede, Screen, Title } from '@/ui/kit';

function done() {
  finishOnboarding();
  router.replace('/');
}

export function NotificationsScreen() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const enable = async () => {
    setBusy(true);
    const result = await enablePush();
    setBusy(false);
    if (result.ok) {
      done();
      return;
    }
    setMessage(result.message);
  };

  let main = <Button testID="push-enable" label={t('push.enable')} busy={busy} onPress={enable} />;
  // push could not be turned on here: moving on is the only useful action
  if (message) main = <Button testID="push-continue" label={t('common.done')} onPress={done} />;

  return (
    <Screen
      bare
      testID="notifications"
      footer={
        <>
          {main}
          {!message && <Button testID="push-later" kind="plain" label={t('push.later')} onPress={done} />}
        </>
      }
    >
      <Title>{t('push.title')}</Title>
      <Lede>{t('push.lede')}</Lede>
      {message && <Banner title={message} />}
    </Screen>
  );
}
