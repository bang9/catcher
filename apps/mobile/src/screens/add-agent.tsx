// Add an agent: type or paste the code the agent printed (a pasted link works too). Local typos show inline before
// anything is sent; the code is then checked against the relay and the confirm sheet opens.

import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { t } from '@/i18n';
import { codeIsComplete, describeEnrollError, formatCodeInput, localCodeProblem, lookupCode } from '@/state/enroll';
import { mono } from '@/ui/colors';
import { Banner, Button, Field, Lede, Screen, Small, Title } from '@/ui/kit';

export function AddAgentScreen() {
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const [code, setCode] = useState(formatCodeInput(params.code ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.error ?? null);

  const complete = codeIsComplete(code);
  // typo hints only once all 16 characters are in, so nobody is scolded mid-typing
  let inline: string | null = null;
  if (complete) inline = localCodeProblem(code);

  const next = async () => {
    const problem = localCodeProblem(code);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await lookupCode(code);
      router.push({ pathname: '/enroll', params: { code } });
    } catch (e) {
      setError(describeEnrollError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      keyboard
      testID="add-agent"
      footer={
        <Button
          testID="add-next"
          label={t('add.next')}
          busy={busy}
          disabled={!complete || inline !== null}
          onPress={() => void next()}
        />
      }
    >
      <Title>{t('add.title')}</Title>
      <Lede>{t('add.lede')}</Lede>
      <Field
        testID="add-code"
        value={code}
        onChangeText={(v) => {
          setCode(formatCodeInput(v));
          setError(null);
        }}
        placeholder="XXXX-XXXX-XXXX-XXXX"
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        autoFocus
        error={inline}
        style={{ fontFamily: mono, fontSize: 22, letterSpacing: 1, textAlign: 'center' }}
      />
      {error && <Banner tone="danger" title={error} />}
      <Small>{t('add.where')}</Small>
    </Screen>
  );
}
