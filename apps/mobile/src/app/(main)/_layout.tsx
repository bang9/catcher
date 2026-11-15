// The signed-in app: a chat canvas with a sidebar, like a chat assistant. The sidebar lists the agents (each one is a
// conversation), what waits on the owner, the activity log and settings.

import { useColorScheme } from 'react-native';
import { Drawer } from 'expo-router/drawer';
import type { DrawerNavigationOptions } from 'expo-router/drawer';
import { t } from '@/i18n';
import { Sidebar } from '@/screens/sidebar';
import { colors, hex } from '@/ui/colors';
import { EDGE, GLYPH, HIT, Icon, IconButton } from '@/ui/kit';
import { fontFamily } from '@/ui/text';

export default function MainLayout() {
  const scheme = useColorScheme();
  const options = ({ navigation }: { navigation: { openDrawer: () => void } }): DrawerNavigationOptions => ({
    drawerType: 'slide',
    drawerStyle: { width: '82%', backgroundColor: hex('sidebar', scheme) },
    overlayColor: 'rgba(0,0,0,0.12)',
    swipeEdgeWidth: 64,
    headerTitleAlign: 'center',
    headerShadowVisible: false,
    headerStyle: { backgroundColor: hex('background', scheme) },
    headerTintColor: hex('label', scheme),
    headerTitleStyle: { fontFamily: fontFamily['600'], fontSize: 17 },
    sceneStyle: { backgroundColor: colors.background },
    headerLeft: () => (
      <IconButton testID="open-sidebar" label={t('nav.menu')} onPress={() => navigation.openDrawer()}>
        <Icon ios="line.3.horizontal" android="menu" />
      </IconButton>
    ),
    // icon buttons are 44 wide around a 22 glyph: inset so the glyph itself sits on the 20 edge
    headerLeftContainerStyle: { paddingLeft: EDGE - (HIT - GLYPH) / 2 },
    headerRightContainerStyle: { paddingRight: EDGE - (HIT - GLYPH) / 2 },
  });
  return (
    <Drawer screenOptions={options} drawerContent={(props) => <Sidebar {...props} />}>
      <Drawer.Screen name="index" options={{ title: '' }} />
      <Drawer.Screen name="chat/[agentId]" options={{ title: '' }} />
      <Drawer.Screen name="pair/[pairId]" options={{ title: '' }} />
      <Drawer.Screen name="group/[groupId]" options={{ title: '' }} />
      <Drawer.Screen name="inbox" options={{ title: t('inbox.title') }} />
      <Drawer.Screen name="activity" options={{ title: t('activity.title') }} />
      <Drawer.Screen name="agents" options={{ title: t('agents.title') }} />
      <Drawer.Screen name="settings" options={{ title: t('settings.title') }} />
    </Drawer>
  );
}
