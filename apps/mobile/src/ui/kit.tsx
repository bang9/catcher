// Shared building blocks. One accent color for the main action; hierarchy from size, weight and grey level.

import { type ReactNode, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { t } from '@/i18n';
import { colors, mono } from './colors';

export function tap(): void {
  if (process.env.EXPO_OS === 'ios') void Haptics.selectionAsync();
}

// ─── layout ──────────────────────────────────────────────────────────────────

interface ScreenProps {
  children: ReactNode;
  /** pinned under the scroll area: the screen's one main action */
  footer?: ReactNode;
  onRefresh?: () => Promise<unknown>;
  /** screen has text inputs: keep the footer above the keyboard */
  keyboard?: boolean;
  testID?: string;
}

function RefreshableScroll({ children, onRefresh, testID }: Omit<ScreenProps, 'footer' | 'keyboard'>) {
  const [refreshing, setRefreshing] = useState(false);
  let control: React.ReactElement<React.ComponentProps<typeof RefreshControl>> | undefined;
  if (onRefresh) {
    const run = () => {
      setRefreshing(true);
      onRefresh()
        .catch(() => {
          // errors show in the screen's banner
        })
        .finally(() => setRefreshing(false));
    };
    control = <RefreshControl refreshing={refreshing} onRefresh={run} />;
  }
  return (
    <ScrollView
      testID={testID}
      style={{ flex: 1, backgroundColor: colors.background }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      refreshControl={control}
      contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 32 }}
    >
      {children}
    </ScrollView>
  );
}

function Footer({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingHorizontal: 20,
        paddingTop: 12,
        paddingBottom: Math.max(insets.bottom, 16),
        gap: 8,
        backgroundColor: colors.background,
      }}
    >
      {children}
    </View>
  );
}

function KeyboardFrame({ children }: { children: ReactNode }) {
  const headerHeight = useHeaderHeight();
  let behavior: 'padding' | undefined;
  if (process.env.EXPO_OS === 'ios') behavior = 'padding';
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={behavior} keyboardVerticalOffset={headerHeight}>
      {children}
    </KeyboardAvoidingView>
  );
}

export function Screen({ children, footer, onRefresh, keyboard, testID }: ScreenProps) {
  const body = (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <RefreshableScroll onRefresh={onRefresh} testID={testID}>
        {children}
      </RefreshableScroll>
      {footer && <Footer>{footer}</Footer>}
    </View>
  );
  if (keyboard) return <KeyboardFrame>{body}</KeyboardFrame>;
  return body;
}

// ─── text ────────────────────────────────────────────────────────────────────

export function Title({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text testID={testID} selectable style={{ fontSize: 26, fontWeight: '700', color: colors.label, lineHeight: 34 }}>
      {children}
    </Text>
  );
}

export function Lede({ children }: { children: ReactNode }) {
  return <Text style={{ fontSize: 16, lineHeight: 23, color: colors.secondaryLabel }}>{children}</Text>;
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
    <Text style={{ fontSize: 13, fontWeight: '600', color: colors.secondaryLabel, marginBottom: -12, marginLeft: 4 }}>
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
  if (kind === 'primary') return { bg: colors.accent as string, fg: colors.onAccent as string };
  if (kind === 'secondary') return { bg: colors.fill as string, fg: colors.label as string };
  if (kind === 'danger') return { bg: colors.fill as string, fg: colors.danger as string };
  return { bg: undefined, fg: colors.accent as string };
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
        minHeight: 52,
        borderRadius: 14,
        borderCurve: 'continuous',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
        backgroundColor: c.bg,
        opacity: (disabled && 0.4) || (pressed && 0.7) || 1,
      })}
    >
      {busy && <ActivityIndicator color={c.fg} />}
      {!busy && <Text style={{ color: c.fg, fontSize: 17, fontWeight: '600' }}>{label}</Text>}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label?: string; hint?: string; error?: string | null }) {
  const { label, hint, error, style, ...rest } = props;
  return (
    <View style={{ gap: 6 }}>
      {label && <Text style={{ fontSize: 13, fontWeight: '600', color: colors.secondaryLabel }}>{label}</Text>}
      <TextInput
        placeholderTextColor={colors.tertiaryLabel as string}
        {...rest}
        style={[
          {
            minHeight: 50,
            borderRadius: 12,
            borderCurve: 'continuous',
            paddingHorizontal: 14,
            paddingVertical: 12,
            fontSize: 17,
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
      style={[{ backgroundColor: colors.card, borderRadius: 14, borderCurve: 'continuous', overflow: 'hidden' }, style]}
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
        <Text numberOfLines={2} style={{ fontSize: 17, color: titleColor }}>
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
      {onPress && <Text style={{ fontSize: 20, color: colors.tertiaryLabel }}>›</Text>}
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
        <Text style={{ fontSize: 16, color: colors.secondaryLabel }}>{label}</Text>
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
    <View style={{ alignItems: 'center', gap: 8, paddingVertical: 48, paddingHorizontal: 12 }}>
      <Text style={{ fontSize: 19, fontWeight: '600', color: colors.label, textAlign: 'center' }}>{title}</Text>
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
        borderRadius: 14,
        borderCurve: 'continuous',
        padding: 14,
        gap: 4,
        backgroundColor: colors.card,
        borderLeftWidth: 4,
        borderLeftColor: toneColor(tone),
      }}
    >
      <Text selectable style={{ fontSize: 15, fontWeight: '600', color: colors.label }}>
        {title}
      </Text>
      {body && (
        <Text selectable style={{ fontSize: 14, lineHeight: 20, color: colors.secondaryLabel }}>
          {body}
        </Text>
      )}
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
    <View style={{ borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: colors.fill }}>
      <Text style={{ fontSize: 12, fontWeight: '600', color }}>{label}</Text>
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
