// Shared building blocks. Black-and-white like a chat app: the main action is ink (black on light, white on dark),
// hierarchy comes from size, weight and grey level, and the brand purple only marks what waits on the owner.

import { type ReactNode, useContext, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';
import { Text } from '@/ui/text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { KeyboardAvoidingView, KeyboardAwareScrollView, useKeyboardState } from 'react-native-keyboard-controller';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { t } from '@/i18n';
import { colors, mono } from './colors';
import { fontFamily } from './text';

export function tap(): void {
  if (process.env.EXPO_OS === 'ios') void Haptics.selectionAsync();
}

// ─── icons ───────────────────────────────────────────────────────────────────

type SFSymbol = Extract<SymbolViewProps['name'], string>;
type AndroidName = Extract<SymbolViewProps['name'], { android?: unknown }>['android'];

/** SF Symbol on iOS, Material Symbol on Android. */
export function Icon({
  ios,
  android,
  size = GLYPH,
  color,
}: {
  ios: SFSymbol;
  android: NonNullable<AndroidName>;
  size?: number;
  color?: ViewStyle['backgroundColor'];
}) {
  return (
    <SymbolView
      name={{ ios, android, web: android }}
      size={size}
      tintColor={color ?? colors.label}
      weight="medium"
      style={{ width: size, height: size }}
    />
  );
}

/** A round, icon-only header or toolbar button. */
export function IconButton({
  label,
  onPress,
  children,
  testID,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        width: HIT,
        height: HIT,
        borderRadius: HIT / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: (pressed && colors.fill) || undefined,
      })}
    >
      {children}
    </Pressable>
  );
}

// ─── layout ──────────────────────────────────────────────────────────────────

/** The one horizontal edge: text, buttons and header glyphs all line up 16 from the screen side (as in allob). */
export const EDGE = 16;
/** Control heights: full-width actions, inline actions, small chips. */
export const SIZE = { lg: 52, md: 40, sm: 32 } as const;
/** Touch target for icon-only buttons; the glyph inside is 22. */
export const HIT = 44;
export const GLYPH = 22;

/** Bottom space above the home indicator / gesture bar, never less than 16. */
export function useBottomGap(): number {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardState((k) => k.isVisible);
  // the keyboard covers the gesture bar: keep a plain gap above it instead
  if (keyboard) return 12;
  return Math.max(insets.bottom, 16);
}

interface ScreenProps {
  children: ReactNode;
  /** pinned under the scroll area: the screen's one main action */
  footer?: ReactNode;
  onRefresh?: () => Promise<unknown>;
  /** screen has text inputs: keep the focused field and the footer above the keyboard */
  keyboard?: boolean;
  /** no navigation header above (onboarding): start at the same height a header would leave */
  bare?: boolean;
  testID?: string;
}

function useRefresh(onRefresh: ScreenProps['onRefresh']) {
  const [refreshing, setRefreshing] = useState(false);
  if (!onRefresh) return undefined;
  const run = () => {
    setRefreshing(true);
    onRefresh()
      .catch(() => {
        // errors show in the screen's banner
      })
      .finally(() => setRefreshing(false));
  };
  return <RefreshControl refreshing={refreshing} onRefresh={run} />;
}

function Footer({ children }: { children: ReactNode }) {
  const bottom = useBottomGap();
  return (
    <View
      style={{
        paddingHorizontal: EDGE,
        paddingTop: 12,
        paddingBottom: bottom,
        gap: 4,
        backgroundColor: colors.background,
      }}
    >
      {children}
    </View>
  );
}

