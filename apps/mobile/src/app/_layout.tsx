// Root: load the owner key, then show onboarding or the app. Realtime and push run only once onboarded.

import { useEffect } from 'react';
import { router, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { LogBox, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';
import { t } from '@/i18n';
import { releaseHeldCode } from '@/state/enroll';
import { configureNotifications, listenForPushes, refreshPushToken } from '@/state/push';
import { followAppState } from '@/state/realtime';
import { useApp } from '@/state/store';
import { bootstrap } from '@/state/sync';
import { colors, hex } from '@/ui/colors';
import { fontFamily } from '@/ui/text';

void SplashScreen.preventAutoHideAsync();
// development only: the drawer library's own Reanimated notice repeats on every drawer render; nothing to fix here
LogBox.ignoreLogs(['[Reanimated] Dependencies']);
configureNotifications();

export const unstable_settings = { anchor: '(main)' };

function theme(scheme: string | null | undefined) {
  const base = (scheme === 'dark' && DarkTheme) || DefaultTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: hex('ink', scheme),
      background: hex('background', scheme),
      card: hex('background', scheme),
      text: hex('label', scheme),
      border: hex('separator', scheme),
      notification: hex('accent', scheme),
    },
  };
}

export default function RootLayout() {
  const scheme = useColorScheme();
  const ready = useApp((s) => s.ready);
  const signedIn = useApp((s) => s.owner !== null && s.onboarded);
  const heldCode = useApp((s) => s.heldEnrollCode);

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

  // a registration link opened before (or during) onboarding waits here; it only opens the confirm sheet
  useEffect(() => {
    if (!signedIn || !heldCode) return;
    // after this render, so the navigator is mounted; the code is released only once the sheet is on its way
    const id = setTimeout(() => {
      router.push({ pathname: '/enroll', params: { code: heldCode } });
      releaseHeldCode();
    }, 0);
    return () => clearTimeout(id);
  }, [signedIn, heldCode]);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider value={theme(scheme)}>
          <StatusBar style="auto" />
          {/* Android resolves the palette (color resources) when a view is made: a light/dark switch while the app
              is open rebuilds the screens so every color follows. iOS colors follow by themselves. */}
          <Stack
            key={(process.env.EXPO_OS === 'android' && (scheme ?? 'light')) || 'app'}
            screenOptions={{
              headerBackButtonDisplayMode: 'minimal',
              headerShadowVisible: false,
              headerStyle: { backgroundColor: hex('background', scheme) },
              headerTintColor: hex('label', scheme),
              headerTitleStyle: { fontFamily: fontFamily['600'] },
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Protected guard={signedIn} redirectTo="/welcome">
              <Stack.Screen name="(main)" options={{ headerShown: false }} />
              <Stack.Screen name="enroll" options={{ title: '', presentation: 'modal' }} />
              <Stack.Screen name="request/[id]" options={{ title: '' }} />
              <Stack.Screen name="agent/[agentId]" options={{ title: '' }} />
              <Stack.Screen name="add-agent" options={{ title: '' }} />
              <Stack.Screen name="agent-edit" options={{ title: '', presentation: 'modal' }} />
              <Stack.Screen name="new-chat" options={{ title: t('new.title'), presentation: 'modal' }} />
              <Stack.Screen name="forward" options={{ title: t('forward.title'), presentation: 'modal' }} />
              <Stack.Screen name="link" options={{ title: t('link.title'), presentation: 'modal' }} />
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
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
