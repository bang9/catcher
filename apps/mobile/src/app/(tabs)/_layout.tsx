// Five tabs. Inbox is the default and shows how many things wait on the owner.

import { NativeTabs } from 'expo-router/native-tabs';
import { t } from '@/i18n';
import { usePending } from '@/state/selectors';

export default function TabsLayout() {
  const { count } = usePending();
  let badge: string | undefined;
  if (count > 0) badge = String(count);
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="(inbox)">
        <NativeTabs.Trigger.Icon sf={{ default: 'tray', selected: 'tray.fill' }} md="inbox" />
        <NativeTabs.Trigger.Label>{t('tab.inbox')}</NativeTabs.Trigger.Label>
        {badge && <NativeTabs.Trigger.Badge>{badge}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="chats">
        <NativeTabs.Trigger.Icon
          sf={{ default: 'bubble.left.and.bubble.right', selected: 'bubble.left.and.bubble.right.fill' }}
          md="chat"
        />
        <NativeTabs.Trigger.Label>{t('tab.chats')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="activity">
        <NativeTabs.Trigger.Icon sf="list.bullet.rectangle" md="history" />
        <NativeTabs.Trigger.Label>{t('tab.activity')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agents">
        <NativeTabs.Trigger.Icon sf={{ default: 'cpu', selected: 'cpu.fill' }} md="memory" />
        <NativeTabs.Trigger.Label>{t('tab.agents')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf={{ default: 'gearshape', selected: 'gearshape.fill' }} md="settings" />
        <NativeTabs.Trigger.Label>{t('tab.settings')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
