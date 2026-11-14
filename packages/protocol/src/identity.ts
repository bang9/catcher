// Identities — one 32-byte seed per owner key generation and per agent. Both key pairs derive from it,
// so the seed alone is the backup (owner recovery code) and the only secret an agent stores.

import { b32, b64, concat, equalBytes, groups, unb32, utf8 } from './bytes.ts';
import { boxPublic, derive, randomBytes, type Random, sha256, signPublic } from './crypto.ts';

export interface Identity {
  seed: Uint8Array;
  signSecret: Uint8Array;
  signPub: Uint8Array;
  boxSecret: Uint8Array;
  boxPub: Uint8Array;
}

export interface PublicKeys {
  /** Ed25519 public key, base64url */
  signPub: string;
  /** X25519 public key, base64url */
  boxPub: string;
}

export function identityFromSeed(seed: Uint8Array): Identity {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  const signSecret = derive(seed, 'catcher/v1/sign');
  const boxSecret = derive(seed, 'catcher/v1/box');
  return { seed, signSecret, signPub: signPublic(signSecret), boxSecret, boxPub: boxPublic(boxSecret) };
}

export function newIdentity(random: Random = randomBytes): Identity {
  return identityFromSeed(random(32));
}

export function publicKeys(id: Identity): PublicKeys {
  return { signPub: b64(id.signPub), boxPub: b64(id.boxPub) };
}

/** 16 characters people compare between the CLI and the app: ABCD-EFGH-JKMN-PQRS */
export function fingerprint(keys: PublicKeys): string {
  const digest = sha256(concat(utf8('catcher/v1/fingerprint'), utf8(keys.signPub), utf8('.'), utf8(keys.boxPub)));
  return groups(b32(digest.subarray(0, 10)));
}

/** Owner id is fixed at first key generation and survives key rotation. */
export function ownerIdFor(genesisSignPub: string): string {
  return `o_${b32(sha256(concat(utf8('catcher/v1/owner'), utf8(genesisSignPub))).subarray(0, 12)).toLowerCase()}`;
}

export function randomId(prefix: 'a' | 'm' | 'g' | 'p', random: Random = randomBytes): string {
  let length = 10;
  if (prefix === 'm') length = 16;
  return `${prefix}_${b32(random(length)).toLowerCase()}`;
}

export const ID_PATTERN = {
  owner: /^o_[0-9a-z]{20}$/,
  agent: /^a_[0-9a-z]{16}$/,
  envelope: /^m_[0-9a-z]{26}$/,
  grant: /^g_[0-9a-z]{16}$/,
} as const;

/** Recovery code: seed + 2-byte checksum in Crockford base32, grouped by 5 (11 groups). */
export function recoveryCode(seed: Uint8Array): string {
  const check = sha256(concat(utf8('catcher/v1/recovery'), seed)).subarray(0, 2);
  return groups(b32(concat(seed, check)), 5);
}

export function seedFromRecoveryCode(code: string): Uint8Array {
  const raw = unb32(code);
  if (raw.length < 34) throw new Error('recovery code is too short');
  const seed = raw.subarray(0, 32);
  const check = raw.subarray(32, 34);
  const expected = sha256(concat(utf8('catcher/v1/recovery'), seed)).subarray(0, 2);
  if (!equalBytes(check, expected)) throw new Error('recovery code has a typo');
  return new Uint8Array(seed);
}
