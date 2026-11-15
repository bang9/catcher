// Home: the latest conversation. With no agent yet, the one thing to do — the line to send an agent so it connects.

import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Redirect, router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { t } from '@/i18n';
import { SITE_URL } from '@/lib/site';
import { useRoomList } from '@/state/rooms';
import { colors } from '@/ui/colors';
import { Button, EDGE, Icon, Lede, SIZE, tap, useBottomGap } from '@/ui/kit';
import { Text } from '@/ui/text';
import { SyncBanner } from './parts';

export const AGENT_PROMPT = `Read ${SITE_URL}/agent.md and install catcher.`;

function PromptCard() {
  const [copied, setCopied] = useState(false);
  return (
    <View style={{ borderRadius: 24, borderCurve: 'continuous', backgroundColor: colors.card, padding: 18, gap: 14 }}>
      <Text selectable testID="home-prompt" style={{ fontSize: 17, lineHeight: 25, color: colors.label }}>
        {AGENT_PROMPT}
      </Text>
      <Pressable
        testID="home-copy"
        accessibilityRole="button"
        onPress={() => {
          tap();
          void Clipboard.setStringAsync(AGENT_PROMPT).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        style={({ pressed }) => ({
          alignSelf: 'flex-end',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          height: SIZE.md,
          paddingHorizontal: 16,
          borderRadius: SIZE.md / 2,
          backgroundColor: colors.ink,
          opacity: (pressed && 0.75) || 1,
        })}
      >
        <Icon
          ios={(copied && 'checkmark') || 'doc.on.doc'}
          android={(copied && 'check') || 'content_copy'}
          size={16}
          color={colors.onInk}
        />
        <Text style={{ fontSize: 14, fontWeight: '600', color: colors.onInk }}>
          {(copied && t('common.copied')) || t('common.copy')}
        </Text>
      </Pressable>
    </View>
  );
}

export function HomeScreen() {
  const rooms = useRoomList();
  const bottom = useBottomGap();
  // the latest conversation opens; with none yet, the line to send an agent
  const latest = rooms[0]?.room;
  if (latest?.kind === 'agent')
    return <Redirect href={{ pathname: '/chat/[agentId]', params: { agentId: latest.agentId } }} />;
  if (latest?.kind === 'pair')
    return <Redirect href={{ pathname: '/pair/[pairId]', params: { pairId: latest.key.slice(2) } }} />;
  if (latest?.kind === 'group')
    return <Redirect href={{ pathname: '/group/[groupId]', params: { groupId: latest.group.id } }} />;
  return (
    <View
      testID="home"
      style={{ flex: 1, backgroundColor: colors.background, paddingHorizontal: EDGE, paddingBottom: bottom, gap: 16 }}
    >
      <SyncBanner />
      {/* optical center: a little above the middle, the way the eye expects a centered block to sit */}
      <View style={{ flex: 1, justifyContent: 'center', gap: 20, paddingBottom: 56 }}>
        <View style={{ gap: 10 }}>
          <Text style={{ fontSize: 28, lineHeight: 36, fontWeight: '700', letterSpacing: -0.8, color: colors.label }}>
            {t('home.title')}
          </Text>
          <Lede>{t('home.lede')}</Lede>
        </View>
        <PromptCard />
      </View>
      <Button
        testID="inbox-add-agent"
        kind="plain"
        label={t('home.haveCode')}
        onPress={() => router.push('/add-agent')}
      />
    </View>
  );
}
