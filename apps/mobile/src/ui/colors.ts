// The app palette as static, mode-following colors: DynamicColorIOS on iOS, a color resource with a night variant on
// Android (written by app.config.ts). Fixed values, not the system's wallpaper-tinted ones, so the app looks the same
// on every phone.

import { type ColorValue, DynamicColorIOS, Platform, PlatformColor } from 'react-native';

import { androidColorName, PALETTE, type PaletteKey } from './brand.ts';

function color(key: PaletteKey): ColorValue {
  const pair = PALETTE[key];
  // one branch per platform: DynamicColorIOS throws anywhere but iOS, so no eager Platform.select here
  if (Platform.OS === 'ios') return DynamicColorIOS(pair);
  if (Platform.OS === 'android') return PlatformColor(`@color/${androidColorName(key)}`);
  return pair.light;
}

export const colors = {
  background: color('background'),
  sidebar: color('sidebar'),
  card: color('card'),
  fill: color('fill'),
  label: color('label'),
  secondaryLabel: color('secondaryLabel'),
  tertiaryLabel: color('tertiaryLabel'),
  separator: color('separator'),
  ink: color('ink'),
  onInk: color('onInk'),
  accent: color('accent'),
  onAccent: '#ffffff' as ColorValue,
  danger: color('danger'),
  success: color('success'),
  warning: color('warning'),
};

/** Plain hex values for places that cannot take a platform color (navigation theme, status bar). */
export function hex(key: PaletteKey, scheme: string | null | undefined): string {
  if (scheme === 'dark') return PALETTE[key].dark;
  return PALETTE[key].light;
}

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });
