// Relay address. Before onboarding: pick where the new account lives. After: move to another address of the
// same relay (only if the account is found there).

import { useState } from 'react';
import { router } from 'expo-router';
import { ApiError, OwnerClient } from '@catcher/client';
import { setKv } from '@/lib/db';
import { describeError } from '@/lib/errors';
import { DEFAULT_SERVER, normalizeServer } from '@/lib/format';
import { saveOwnerState } from '@/lib/secure';
import { chooseServer, chosenServer, isCatcherServer } from '@/lib/server';
import { t } from '@/i18n';
import { restartRealtime } from '@/state/realtime';
import { getState, setState } from '@/state/store';
import { makeClient, syncQuietly } from '@/state/sync';
import { Button, Field, Lede, Screen, Title } from '@/ui/kit';

async function moveOwner(url: string): Promise<string | null> {
  const owner = getState().owner;
  if (!owner) return null;
  try {
    const found = await OwnerClient.restore(url, owner.recoveryCode());
    if (found.ownerId !== owner.state.ownerId) return t('server.ownerMissing');
    const next = { ...owner.state, server: url, seq: Math.max(owner.state.seq, found.seq) };
    saveOwnerState(next);
    // cursors belong to one relay: read the new one from the start (ids dedupe what we already have)
    setKv('cursor', '0');
    setState({ owner: makeClient(next) });
    restartRealtime();
    syncQuietly();
    return null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return t('server.ownerMissing');
    return describeError(e);
  }
}

export function ServerScreen() {
  const owner = getState().owner;
  let initial = chosenServer();
  if (owner) initial = owner.state.server;
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const url = normalizeServer(text);
    if (!url) {
      setError(t('server.invalid'));
      return;
    }
    setBusy(true);
    setError(null);
    if (!(await isCatcherServer(url))) {
      setBusy(false);
      setError(t('server.unreachable'));
      return;
    }
    if (owner) {
      const problem = await moveOwner(url);
      setBusy(false);
      if (problem) {
        setError(problem);
        return;
      }
      router.back();
      return;
    }
    chooseServer(url);
    setBusy(false);
    router.back();
  };

  let lede = t('server.lede');
  if (owner) lede = t('server.moveLede');

  return (
    <Screen
      keyboard
      testID="server"
      footer={
        <>
          <Button
            testID="server-save"
            label={t('server.save')}
            busy={busy}
            disabled={text.trim() === initial}
            onPress={save}
          />
          {!owner && text !== DEFAULT_SERVER && (
            <Button kind="plain" label={t('server.reset')} onPress={() => setText(DEFAULT_SERVER)} />
          )}
        </>
      }
    >
      <Title>{t('server.title')}</Title>
      <Lede>{lede}</Lede>
      <Field
        testID="server-input"
        value={text}
        onChangeText={(v) => {
          setText(v);
          setError(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder={DEFAULT_SERVER}
        error={error}
      />
    </Screen>
  );
}
