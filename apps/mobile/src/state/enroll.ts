// Agent registration from the owner's side: an agent prints a 16-character code (or a link with it); the owner types or
// opens it here, checks the confirm sheet, and claims the agent in one step. Nothing is ever claimed without that tap.

import { ApiError, EnrollmentError, type EnrollmentPreview, RollbackError } from '@catcher/client';
import { CROCKFORD, EnrollCodeError, groups, normalizeB32, parseEnrollCode } from '@catcher/protocol';
import { describeError } from '@/lib/errors';
import { t } from '@/i18n';
import { requireOwner, setState } from './store';
import { saveMismatches, sync } from './sync';

const CODE_CHARS = 16;

/**
 * Tidy what the person typed or pasted: a pasted link keeps only the part after '#', letters go upper case, anything
 * that is not a code character is dropped, and the rest is grouped XXXX-XXXX-XXXX-XXXX.
 */
export function formatCodeInput(text: string): string {
  let raw = text;
  const hash = raw.lastIndexOf('#');
  if (hash >= 0) raw = raw.slice(hash + 1);
  const query = /[?&]code=([^&]+)/i.exec(raw);
  if (query?.[1]) raw = decodeURIComponent(query[1]);
  const clean = [...normalizeB32(raw)].filter((c) => CROCKFORD.includes(c)).join('');
  return groups(clean.slice(0, CODE_CHARS), 4);
}

export function codeIsComplete(text: string): boolean {
  return normalizeB32(text).length === CODE_CHARS;
}

/** Local check only (length, alphabet, check character). Returns a sentence to show, or null when it looks right. */
export function localCodeProblem(text: string): string | null {
  try {
    parseEnrollCode(text);
    return null;
  } catch (e) {
    return describeEnrollError(e);
  }
}

const previews = new Map<string, EnrollmentPreview>();

/** Look a code up on the relay and check it against the agent's keys. The only part that leaves the phone is the lookup. */
export async function lookupCode(code: string): Promise<EnrollmentPreview> {
  const owner = requireOwner();
  try {
    const preview = await owner.lookupEnrollment(code);
    previews.set(formatCodeInput(code), preview);
    return preview;
  } finally {
    saveMismatches(owner);
  }
}

/** The preview the entry screen already fetched for this code, so the confirm sheet opens without a second request. */
export function cachedPreview(code: string): EnrollmentPreview | undefined {
  return previews.get(formatCodeInput(code));
}

/** The approve tap. `replace` revokes the live agent of the same name first. */
export async function claimCode(code: string, replace: boolean): Promise<{ agentId: string; name: string }> {
  const owner = requireOwner();
  try {
    const result = await owner.claimEnrollment(code, { replace });
    previews.delete(formatCodeInput(code));
    await sync().catch(() => undefined);
    return result;
  } finally {
    saveMismatches(owner);
  }
}

/** A code from a link: keep it until the owner exists and has finished onboarding. */
export function holdEnrollCode(code: string): void {
  setState({ heldEnrollCode: formatCodeInput(code) });
}

export function releaseHeldCode(): void {
  setState({ heldEnrollCode: null });
}

/** One plain sentence for anything that can go wrong between typing a code and claiming the agent. */
export function describeEnrollError(e: unknown): string {
  if (e instanceof EnrollCodeError) {
    if (e.code === 'bad_length') return t('enroll.error.length');
    if (e.code === 'bad_char') return t('enroll.error.char');
    return t('enroll.error.check');
  }
  if (e instanceof EnrollmentError) {
    if (e.code === 'tag_mismatch') return t('enroll.error.mismatch');
    if (e.code === 'locked') return t('enroll.error.locked');
    if (e.code === 'nothing_to_replace') return t('enroll.error.nothingToReplace');
    return t('enroll.error.badStatement');
  }
  if (e instanceof ApiError) {
    if (e.code === 'bad_code') return t('enroll.error.badCode');
    if (e.code === 'claimed') return t('enroll.error.claimed');
    if (e.code === 'name_taken') return t('enroll.error.nameTaken');
  }
  return describeError(e);
}

/**
 * Errors where editing the code cannot help: the code is done for (a new one is needed from the agent), or the relay
 * served an older permission list (nothing is retried automatically).
 */
export function needsNewCode(e: unknown): boolean {
  if (e instanceof RollbackError) return true;
  if (e instanceof EnrollmentError) return e.code === 'locked';
  if (e instanceof ApiError) return e.code === 'claimed';
  return false;
}
