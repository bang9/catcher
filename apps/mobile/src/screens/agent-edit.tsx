// A connected agent's name and platform. The name is a nickname: other agents reach it by this name, and the owner
// can change it whenever (a new owner-signed cert). The platform picks the icon it shows with.

import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ApiError } from '@catcher/client';
import { t } from '@/i18n';
import { describeError } from '@/lib/errors';
import { updateAgent } from '@/state/actions';
import { nameProblem, tidyName } from '@/state/enroll';
import { useApp } from '@/state/store';
import { Banner, Button, Empty, Field, Screen, SectionTitle, Small, Title } from '@/ui/kit';
import { PLATFORMS, platformOf } from '@/ui/platforms';
import { Choice } from './link';

export function AgentEditScreen() {
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const agent = useApp((s) => s.agents.find((a) => a.agentId === agentId));
  const agents = useApp((s) => s.agents);
  const [name, setName] = useState(agent?.name ?? '');
  // a known platform is saved under its own id; anything else stays as the agent wrote it
  const [provider, setProvider] = useState(platformOf(agent?.provider)?.id ?? agent?.provider ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!agent) return <Empty title={t('agent.missing')} />;

  const taken = agents.filter((a) => a.status === 'active' && a.agentId !== agent.agentId).map((a) => a.name);
  let nameError = nameProblem(name, taken);
  if (error instanceof ApiError && error.code === 'name_taken') nameError = t('name.taken', { name });
  const original = platformOf(agent.provider)?.id ?? agent.provider;
  const options = PLATFORMS.map((p) => ({ value: p.id, label: p.label }));
  if (!platformOf(agent.provider)) options.push({ value: agent.provider, label: agent.provider });
  const unchanged = name === agent.name && provider === original;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const change: { name?: string; provider?: string } = {};
      if (name !== agent.name) change.name = name;
      if (provider !== original) change.provider = provider;
      await updateAgent(agent.agentId, change);
      router.back();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const footer = (
    <Button
      testID="agent-edit-save"
      label={t('agentEdit.save')}
      busy={busy}
      disabled={busy || unchanged || nameError !== null}
      onPress={() => void save()}
    />
  );
  const nameTaken = error instanceof ApiError && error.code === 'name_taken';
  return (
    <Screen testID="agent-edit-screen" footer={footer} keyboard>
      <Title>{t('agentEdit.title')}</Title>
      <Field
        testID="agent-edit-name"
        label={t('field.name')}
        value={name}
        onChangeText={(text) => {
          setName(tidyName(text));
          setError(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={32}
        hint={t('agentEdit.nameHint')}
        error={nameError}
      />
      <SectionTitle>{t('field.provider')}</SectionTitle>
      <Choice options={options} value={provider} onChange={setProvider} />
      <Small>{t('agentEdit.platformHint')}</Small>
      {error !== null && !nameTaken && <Banner tone="danger" title={describeError(error)} />}
    </Screen>
  );
}
