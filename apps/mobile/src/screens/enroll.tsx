// The confirm sheet: the only moment an agent gets approved, and the defence against someone talking the owner into
// claiming their agent. Shows who is asking, warns plainly, and claims only on an explicit tap (never from a link alone).

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Text } from '@/ui/text';
import { router, useLocalSearchParams } from 'expo-router';
import { ApiError, EnrollmentError, type EnrollmentPreview } from '@catcher/client';
import type { AgentSummary } from '@catcher/protocol';
import { t } from '@/i18n';
import { ago } from '@/lib/format';
import {
  cachedPreview,
  claimCode,
  describeEnrollError,
  freeName,
  lookupCode,
  nameProblem,
  needsNewCode,
  tidyName,
} from '@/state/enroll';
import { useNewest } from '@/state/rooms';
import { useNow } from '@/state/selectors';
import { useApp } from '@/state/store';
import { colors } from '@/ui/colors';
import { Banner, Button, Empty, Field, Group, Info, Screen, SectionTitle, Small, Spinner, tap, Title } from '@/ui/kit';
import { platformOf, providerLabel } from '@/ui/platforms';
import { Avatar } from './sidebar';

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

/** Agents this one could continue: same name first, then same platform, then the rest (newest first). */
function useCandidates(preview: EnrollmentPreview): AgentSummary[] {
  const agents = useApp((s) => s.agents);
  const same = useNewest();
  return useMemo(() => {
    const platform = platformOf(preview.provider)?.id ?? preview.provider;
    const score = (a: AgentSummary) => {
      if (a.agentId === preview.existing?.agentId || a.name === preview.name) return 0;
      if ((platformOf(a.provider)?.id ?? a.provider) === platform) return 1;
      return 2;
    };
    return agents
      .filter((a) => a.cert && !a.removedAt && same(a.agentId) === a.agentId && a.agentId !== preview.agentId)
      .sort((x, y) => score(x) - score(y) || y.createdAt - x.createdAt);
  }, [agents, preview, same]);
}

/** One choice in the "is this an old agent coming back?" list. */
function Option({
  on,
  onPress,
  title,
  sub,
  leading,
  testID,
}: {
  on: boolean;
  onPress: () => void;
  title: string;
  sub?: string;
  leading: ReactNode;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingHorizontal: 16,
        paddingVertical: 10,
        backgroundColor: (pressed && colors.fill) || undefined,
      })}
    >
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '500', color: colors.label }}>
          {title}
        </Text>
        {sub && (
          <Text numberOfLines={1} style={{ fontSize: 14, color: colors.secondaryLabel }}>
            {sub}
          </Text>
        )}
      </View>
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: (on && 7) || 1.5,
          borderColor: (on && colors.ink) || colors.tertiaryLabel,
        }}
      />
    </Pressable>
  );
}

