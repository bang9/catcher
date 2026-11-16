// Link two agents so they can message each other. Pick the two, then three plain choices: which way (both by default),
// whether each message waits for the owner's OK, and for how long. "Link" signs the permissions (one per direction) and
// replaces any older ones for the same direction. Current permissions between the two are listed with a remove button.

import { useState } from 'react';
import { Alert, Pressable, Switch, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import type { AgentSummary } from '@catcher/protocol';
import type { Key } from '@/i18n';
import { t } from '@/i18n';
import { describeError } from '@/lib/errors';
import { dateTime } from '@/lib/format';
import { pairId } from '@/state/rooms';
import { getState, requireOwner, useApp } from '@/state/store';
import { syncQuietly } from '@/state/sync';
import { colors } from '@/ui/colors';
import { Banner, Button, Icon, Lede, Screen, SIZE, tap } from '@/ui/kit';
import { Text } from '@/ui/text';
import { linksBetween } from './chat';
import { AgentPicker } from './pick';
import { Avatar } from './sidebar';

type Direction = 'both' | 'ab' | 'ba';

const EXPIRY: { key: Key; ms: number | null }[] = [
  { key: 'expiry.none', ms: null },
  { key: 'expiry.hour', ms: 3_600_000 },
  { key: 'expiry.day', ms: 86_400_000 },
  { key: 'expiry.week', ms: 7 * 86_400_000 },
  { key: 'expiry.month', ms: 30 * 86_400_000 },
];

/** A row of pill choices, one picked. */
export function Choice<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {options.map((o) => {
        const on = o.value === value;
        let border = 1;
        if (on) border = 0;
        return (
          <Pressable
            key={String(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => {
              tap();
              onChange(o.value);
            }}
            style={({ pressed }) => ({
              minHeight: SIZE.md,
              paddingHorizontal: 16,
              borderRadius: SIZE.md / 2,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: border,
              borderColor: colors.separator,
              backgroundColor: (on && colors.ink) || (pressed && colors.fill) || undefined,
            })}
          >
            <Text style={{ fontSize: 15, fontWeight: '600', color: (on && colors.onInk) || colors.label }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Label({ children }: { children: string }) {
  return (
    <Text style={{ fontSize: 13, lineHeight: 18, fontWeight: '500', color: colors.tertiaryLabel, marginBottom: -10 }}>
      {children}
    </Text>
  );
}

/** The two picked agents side by side with the direction between them; tap one to pick again. */
function Pair({
  a,
  b,
  direction,
  onClear,
}: {
  a: AgentSummary;
  b: AgentSummary;
  direction: Direction;
  onClear: () => void;
}) {
  let ios: 'arrow.left.arrow.right' | 'arrow.right' | 'arrow.left' = 'arrow.left.arrow.right';
  let android: 'sync_alt' | 'arrow_forward' | 'arrow_back' = 'sync_alt';
  if (direction === 'ab') {
    ios = 'arrow.right';
    android = 'arrow_forward';
  }
  if (direction === 'ba') {
    ios = 'arrow.left';
    android = 'arrow_back';
  }
  const slot = (x: AgentSummary) => (
    <Pressable accessibilityRole="button" onPress={onClear} style={{ flex: 1, alignItems: 'center', gap: 8 }}>
      <Avatar name={x.name} agent={x} size={56} surface={colors.card} />
      <Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.label }}>
        {x.name}
      </Text>
    </Pressable>
  );
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 20,
        borderCurve: 'continuous',
        backgroundColor: colors.card,
        paddingVertical: 20,
        paddingHorizontal: 12,
      }}
    >
      {slot(a)}
      <View style={{ paddingBottom: 28 }}>
        <Icon ios={ios} android={android} size={24} color={colors.secondaryLabel} />
      </View>
      {slot(b)}
    </View>
  );
}

export function LinkScreen() {
  const params = useLocalSearchParams<{ a?: string; b?: string }>();
  const agents = useApp((s) => s.agents);
  const grants = useApp((s) => s.grants);
  const active = agents.filter((x) => x.status === 'active');
  const [picked, setPicked] = useState<string[]>([params.a, params.b].filter((x): x is string => !!x));
  const [direction, setDirection] = useState<Direction>('both');
  const [approval, setApproval] = useState(false);
  const [expiry, setExpiry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const A = agents.find((x) => x.agentId === picked[0]);
  const B = agents.find((x) => x.agentId === picked[1]);
  const ready = !!A && !!B && A.agentId !== B.agentId;
  const existing = (ready && linksBetween(grants, A.agentId, B.agentId)) || { ab: null, ba: null };

  const pick = (id: string) =>
    setPicked((p) => {
      if (p.includes(id)) return p.filter((x) => x !== id);
      if (p.length < 2) return [...p, id];
      return [p[0]!, id];
    });

  const link = async () => {
    if (!A || !B) return;
    setBusy(true);
    setError(null);
    try {
      const owner = requireOwner();
      const ms = EXPIRY[expiry]?.ms ?? null;
      let expiresAt: number | null = null;
      if (ms) expiresAt = Date.now() + ms;
      const ways: [AgentSummary, AgentSummary][] = [];
      if (direction !== 'ba') ways.push([A, B]);
      if (direction !== 'ab') ways.push([B, A]);
      const replaced: string[] = [];
      for (const [from, to] of ways) {
        await owner.grant({
          from: from.agentId,
          to: to.agentId,
          scopes: ['message'],
          requireApproval: approval,
          expiresAt,
        });
        const old = linksBetween(getState().grants, from.agentId, to.agentId).ab;
        if (old) replaced.push(old.grantId);
      }
      // the new permissions are signed; the older ones for the same direction go away
      if (replaced.length) await owner.revoke({ grants: replaced });
      syncQuietly();
      router.back();
      router.navigate({ pathname: '/pair/[pairId]', params: { pairId: pairId(A.agentId, B.agentId) } });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const unlink = (grantId: string, from: string, to: string) =>
    Alert.alert(t('link.unlinkTitle'), t('link.unlinkBody', { from, to }), [
      { text: t('common.close'), style: 'cancel' },
      {
        text: t('link.unlink'),
        style: 'destructive',
        onPress: () =>
          void requireOwner()
            .revoke({ grants: [grantId] })
            .then(() => syncQuietly())
            .catch((e: unknown) => setError(describeError(e))),
      },
    ]);

  const current = [existing.ab, existing.ba].filter((g) => g !== null);

  return (
    <Screen
      testID="link"
      footer={
        <Button
          testID="link-submit"
          label={t((current.length > 0 && 'link.update') || 'link.submit')}
          busy={busy}
          disabled={!ready}
          onPress={() => void link()}
        />
      }
    >
      <Lede>{t('link.lede')}</Lede>
      {ready && <Pair a={A} b={B} direction={direction} onClear={() => setPicked([])} />}
      {!ready && (
        <>
          <Label>{t('link.pick')}</Label>
          <AgentPicker agents={active} picked={picked} onToggle={pick} />
        </>
      )}
      {picked.length === 2 && !ready && <Banner tone="warning" title={t('link.same')} />}
      {ready && (
        <>
          <Label>{t('link.direction')}</Label>
          <Choice<Direction>
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'both', label: t('link.both') },
              { value: 'ab', label: t('link.oneWay', { from: A.name, to: B.name }) },
              { value: 'ba', label: t('link.oneWay', { from: B.name, to: A.name }) },
            ]}
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 16, lineHeight: 22, fontWeight: '500', color: colors.label }}>
                {t('link.approval')}
              </Text>
              <Text style={{ fontSize: 13, lineHeight: 18, color: colors.secondaryLabel }}>
                {t('link.approvalHint')}
              </Text>
            </View>
            <Switch
              testID="link-approval"
              value={approval}
              onValueChange={setApproval}
              trackColor={{ true: colors.ink as string, false: colors.fill as string }}
              // the track is ink when on (black in light mode, white in dark): the thumb takes the opposite
              thumbColor={(approval && colors.onInk) || '#ffffff'}
            />
          </View>
          <Label>{t('link.expiry')}</Label>
          <Choice<number>
            value={expiry}
            onChange={setExpiry}
            options={EXPIRY.map((e, i) => ({ value: i, label: t(e.key) }))}
          />
        </>
      )}
      {error && <Banner tone="danger" title={error} />}
      {current.length > 0 && A && B && (
        <>
          <Label>{t('link.current')}</Label>
          <View style={{ gap: 8 }}>
            {current.map((g) => {
              const from = agents.find((x) => x.agentId === g.from)?.name ?? g.from;
              const to = agents.find((x) => x.agentId === g.to)?.name ?? g.to;
              const parts = [t((g.requireApproval && 'link.everyMessage') || 'grant.noApproval')];
              if (g.expiresAt) parts.push(t('grant.until', { date: dateTime(g.expiresAt) }));
              return (
                <View
                  key={g.grantId}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    paddingLeft: 14,
                    paddingRight: 6,
                    paddingVertical: 8,
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: colors.separator,
                  }}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: 15, lineHeight: 20, fontWeight: '600', color: colors.label }}>
                      {`${from} → ${to}`}
                    </Text>
                    <Text style={{ fontSize: 13, lineHeight: 18, color: colors.secondaryLabel }}>
                      {parts.join(' · ')}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => unlink(g.grantId, from, to)}
                    style={({ pressed }) => ({
                      minHeight: SIZE.sm + 4,
                      paddingHorizontal: 14,
                      borderRadius: 18,
                      justifyContent: 'center',
                      backgroundColor: (pressed && colors.fill) || colors.card,
                    })}
                  >
                    <Text style={{ fontSize: 14, fontWeight: '600', color: colors.danger }}>{t('link.unlink')}</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        </>
      )}
    </Screen>
  );
}