export function Screen({ children, footer, onRefresh, keyboard, bare, testID }: ScreenProps) {
  const insets = useSafeAreaInsets();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const refreshControl = useRefresh(onRefresh);
  let top = 8;
  if (bare) top = insets.top + 40;
  // flexGrow: an empty state can center itself in the space left
  const content = { flexGrow: 1, paddingHorizontal: EDGE, paddingTop: top, gap: 20, paddingBottom: 32 };
  let scroll = (
    <ScrollView
      testID={testID}
      style={{ flex: 1, backgroundColor: colors.background }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      refreshControl={refreshControl}
      contentContainerStyle={content}
    >
      {children}
    </ScrollView>
  );
  if (keyboard) {
    // scrolls the focused field into view, 24 above the keyboard
    scroll = (
      <KeyboardAwareScrollView
        testID={testID}
        style={{ flex: 1, backgroundColor: colors.background }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        bottomOffset={24}
        refreshControl={refreshControl}
        contentContainerStyle={content}
      >
        {children}
      </KeyboardAwareScrollView>
    );
  }
  const body = (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {scroll}
      {footer && <Footer>{footer}</Footer>}
    </View>
  );
  if (!keyboard) return body;
  // the footer rides up with the keyboard
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding" keyboardVerticalOffset={headerHeight}>
      {body}
    </KeyboardAvoidingView>
  );
}

// ─── text ────────────────────────────────────────────────────────────────────

export function Title({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text
      testID={testID}
      selectable
      style={{ fontSize: 24, fontWeight: '700', color: colors.label, lineHeight: 32, letterSpacing: -0.4 }}
    >
      {children}
    </Text>
  );
}

export function Lede({ children }: { children: ReactNode }) {
  return <Text style={{ fontSize: 16, lineHeight: 24, color: colors.secondaryLabel }}>{children}</Text>;
}

export function Small({ children, color }: { children: ReactNode; color?: ViewStyle['backgroundColor'] }) {
  return <Text style={{ fontSize: 13, lineHeight: 18, color: color ?? colors.secondaryLabel }}>{children}</Text>;
}

/** Untrusted text from an agent: plain, selectable, never parsed as links or markup. */
export function PlainText({ children, size = 16, color }: { children: string; size?: number; color?: string }) {
  return (
    <Text
      selectable
      dataDetectorType="none"
      style={{ fontSize: size, lineHeight: size * 1.4, color: color ?? colors.label }}
    >
      {children}
    </Text>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Text style={{ fontSize: 13, fontWeight: '500', color: colors.tertiaryLabel, marginBottom: -12, marginLeft: 4 }}>
      {children}
    </Text>
  );
}

// ─── controls ────────────────────────────────────────────────────────────────

type ButtonKind = 'primary' | 'secondary' | 'plain' | 'danger';

interface ButtonProps {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
}

function buttonColors(kind: ButtonKind): { bg: string | undefined; fg: string } {
  if (kind === 'primary') return { bg: colors.ink as string, fg: colors.onInk as string };
  if (kind === 'secondary') return { bg: colors.card as string, fg: colors.label as string };
  if (kind === 'danger') return { bg: colors.card as string, fg: colors.danger as string };
  return { bg: undefined, fg: colors.label as string };
}

export function Button({ label, onPress, kind = 'primary', busy, disabled, testID }: ButtonProps) {
  const c = buttonColors(kind);
  const off = disabled || busy;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        minHeight: (kind === 'plain' && 44) || SIZE.lg,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
        backgroundColor: c.bg,
        opacity: (disabled && 0.35) || (pressed && 0.75) || 1,
      })}
    >
      {busy && <ActivityIndicator color={c.fg} />}
      {!busy && <Text style={{ color: c.fg, fontSize: 16, fontWeight: '600' }}>{label}</Text>}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string; hint?: string; error?: string | null }) {
  const { label, hint, error, style, ...rest } = props;
  return (
    <View style={{ gap: 6 }}>
      {label && <Text style={{ fontSize: 13, fontWeight: '500', color: colors.secondaryLabel }}>{label}</Text>}
      <TextInput
        placeholderTextColor={colors.tertiaryLabel as string}
        {...rest}
        style={[
          {
            minHeight: 50,
            borderRadius: 16,
            borderCurve: 'continuous',
            paddingHorizontal: 16,
            paddingVertical: 13,
            fontSize: 16,
            fontFamily: fontFamily['400'],
            color: colors.label,
            backgroundColor: colors.card,
          },
          style,
        ]}
      />
      {!!error && <Small color={colors.danger}>{error}</Small>}
      {!error && hint && <Small>{hint}</Small>}
    </View>
  );
}

