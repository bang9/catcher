// New phone: type the recovery code, find the owner on the relay, carry on.

import { useState } from 'react';
import { describeRestoreError } from '@/lib/errors';
import { cleanRecoveryInput, recoveryLooksComplete } from '@/lib/format';
import { chosenServer } from '@/lib/server';
import { t } from '@/i18n';
import { restoreOwner } from '@/state/sync';
import { mono } from '@/ui/colors';
import { Button, Field, Lede, Screen, Title } from '@/ui/kit';

export function RestoreScreen() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // the guard in the root layout switches to the app once the owner is set
      await restoreOwner(chosenServer(), code);
    } catch (e) {
      setError(describeRestoreError(e));
      setBusy(false);
    }
  };

  return (
    <Screen
      keyboard
      testID="restore"
      footer={
        <Button
          testID="restore-submit"
          label={t('restore.submit')}
          busy={busy}
          disabled={!recoveryLooksComplete(code)}
          onPress={submit}
        />
      }
    >
      <Title>{t('restore.title')}</Title>
      <Lede>{t('restore.lede')}</Lede>
      <Field
        testID="restore-input"
        value={code}
        onChangeText={(text) => {
          setCode(cleanRecoveryInput(text));
          setError(null);
        }}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        multiline
        error={error}
        placeholder="XXXXX-XXXXX-XXXXX-…"
        style={{ fontFamily: mono, minHeight: 120, textAlignVertical: 'top' }}
      />
    </Screen>
  );
}
