// Thin wrappers over @noble so the rest of the code never touches curve APIs directly.

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils.js';
import { utf8 } from './bytes.ts';

export type Random = (length: number) => Uint8Array;

/** Uses crypto.getRandomValues — React Native needs a polyfill (expo-crypto / react-native-get-random-values) loaded first. */
export const randomBytes: Random = (length) => nobleRandomBytes(length);

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function derive(ikm: Uint8Array, info: string, length = 32, salt?: Uint8Array): Uint8Array {
  return hkdf(nobleSha256, ikm, salt, utf8(info), length);
}

export function signPublic(secret: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secret);
}

export function sign(message: Uint8Array, secret: Uint8Array): Uint8Array {
  return ed25519.sign(message, secret);
}

export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

export function boxPublic(secret: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secret);
}

export function sharedSecret(secret: Uint8Array, peerPublic: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(secret, peerPublic);
}

export function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

export function unseal(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, nonce, aad).decrypt(ciphertext);
}
