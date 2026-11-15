// catcher's brand purple (from the original catcher icon). app.config.ts reads this too: the Android accent is a
// color resource with a night variant, so both platforms follow light and dark mode.
export const ACCENT = { light: '#7318c6', dark: '#9d5cf5' };

// the color resource app.config.ts writes for Android (values/colors.xml and values-night/colors.xml)
export const ANDROID_ACCENT_RESOURCE = 'catcher_accent';