export function CopyButton({ value, label, testID }: { value: string; label?: string; testID?: string }) {
  const [copied, setCopied] = useState(false);
  let text = label ?? t('common.copy');
  if (copied) text = t('common.copied');
  return (
    <Button
      testID={testID}
      kind="secondary"
      label={text}
      onPress={() => {
        void Clipboard.setStringAsync(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    />
  );
}

// ─── groups and rows ─────────────────────────────────────────────────────────

export function Group({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return (
    <View
      style={[{ backgroundColor: colors.card, borderRadius: 20, borderCurve: 'continuous', overflow: 'hidden' }, style]}
    >
      {children}
    </View>
  );
}

interface RowProps {
  title: string;
  subtitle?: string;
  detail?: string;
  accessory?: ReactNode;
  onPress?: () => void;
  danger?: boolean;
  first?: boolean;
  testID?: string;
}

export function Row({ title, subtitle, detail, accessory, onPress, danger, first, testID }: RowProps) {
  let titleColor = colors.label;
  if (danger) titleColor = colors.danger;
  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 52,
        paddingVertical: 10,
        paddingHorizontal: 16,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={2} style={{ fontSize: 16, fontWeight: '500', color: titleColor }}>
          {title}
        </Text>
        {subtitle && (
          <Text numberOfLines={2} style={{ fontSize: 14, color: colors.secondaryLabel }}>
            {subtitle}
          </Text>
        )}
      </View>
      {detail && <Text style={{ fontSize: 15, color: colors.secondaryLabel }}>{detail}</Text>}
      {accessory}
      {onPress && <Icon ios="chevron.right" android="chevron_right" size={16} color={colors.tertiaryLabel} />}
    </View>
  );
  const divider = !first && <View style={{ height: 0.5, marginLeft: 16, backgroundColor: colors.separator }} />;
  if (!onPress) {
    return (
      <View testID={testID}>
        {divider}
        {content}
      </View>
    );
  }
  return (
    <View>
      {divider}
      <Pressable
        testID={testID}
        accessibilityRole="button"
        onPress={() => {
          tap();
          onPress();
        }}
        style={({ pressed }) => ({ backgroundColor: (pressed && colors.fill) || undefined })}
      >
        {content}
      </Pressable>
    </View>
  );
}

/** Label / value pair inside a Group. */
export function Info({
  label,
  value,
  first,
  mono: monospace,
}: {
  label: string;
  value: string;
  first?: boolean;
  mono?: boolean;
}) {
  return (
    <View>
      {!first && <View style={{ height: 0.5, marginLeft: 16, backgroundColor: colors.separator }} />}
      <View style={{ flexDirection: 'row', gap: 12, paddingVertical: 13, paddingHorizontal: 16 }}>
        <Text style={{ fontSize: 15, color: colors.secondaryLabel }}>{label}</Text>
        <Text
          selectable
          style={{
            flex: 1,
            textAlign: 'right',
            fontSize: 16,
            color: colors.label,
            fontFamily: (monospace && mono) || undefined,
          }}
        >
          {value}
        </Text>
      </View>
    </View>
  );
}

// ─── states ──────────────────────────────────────────────────────────────────

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    // centered in what is left of the screen, a little above the middle (optical center)
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingBottom: 64,
      }}
    >
      <Text style={{ fontSize: 20, fontWeight: '600', color: colors.label, textAlign: 'center', letterSpacing: -0.3 }}>
        {title}
      </Text>
      {body && (
        <Text style={{ fontSize: 15, lineHeight: 21, color: colors.secondaryLabel, textAlign: 'center' }}>{body}</Text>
      )}
      {action && <View style={{ alignSelf: 'stretch', marginTop: 16 }}>{action}</View>}
    </View>
  );
}

type Tone = 'warning' | 'danger' | 'info';

function toneColor(tone: Tone) {
  if (tone === 'danger') return colors.danger;
  if (tone === 'warning') return colors.warning;
  return colors.accent;
}

export function Banner({
  tone = 'warning',
  title,
  body,
  testID,
}: {
  tone?: Tone;
  title: string;
  body?: string;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        gap: 10,
        borderRadius: 16,
        borderCurve: 'continuous',
        padding: 14,
        backgroundColor: colors.card,
      }}
    >
      <Icon ios="exclamationmark.circle.fill" android="error" size={18} color={toneColor(tone)} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text selectable style={{ fontSize: 15, fontWeight: '600', color: colors.label }}>
          {title}
        </Text>
        {body && (
          <Text selectable style={{ fontSize: 14, lineHeight: 20, color: colors.secondaryLabel }}>
            {body}
          </Text>
        )}
      </View>
    </View>
  );
}

export function Pill({ label, tone }: { label: string; tone?: Tone | 'success' | 'muted' }) {
  let color = colors.secondaryLabel;
  if (tone === 'success') color = colors.success;
  if (tone === 'danger') color = colors.danger;
  if (tone === 'warning') color = colors.warning;
  if (tone === 'info') color = colors.accent;
  return (
    <View style={{ borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3, backgroundColor: colors.card }}>
      <Text style={{ fontSize: 12, fontWeight: '500', color }}>{label}</Text>
    </View>
  );
}

export function Dot({ on }: { on: boolean }) {
  let color = colors.tertiaryLabel;
  if (on) color = colors.success;
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

/** A code people compare or copy (fingerprints, recovery codes): big monospace, wrapped at group borders. */
export function Code({ value, size = 24, testID }: { value: string; size?: number; testID?: string }) {
  return (
    <Group style={{ padding: 18 }}>
      <Text
        testID={testID}
        selectable
        style={{
          fontFamily: mono,
          fontSize: size,
          lineHeight: size * 1.45,
          fontWeight: '600',
          color: colors.label,
          textAlign: 'center',
          letterSpacing: 1,
        }}
      >
        {value.split('-').join(' ')}
      </Text>
    </Group>
  );
}

export function Spinner() {
  return (
    <View style={{ paddingVertical: 48, alignItems: 'center' }}>
      <ActivityIndicator />
    </View>
  );
}
