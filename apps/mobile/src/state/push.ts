// Push: the relay sends metadata-only notifications through Expo's push service (content stays end-to-end
// encrypted). Receiving one triggers a sync; tapping one opens the related item.

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { pendingForOwner } from '@catcher/client';
import { getKv, setKv } from '@/lib/db';
import { describeError } from '@/lib/errors';
import { localeTag, t } from '@/i18n';
import { getState } from './store';
import { sync, syncQuietly } from './sync';

export type PushResult = { ok: true } | { ok: false; message: string };

export function configureNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  if (process.env.EXPO_OS === 'android') {
    void Notifications.setNotificationChannelAsync('default', {
      name: 'catcher',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
}

export function pushEnabled(): boolean {
  return getKv('push') === 'on';
}

function projectId(): string | undefined {
  const fromConfig = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  return fromConfig ?? Constants.easConfig?.projectId;
}

function platform(): 'ios' | 'android' | 'web' {
  if (process.env.EXPO_OS === 'ios') return 'ios';
  if (process.env.EXPO_OS === 'android') return 'android';
  return 'web';
}

/** Ask for permission (if needed), get the Expo push token and give it to the relay. */
export async function enablePush(): Promise<PushResult> {
  const owner = getState().owner;
  if (!owner) return { ok: false, message: t('push.unavailable') };
  if (!Device.isDevice) return { ok: false, message: t('push.simulator') };
  const id = projectId();
  if (!id) return { ok: false, message: t('push.unavailable') };
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return { ok: false, message: t('push.denied') };
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    await owner.registerPush(token, platform(), localeTag());
    setKv('push', 'on');
    setKv('pushToken', token);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: describeError(e) };
  }
}

export async function disablePush(): Promise<PushResult> {
  const owner = getState().owner;
  const token = getKv('pushToken');
  try {
    if (owner && token) await owner.unregisterPush(token);
    setKv('push', 'off');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: describeError(e) };
  }
}

/** Tokens can change between launches; re-send quietly when push is on. */
export async function refreshPushToken(): Promise<void> {
  if (!pushEnabled()) return;
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return;
  await enablePush();
}

interface PushData {
  kind?: string;
  envelopeId?: string | null;
}

/** Open what a notification is about: a request, a chat, or the inbox. */
export async function openFromNotification(data: PushData): Promise<void> {
  try {
    await sync();
  } catch {
    // open whatever we have locally
  }
  const { owner, items, agents } = getState();
  if (!owner) return;
  if (data.kind === 'registration') {
    const pending = agents.filter((a) => a.status === 'pending').at(-1);
    if (pending) {
      router.push({ pathname: '/registration/[agentId]', params: { agentId: pending.agentId } });
      return;
    }
    router.navigate('/');
    return;
  }
  const item = items.find((i) => i.id === data.envelopeId);
  if (!item) {
    router.navigate('/');
    return;
  }
  if (pendingForOwner([item], owner.state.ownerId).length) {
    router.push({ pathname: '/request/[id]', params: { id: item.id } });
    return;
  }
  if (item.to === owner.state.ownerId) {
    router.push({ pathname: '/chat/[agentId]', params: { agentId: item.from } });
    return;
  }
  router.navigate('/activity');
}

/** Listen for pushes while the app runs, and handle the tap that launched it. Returns an unsubscribe. */
export function listenForPushes(): () => void {
  const received = Notifications.addNotificationReceivedListener(() => syncQuietly());
  const tapped = Notifications.addNotificationResponseReceivedListener((response) => {
    void openFromNotification(response.notification.request.content.data as PushData);
  });
  const launch = Notifications.getLastNotificationResponse();
  if (launch) {
    Notifications.clearLastNotificationResponse();
    void openFromNotification(launch.notification.request.content.data as PushData);
  }
  return () => {
    received.remove();
    tapped.remove();
  };
}
