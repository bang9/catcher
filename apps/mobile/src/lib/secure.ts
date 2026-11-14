// The owner key lives only here: the iOS keychain / Android keystore, readable while the phone is unlocked and
// never synced or backed up to another device. Never log it and never copy it into SQLite.

import * as SecureStore from 'expo-secure-store';
import type { OwnerState } from '@catcher/client';

const KEY = 'catcher.owner.v1';
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

function isOwnerState(value: unknown): value is OwnerState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.server === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.seed === 'string' &&
    typeof v.keySeq === 'number' &&
    typeof v.seq === 'number'
  );
}

export async function loadOwnerState(): Promise<OwnerState | null> {
  const raw = await SecureStore.getItemAsync(KEY, OPTIONS);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isOwnerState(parsed)) return parsed;
  } catch {
    // unreadable entry — treat as no owner
  }
  return null;
}

/**
 * "Recovery code was shown and confirmed" lives next to the key: the keychain survives an app reinstall while
 * SQLite does not, and a reinstall must not show the code again without device authentication.
 */
const ONBOARDED_KEY = 'catcher.onboarded.v1';

export function loadOnboarded(): boolean {
  return SecureStore.getItem(ONBOARDED_KEY, OPTIONS) === '1';
}

export function saveOnboarded(): void {
  SecureStore.setItem(ONBOARDED_KEY, '1', OPTIONS);
}

/** Synchronous on purpose: OwnerClient calls save() mid-rotation and expects it to be durable on return. */
export function saveOwnerState(state: OwnerState): void {
  SecureStore.setItem(KEY, JSON.stringify(state), OPTIONS);
}
