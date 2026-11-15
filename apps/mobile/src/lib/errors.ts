// Turn any failure into one sentence a person can act on.

import { ApiError, RollbackError } from '@catcher/client';
import { t } from '@/i18n';

export function describeError(e: unknown): string {
  if (e instanceof RollbackError) return t('error.rollback');
  if (e instanceof ApiError) {
    if (e.status === 0) return t('error.network');
    if (e.code === 'already_answered') return t('error.alreadyAnswered');
    if (e.code === 'rate_limited') return t('error.rateLimited');
    if (e.code === 'too_large') return t('error.tooLarge');
    if (e.status === 401) return t('error.auth');
    if (e.status === 404) return t('error.notFound');
    return t('error.generic', { detail: e.message });
  }
  const message = (e as Error)?.message ?? String(e);
  if (message.includes('typo')) return t('error.typo');
  if (message.includes('too short')) return t('error.tooShort');
  if (message.includes('bad base32')) return t('error.typo');
  if (message.includes('older key')) return t('error.oldKey');
  return t('error.generic', { detail: message });
}

/** Restore-specific: a 404 on lookup means no account for this code on this server. */
export function describeRestoreError(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) return t('error.noOwner');
  return describeError(e);
}
