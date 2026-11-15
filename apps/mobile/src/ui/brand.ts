// catcher's palette: a quiet black-and-white chat surface (light / dark pairs, the same greys as the allob app), with the
// brand purple from the original catcher icon kept for the few marks that mean "this is waiting on you". app.config.ts reads this too: on Android each
// entry becomes a color resource with a night variant, so both platforms follow light and dark mode without a hook.
export const ACCENT = { light: '#7318c6', dark: '#a771f5' };

export const PALETTE = {
  /** the chat canvas */
  background: { light: '#ffffff', dark: '#212121' },
  /** the sidebar behind the canvas */
  sidebar: { light: '#f9f9f9', dark: '#171717' },
  /** raised surfaces: your bubbles, the composer, grouped rows */
  card: { light: '#f1f1f2', dark: '#333336' },
  /** pressed rows, secondary buttons */
  fill: { light: '#e9e9eb', dark: '#3d3d41' },
  label: { light: '#0d0d0d', dark: '#ececec' },
  secondaryLabel: { light: '#5d5d5d', dark: '#b4b4b4' },
  tertiaryLabel: { light: '#8b8b8f', dark: '#8e8e93' },
  separator: { light: '#e7e7e9', dark: '#3a3a3d' },
  /** the main action: black on light, white on dark */
  ink: { light: '#0d0d0d', dark: '#ececec' },
  onInk: { light: '#ffffff', dark: '#0d0d0d' },
  accent: ACCENT,
  danger: { light: '#d93025', dark: '#f28b82' },
  success: { light: '#10a37f', dark: '#19c37d' },
  warning: { light: '#b45f06', dark: '#f0a640' },
} as const;

export type PaletteKey = keyof typeof PALETTE;

/** the Android color resource name app.config.ts writes for a palette entry (values/ and values-night/colors.xml) */
export function androidColorName(key: PaletteKey): string {
  return `catcher_${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;
}

export const ANDROID_ACCENT_RESOURCE = androidColorName('accent');
