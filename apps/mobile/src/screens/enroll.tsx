// The confirm sheet: the only moment an agent gets approved, and the defence against someone talking the owner into
// claiming their agent. Shows who is asking, warns plainly, and claims only on an explicit tap (never from a link alone).

import { useEffect, useState } from 'react';
import { Alert, Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { EnrollmentError, type EnrollmentPreview } from '@catcher/client';
import { t } from '@/i18n';
import { ago } from '@/lib/format';
import { cachedPreview, claimCode, describeEnrollError, lookupCode, needsNewCode } from '@/state/enroll';
import { useNow } from '@/state/selectors';
import { colors } from '@/ui/colors';
import { Banner, Button, Empty, Group, Info, Screen, Small, Spinner, Title } from '@/ui/kit';

type Load = { kind: 'loading' } | { kind: 'ready'; preview: EnrollmentPreview } | { kind: 'failed'; error: unknown };

function close(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/agents');
}

/** Back to the code field with the code kept, so a typo can be fixed in place. */
function editCode(code: string, error: string): void {
  router.replace({ pathname: '/add-agent', params: { code, error } });
}

function Failed({ code, error }: { code: string; error: unknown }) {
  const message = describeEnrollError(error);
  let main = <Button testID="enroll-edit" label={t('enroll.editCode')} onPress={() => editCode(code, message)} />;
  if (needsNewCode(error)) main = <Button testID="enroll-close" label={t('common.close')} onPress={close} />;
  return (
    <Screen testID="enroll-failed" footer={main}>
      <Title>{t('enroll.failedTitle')}</Title>
      <Banner tone="danger" title={message} />
    </Screen>
  );
}

interface PreviewProps {
  code: string;
  preview: EnrollmentPreview;
  /** the sheet was refreshed because the registration changed after it was first shown */
  changed: boolean;
  onChanged: () => void;
}

function Preview({ code, preview, changed, onChanged }: PreviewProps) {
  const now = useNow(30_000);
  const [busy, setBusy] = useState<'claim' | 'replace' | null>(null);
  const [error, setError] = useState<unknown>(null);

  const claim = async (replace: boolean) => {
    setBusy((replace && 'replace') || 'claim');
    setError(null);
    try {
      const { agentId } = await claimCode(code, replace);
      // close the sheet and the code screen, then show the new agent
      router.dismissAll();
      router.push({ pathname: '/agent/[agentId]', params: { agentId, connected: '1' } });
    } catch (e) {
      // the registration (or the agent it replaces) changed after the sheet was shown: look again, show it again
      if (e instanceof EnrollmentError && e.code === 'changed') {
        onChanged();
        return;
      }
      setError(e);
      setBusy(null);
    }
  };

  const existing = preview.existing;
  const confirmReplace = () => {
    if (!existing) return;
    Alert.alert(t('enroll.replaceTitle', { name: existing.name }), t('enroll.replaceBody'), [
      { text: t('common.close'), style: 'cancel' },
      { text: t('enroll.replace'), style: 'destructive', onPress: () => void claim(true) },
    ]);
  };

  let footer = (
    <>
      <Button
        testID="enroll-approve"
        label={t('enroll.approve')}
        busy={busy === 'claim'}
        disabled={busy !== null}
        onPress={() => void claim(false)}
      />
      <Button testID="enroll-cancel" kind="plain" label={t('enroll.cancel')} disabled={busy !== null} onPress={close} />
    </>
  );
  // same name already connected: a plain approve cannot work, and replacing cuts the old one off — make it deliberate
  if (existing) {
    footer = (
      <>
        <Button
          testID="enroll-replace"
          kind="danger"
          label={t('enroll.replace')}
          busy={busy === 'replace'}
          disabled={busy !== null}
          onPress={confirmReplace}
        />
        <Button
          testID="enroll-cancel"
          kind="plain"
          label={t('enroll.cancel')}
          disabled={busy !== null}
          onPress={close}
        />
      </>
    );
  }

  return (
    <Screen testID="enroll" footer={footer}>
      <Small>{t('enroll.ask')}</Small>
      <Text
        testID="enroll-name"
        selectable
        style={{ fontSize: 34, lineHeight: 41, fontWeight: '700', color: colors.label }}
      >
        {preview.name}
      </Text>
      <Group>
        <Info first label={t('field.device')} value={preview.device} />
        <Info label={t('field.provider')} value={preview.provider} />
        <Info label={t('enroll.made')} value={ago(preview.issuedAt, now)} />
      </Group>
      <Banner tone="warning" title={t('enroll.warnTitle')} body={t('enroll.warnBody')} />
      {existing && (
        <Banner
          tone="danger"
          title={t('enroll.existingTitle', { name: existing.name })}
          body={t('enroll.existingBody', { device: existing.device, provider: existing.provider })}
        />
      )}
      {changed && <Banner testID="enroll-changed" tone="warning" title={t('enroll.changed')} />}
      {error !== null && <Banner tone="danger" title={describeEnrollError(error)} />}
      <Small color={colors.tertiaryLabel}>{`${t('enroll.fingerprint')} ${preview.fingerprint}`}</Small>
    </Screen>
  );
}

export function EnrollScreen() {
  const { code = '' } = useLocalSearchParams<{ code?: string }>();
  const [load, setLoad] = useState<Load>(() => {
    const cached = cachedPreview(code);
    if (cached) return { kind: 'ready', preview: cached };
    return { kind: 'loading' };
  });
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    if (load.kind !== 'loading') return;
    let live = true;
    // opened from a link: check the code first; this only looks it up, it never claims
    lookupCode(code)
      .then((preview) => {
        if (live) setLoad({ kind: 'ready', preview });
      })
      .catch((error: unknown) => {
        if (live) setLoad({ kind: 'failed', error });
      });
    return () => {
      live = false;
    };
  }, [code, load.kind]);

  if (!code) return <Empty title={t('enroll.failedTitle')} />;
  if (load.kind === 'loading') {
    return (
      <Screen testID="enroll-loading">
        <Spinner />
      </Screen>
    );
  }
  if (load.kind === 'failed') return <Failed code={code} error={load.error} />;
  return (
    <Preview
      code={code}
      preview={load.preview}
      changed={changed}
      onChanged={() => {
        setChanged(true);
        setLoad({ kind: 'loading' });
      }}
    />
  );
}
