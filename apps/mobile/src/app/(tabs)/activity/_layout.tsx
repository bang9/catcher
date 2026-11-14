import { Stack } from 'expo-router';
import { t } from '@/i18n';
import { colors } from '@/ui/colors';

export default function Layout() {
  return (
    <Stack
      screenOptions={{
        headerLargeTitleEnabled: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerStyle: { backgroundColor: colors.background as string },
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: t('activity.title') }} />
    </Stack>
  );
}
