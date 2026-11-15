// Keyboard helpers for the chat screen (the same approach as the allob app's chat).
//
// useAreaGap: the distance from the bottom of the chat area to the bottom of the window — what the keyboard covers below
// the chat (the gesture bar / home indicator inset). When the keyboard opens, the composer and the list rise by the
// keyboard height minus this, so they sit right on top of the keyboard. Measured on first layout and again each time the
// keyboard starts to open (so a value taken mid-transition does not stick).
//
// useDragFollow: on Android, while a finger drags the keyboard down, the chat list (KeyboardChatScrollView) does not
// follow the keyboard height, so only the composer moves and the messages jump at the end. This moves the list down by
// the same amount during the drag and back to 0 on the frame the list's inset changes. iOS follows on its own.

import { type ComponentRef, useCallback, useRef, useState } from 'react';
import { Platform, type View } from 'react-native';
import { useKeyboardHandler, useWindowDimensions } from 'react-native-keyboard-controller';
import { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

export function useAreaGap() {
  const ref = useRef<ComponentRef<typeof View>>(null);
  // the window height on the keyboard's terms (Android draws under the system bars, so it can differ from RN's)
  const { height: windowHeight } = useWindowDimensions();
  const [gap, setGap] = useState(0);
  const measure = useCallback(
    () =>
      ref.current?.measureInWindow((_x: number, y: number, _w: number, h: number) => {
        const next = Math.max(0, Math.round(windowHeight - (y + h)));
        setGap((g) => {
          if (g === next) return g;
          return next;
        });
      }),
    [windowHeight],
  );
  useKeyboardHandler(
    {
      onStart: (e) => {
        'worklet';
        if (e.height > 0) scheduleOnRN(measure);
      },
    },
    [measure],
  );
  return { ref, gap, onLayout: measure };
}

export function useDragFollow(gap: number) {
  const drag = useSharedValue(0);
  const opened = useSharedValue(0);
  const dragging = useSharedValue(false);
  useKeyboardHandler(
    {
      onStart: (e) => {
        'worklet';
        if (e.height > 0 && !dragging.value) opened.value = e.height;
      },
      onInteractive: (e) => {
        'worklet';
        dragging.value = true;
        drag.value = Math.max(0, Math.max(0, opened.value - gap) - Math.max(0, e.height - gap));
      },
      onMove: (e) => {
        'worklet';
        if (dragging.value) drag.value = Math.max(0, Math.max(0, opened.value - gap) - Math.max(0, e.height - gap));
      },
      onEnd: (e) => {
        'worklet';
        dragging.value = false;
        drag.value = 0;
        if (e.height > 0) opened.value = e.height;
      },
    },
    [gap],
  );
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: drag.value }] }));
  if (Platform.OS === 'android') return style;
  return null;
}
