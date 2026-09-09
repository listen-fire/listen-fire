// Pure decision core for the WhatsApp phone-verification loop. No DB, no wall
// clock of its own — the caller passes `now` and the already-fetched active row,
// so every rule (cooldown, resend cap, expiry, attempts, code match) is
// exercised in isolation. The orchestrator (index.ts) fetches, calls these, and
// applies the outcome.

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { getEnvVar } from '../../../lib/utils/environment';

export const PHONE_VERIFICATION = {
  codeLength: 6,
  ttlMs: 10 * 60 * 1000,
  maxAttempts: 5,
  resendCooldownMs: 60 * 1000,
  maxSends: 5,
} as const;

/** The active (unconsumed) verification row, in the shape the decisions need. */
export interface ActiveCode {
  id: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  sendCount: number;
  lastSentAt: Date;
}

export type StartDecision =
  | { kind: 'send'; mode: 'insert' | 'update'; sendCount: number }
  | { kind: 'reject'; reason: 'cooldown' | 'too_many_sends' };

/** Whether we may (re)send a code, and whether that's a fresh insert or an
 *  update of the existing active row. Collision (number already verified to
 *  another account) is a DB fact resolved by the orchestrator, not here. */
export function evaluateStart(input: { existing: ActiveCode | null; now: Date }): StartDecision {
  const { existing, now } = input;
  if (!existing) return { kind: 'send', mode: 'insert', sendCount: 1 };

  // A lapsed code starts a fresh cycle — reset the resend budget so an expired
  // attempt can never lock the number out.
  if (existing.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'send', mode: 'update', sendCount: 1 };
  }

  const sinceLastSend = now.getTime() - existing.lastSentAt.getTime();
  if (sinceLastSend < PHONE_VERIFICATION.resendCooldownMs) return { kind: 'reject', reason: 'cooldown' };
  if (existing.sendCount >= PHONE_VERIFICATION.maxSends) return { kind: 'reject', reason: 'too_many_sends' };

  return { kind: 'send', mode: 'update', sendCount: existing.sendCount + 1 };
}

export type ConfirmDecision =
  | { kind: 'accept' }
  | {
      kind: 'reject';
      reason: 'no_active_code' | 'expired' | 'too_many_attempts' | 'invalid_code';
      incrementAttempts: boolean;
    };

/** Whether a submitted code verifies. Order matters: a missing/expired/locked
 *  code is rejected WITHOUT burning an attempt; only a genuinely wrong guess
 *  against a live code burns one. */
export function evaluateConfirm(input: {
  existing: ActiveCode | null;
  now: Date;
  code: string;
}): ConfirmDecision {
  const { existing, now, code } = input;
  if (!existing) return { kind: 'reject', reason: 'no_active_code', incrementAttempts: false };
  if (existing.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'reject', reason: 'expired', incrementAttempts: false };
  }
  if (existing.attempts >= PHONE_VERIFICATION.maxAttempts) {
    return { kind: 'reject', reason: 'too_many_attempts', incrementAttempts: false };
  }
  if (!verificationCodeMatches(code, existing.codeHash)) {
    return { kind: 'reject', reason: 'invalid_code', incrementAttempts: true };
  }
  return { kind: 'accept' };
}

/** The inbound routing gate: a phone_number row routes an incoming WhatsApp
 *  message to its team ONLY when it is both linked to a user AND verified. An
 *  unverified (or orphaned) row is invisible to routing. */
export function isVerifiedLink(row: { userId: string | null; verifiedAt: Date | null }): boolean {
  return row.userId != null && row.verifiedAt != null;
}

/** A random numeric code, leading zeros preserved (it's a string). */
export function generateVerificationCode(): string {
  const max = 10 ** PHONE_VERIFICATION.codeLength;
  return randomInt(0, max).toString().padStart(PHONE_VERIFICATION.codeLength, '0');
}

/**
 * HMAC-SHA256 the code under a server pepper so a leaked row never yields the
 * code. The pepper is process-wide; rotating it invalidates in-flight codes
 * (harmless — they live minutes).
 *
 * The dev default used to apply in production too, which made the pepper a
 * constant published in the source: a six-digit code has a million candidates,
 * so anyone with the literal and a leaked row brute-forces the code in
 * milliseconds. `getEnvVar`'s `devDefault` applies ONLY outside production,
 * which is the intent — convenient locally, required to be supplied in prod.
 * Read per call rather than at module load so a deployment that never verifies
 * a phone still boots.
 */
function codePepper(): string {
  return getEnvVar('PHONE_VERIFICATION_SECRET', {
    devDefault: 'dev-phone-verification-pepper',
    because:
      'it peppers the stored hash of a 6-digit verification code — without a ' +
      'secret only this deployment knows, a leaked row yields the code by ' +
      'exhaustive search in milliseconds',
  });
}

export function hashVerificationCode(code: string): string {
  return createHmac('sha256', codePepper()).update(code).digest('hex');
}

export function verificationCodeMatches(code: string, codeHash: string): boolean {
  const candidate = Buffer.from(hashVerificationCode(code), 'hex');
  const stored = Buffer.from(codeHash, 'hex');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
