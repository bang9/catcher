// Runtime gaps in Hermes that @catcher/protocol relies on. Loaded first by index.ts.
// - crypto.getRandomValues: @noble/hashes randomBytes (keys, nonces). Backed by expo-crypto (native CSPRNG).
// - TextDecoder with { fatal: true }: protocol rejects invalid UTF-8 instead of replacing it.
// Each polyfill is installed only when the native one is missing or does not behave.

import { getRandomValues } from 'expo-crypto';
import { Utf8Decoder, Utf8Encoder } from './utf8.ts';

type CryptoLike = { getRandomValues?: (array: Uint8Array) => Uint8Array };
const scope = globalThis as unknown as {
  crypto?: CryptoLike;
  TextEncoder?: typeof TextEncoder;
  TextDecoder?: typeof TextDecoder;
};

if (!scope.crypto) scope.crypto = {};
if (typeof scope.crypto.getRandomValues !== 'function') {
  scope.crypto.getRandomValues = (array: Uint8Array) => getRandomValues(array);
}

function encoderWorks(): boolean {
  try {
    const bytes = new TextEncoder().encode('€');
    return bytes.length === 3 && bytes[0] === 0xe2;
  } catch {
    return false;
  }
}

function decoderWorks(): boolean {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    if (decoder.decode(new Uint8Array([0xef, 0xbb, 0xbf, 0xe2, 0x82, 0xac])) !== '€') return false;
    try {
      decoder.decode(new Uint8Array([0xff]));
    } catch {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Which polyfills were installed — shown in dev logs only. */
export const polyfilled = { encoder: false, decoder: false };

if (!encoderWorks()) {
  scope.TextEncoder = Utf8Encoder as unknown as typeof TextEncoder;
  polyfilled.encoder = true;
}
if (!decoderWorks()) {
  scope.TextDecoder = Utf8Decoder as unknown as typeof TextDecoder;
  polyfilled.decoder = true;
}
