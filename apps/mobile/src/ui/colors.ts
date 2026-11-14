// Semantic system colors: they follow light/dark mode and accessibility settings on each platform.

import { Color } from 'expo-router';
import { Platform } from 'react-native';

export const colors = {
  label: Platform.select({ ios: Color.ios.label, android: Color.android.dynamic.onSurface, default: '#000000' }),
  secondaryLabel: Platform.select({
    ios: Color.ios.secondaryLabel,
    android: Color.android.dynamic.onSurfaceVariant,
    default: '#3c3c43',
  }),
  tertiaryLabel: Platform.select({
    ios: Color.ios.tertiaryLabel,
    android: Color.android.dynamic.outline,
    default: '#8e8e93',
  }),
  separator: Platform.select({
    ios: Color.ios.separator,
    android: Color.android.dynamic.outlineVariant,
    default: '#c6c6c8',
  }),
  background: Platform.select({
    ios: Color.ios.systemGroupedBackground,
    android: Color.android.dynamic.surface,
    default: '#f2f2f7',
  }),
  card: Platform.select({
    ios: Color.ios.secondarySystemGroupedBackground,
    android: Color.android.dynamic.surfaceContainer,
    default: '#ffffff',
  }),
  fill: Platform.select({
    ios: Color.ios.tertiarySystemFill,
    android: Color.android.dynamic.surfaceContainerHighest,
    default: '#e5e5ea',
  }),
  accent: Platform.select({ ios: Color.ios.systemBlue, android: Color.android.dynamic.primary, default: '#007aff' }),
  onAccent: Platform.select({ ios: '#ffffff', android: Color.android.dynamic.onPrimary, default: '#ffffff' }),
  danger: Platform.select({ ios: Color.ios.systemRed, android: Color.android.dynamic.error, default: '#ff3b30' }),
  success: Platform.select({ ios: Color.ios.systemGreen, default: '#34c759' }),
  warning: Platform.select({ ios: Color.ios.systemOrange, default: '#ff9500' }),
  ownBubble: Platform.select({ ios: Color.ios.systemBlue, android: Color.android.dynamic.primary, default: '#007aff' }),
  agentBubble: Platform.select({
    ios: Color.ios.secondarySystemGroupedBackground,
    android: Color.android.dynamic.surfaceContainerHigh,
    default: '#e9e9eb',
  }),
};

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });
