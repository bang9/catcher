// Text in Pretendard. Static font files carry one weight each, so a fontWeight in the style picks the file instead of
// asking the platform to fake it. Use this everywhere in place of react-native's Text.

import { Text as RNText, StyleSheet, type TextProps, type TextStyle } from 'react-native';

const FAMILY: Record<string, string> = {
  '100': 'Pretendard-Regular',
  '200': 'Pretendard-Regular',
  '300': 'Pretendard-Regular',
  '400': 'Pretendard-Regular',
  normal: 'Pretendard-Regular',
  '500': 'Pretendard-Medium',
  '600': 'Pretendard-SemiBold',
  '700': 'Pretendard-Bold',
  bold: 'Pretendard-Bold',
  '800': 'Pretendard-Bold',
  '900': 'Pretendard-Bold',
};

export const fontFamily = FAMILY;

export function Text({ style, ...props }: TextProps) {
  const flat: TextStyle = StyleSheet.flatten(style) ?? {};
  // monospace codes and icon fonts keep their own family
  if (flat.fontFamily) return <RNText {...props} style={style} />;
  const family = FAMILY[String(flat.fontWeight ?? '400')] ?? FAMILY['400'];
  return <RNText {...props} style={[style, { fontFamily: family, fontWeight: undefined }]} />;
}
