// Root: load the owner key, then show onboarding or the app. Realtime and push run only once onboarded.

import { useEffect } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';
import { t } from '@/i18n';
import { configureNotifications, listenForPushes, refreshPushToken } from '@/state/push';
import { followAppState } from '@/state/realtime';
import { useApp } from '@/state/store';
import { bootstrap } from '@/state/sync';
import { colors } from '@/ui/colors';

void SplashScreen.preventAutoHideAsync();
configureNotifications();

export const unstable_settings = { anchor: '(tabs)' };

function theme(scheme: string | null | undefined) {
  if (scheme === 'dark') return DarkTheme;
  return DefaultTheme;
}

export default function RootLayout() {
  const scheme = useColorScheme();
  const ready = useApp((s) => s.ready);
  const signedIn = useApp((s) => s.owner !== null && s.onboarded);

  useEffect(() => {
    bootstrap()
      .catch(() => {
        // keychain unreadable: onboarding shows; nothing else to do
      })
      .finally(() => void SplashScreen.hideAsync());
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    const stopRealtime = followAppState();
    const stopPush = listenForPushes();
    void refreshPushToken().catch(() => {
      // settings shows push state; a stale token only delays notifications
    });
    return () => {
      stopRealtime();
      stopPush();
    };
  }, [signedIn]);

  if (!ready) return null;

  return (
    <ThemeProvider value={theme(scheme)}>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerBackButtonDisplayMode: 'minimal',
          headerShadowVisible: false,
          headerStyle: { backgroundColor: colors.background as string },
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Protected guard={signedIn} redirectTo="/welcome">
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="registration/[agentId]" options={{ title: t('kind.registration') }} />
          <Stack.Screen name="request/[id]" options={{ title: '' }} />
          <Stack.Screen name="chat/[agentId]" options={{ title: '' }} />
          <Stack.Screen name="agent/[agentId]" options={{ title: '' }} />
          <Stack.Screen name="add-agent" options={{ title: t('add.title') }} />
          <Stack.Screen name="grant-new" options={{ title: t('agent.newGrant'), presentation: 'modal' }} />
          <Stack.Screen name="reveal" options={{ title: t('reveal.title') }} />
          <Stack.Screen name="rotate" options={{ title: t('settings.rotate') }} />
          <Stack.Screen name="move-server" options={{ title: t('settings.server'), presentation: 'modal' }} />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn} redirectTo="/">
          <Stack.Screen name="welcome" options={{ headerShown: false }} />
          <Stack.Screen name="restore" options={{ title: '' }} />
          <Stack.Screen name="recovery-code" options={{ headerShown: false, gestureEnabled: false }} />
          <Stack.Screen name="notifications" options={{ headerShown: false, gestureEnabled: false }} />
          <Stack.Screen name="server" options={{ title: t('settings.server'), presentation: 'modal' }} />
        </Stack.Protected>
      </Stack>
    </ThemeProvider>
  );
}