function Preview({ code, preview, changed, onChanged }: PreviewProps) {
  const now = useNow(30_000);
  const agents = useApp((s) => s.agents);
  const candidates = useCandidates(preview);
  const [continues, setContinues] = useState<string | null>(null);
  const old = candidates.find((a) => a.agentId === continues) ?? null;
  // names agents already answer to; the old agent being continued gives its name up
  const taken = agents.filter((a) => a.status === 'active' && a.agentId !== continues).map((a) => a.name);
  const suggested = freeName(preview.name, taken);
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const problem = nameProblem(name, taken);

  const pick = (agentId: string | null) => {
    setContinues(agentId);
    const next = candidates.find((a) => a.agentId === agentId);
    if (next) setName(next.name);
    else setName(suggested);
  };

  const claim = async () => {
    setBusy(true);
    setError(null);
    try {
      const opts: { name: string; continues?: string } = { name };
      if (continues) opts.continues = continues;
      const result = await claimCode(code, opts);
      // close the sheet and the code screen, then show the new agent
      router.dismissAll();
      const params: { agentId: string; connected: string; grantsLeft?: string } = {
        agentId: result.agentId,
        connected: '1',
      };
      if (result.grantsLeft) params.grantsLeft = '1';
      router.push({ pathname: '/agent/[agentId]', params });
    } catch (e) {
      // the registration (or the agent it replaces) changed after the sheet was shown: look again, show it again
      if (e instanceof EnrollmentError && e.code === 'changed') {
        onChanged();
        return;
      }
      setError(e);
      setBusy(false);
    }
  };

  const approve = () => {
    if (!old) {
      void claim();
      return;
    }
    let body = t('enroll.continueBodyGone');
    if (old.status === 'active') body = t('enroll.continueBodyLive');
    Alert.alert(t('enroll.continueTitle', { name: old.name }), body, [
      { text: t('common.close'), style: 'cancel' },
      {
        text: t('enroll.continue'),
        style: (old.status === 'active' && 'destructive') || 'default',
        onPress: () => void claim(),
      },
    ]);
  };

  let label = t('enroll.approve');
  if (old) label = t('enroll.continueAs', { name: old.name });
  const footer = (
    <>
      <Button testID="enroll-approve" label={label} busy={busy} disabled={busy || problem !== null} onPress={approve} />
      <Button testID="enroll-cancel" kind="plain" label={t('enroll.cancel')} disabled={busy} onPress={close} />
    </>
  );

  let nameHint = t('enroll.nameHint');
  if (!old && name === suggested && suggested !== preview.name) {
    nameHint = t('enroll.nameChanged', { name: preview.name });
  }
  const nameTaken = error instanceof ApiError && error.code === 'name_taken';
  let nameError: string | null = problem;
  if (nameTaken) nameError = t('name.taken', { name });

  return (
    <Screen testID="enroll" footer={footer} keyboard>
      <Small>{t('enroll.ask')}</Small>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Avatar name={name || preview.name} provider={preview.provider} size={56} />
        <Text
          testID="enroll-name"
          selectable
          numberOfLines={1}
          style={{ flex: 1, fontSize: 30, lineHeight: 38, fontWeight: '700', color: colors.label }}
        >
          {name || preview.name}
        </Text>
      </View>
      <Group>
        <Info first label={t('field.provider')} value={providerLabel(preview.provider)} />
        <Info label={t('field.device')} value={preview.device} />
        <Info label={t('enroll.made')} value={ago(preview.issuedAt, now)} />
      </Group>
      <Field
        testID="enroll-name-field"
        label={t('field.name')}
        value={name}
        onChangeText={(text) => {
          setName(tidyName(text));
          setError(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={32}
        hint={nameHint}
        error={nameError}
      />
      {candidates.length > 0 && (
        <>
          <SectionTitle>{t('enroll.continueQuestion')}</SectionTitle>
          <Group>
            <Option
              testID="enroll-new"
              on={continues === null}
              onPress={() => pick(null)}
              title={t('enroll.asNew')}
              leading={<Avatar name="+" size={36} />}
            />
            {candidates.map((a) => {
              let state = t('status.revoked');
              if (a.status === 'active') state = t('status.active');
              return (
                <View key={a.agentId}>
                  <View style={{ height: 0.5, marginLeft: 64, backgroundColor: colors.separator }} />
                  <Option
                    testID={`enroll-continue-${a.name}`}
                    on={continues === a.agentId}
                    onPress={() => pick(a.agentId)}
                    title={a.name}
                    sub={`${state} · ${providerLabel(a.provider)} · ${a.device}`}
                    leading={<Avatar name={a.name} agent={a} size={36} surface={colors.card} />}
                  />
                </View>
              );
            })}
          </Group>
          <Small>{t('enroll.continueHint')}</Small>
        </>
      )}
      <Banner tone="warning" title={t('enroll.warnTitle')} body={t('enroll.warnBody')} />
      {changed && <Banner testID="enroll-changed" tone="warning" title={t('enroll.changed')} />}
      {error !== null && !nameTaken && <Banner tone="danger" title={describeEnrollError(error)} />}
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
