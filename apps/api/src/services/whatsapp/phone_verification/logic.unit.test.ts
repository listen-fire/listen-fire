// The pure decision core of the phone-verification loop — every rule that
// governs a code's life (cooldown, resend cap, expiry, attempts, match) lives
// here so it's testable with no DB and no clock of its own. The DB orchestrator
// (index.ts) only fetches rows, calls these, and applies the outcome.

import {
  PHONE_VERIFICATION,
  evaluateStart,
  evaluateConfirm,
  generateVerificationCode,
  hashVerificationCode,
  verificationCodeMatches,
  isVerifiedLink,
  type ActiveCode,
} from './logic';

const T0 = new Date('2026-07-09T12:00:00.000Z');
const at = (msFromT0: number) => new Date(T0.getTime() + msFromT0);

function activeCode(over: Partial<ActiveCode> = {}): ActiveCode {
  return {
    id: 'v1',
    codeHash: hashVerificationCode('123456'),
    expiresAt: at(PHONE_VERIFICATION.ttlMs),
    attempts: 0,
    sendCount: 1,
    lastSentAt: T0,
    ...over,
  };
}

describe('code generation + hashing', () => {
  it('generates a numeric code of the configured length', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateVerificationCode();
      expect(code).toMatch(new RegExp(`^\\d{${PHONE_VERIFICATION.codeLength}}$`));
    }
  });

  it('hashes (never stores the code in clear) and matches only the right code', () => {
    const hash = hashVerificationCode('123456');
    expect(hash).not.toContain('123456');
    expect(verificationCodeMatches('123456', hash)).toBe(true);
    expect(verificationCodeMatches('000000', hash)).toBe(false);
  });
});

describe('isVerifiedLink — the inbound routing gate', () => {
  it('routes only a phone that is both linked to a user AND verified', () => {
    const t = new Date();
    expect(isVerifiedLink({ userId: 'u1', verifiedAt: t })).toBe(true);
    expect(isVerifiedLink({ userId: 'u1', verifiedAt: null })).toBe(false); // linked but unverified
    expect(isVerifiedLink({ userId: null, verifiedAt: t })).toBe(false); // orphaned
    expect(isVerifiedLink({ userId: null, verifiedAt: null })).toBe(false);
  });
});

describe('evaluateStart', () => {
  it('no active code → insert a fresh one', () => {
    expect(evaluateStart({ existing: null, now: T0 })).toEqual({
      kind: 'send',
      mode: 'insert',
      sendCount: 1,
    });
  });

  it('a resend within the cooldown window is rejected', () => {
    const existing = activeCode({ lastSentAt: at(0) });
    expect(evaluateStart({ existing, now: at(PHONE_VERIFICATION.resendCooldownMs - 1) })).toEqual({
      kind: 'reject',
      reason: 'cooldown',
    });
  });

  it('a resend past the cooldown updates the row and bumps the send count', () => {
    const existing = activeCode({ lastSentAt: at(0), sendCount: 2 });
    expect(evaluateStart({ existing, now: at(PHONE_VERIFICATION.resendCooldownMs) })).toEqual({
      kind: 'send',
      mode: 'update',
      sendCount: 3,
    });
  });

  it('too many sends is rejected while the code is still live', () => {
    const existing = activeCode({ lastSentAt: at(0), sendCount: PHONE_VERIFICATION.maxSends });
    expect(evaluateStart({ existing, now: at(PHONE_VERIFICATION.resendCooldownMs * 3) })).toEqual({
      kind: 'reject',
      reason: 'too_many_sends',
    });
  });

  it('a lapsed (expired) code starts a fresh cycle — never a lockout', () => {
    const existing = activeCode({
      expiresAt: at(1000),
      sendCount: PHONE_VERIFICATION.maxSends,
      lastSentAt: at(0),
    });
    expect(evaluateStart({ existing, now: at(2000) })).toEqual({
      kind: 'send',
      mode: 'update',
      sendCount: 1,
    });
  });
});

describe('evaluateConfirm', () => {
  it('no active code → rejected', () => {
    expect(evaluateConfirm({ existing: null, now: T0, code: '123456' })).toEqual({
      kind: 'reject',
      reason: 'no_active_code',
      incrementAttempts: false,
    });
  });

  it('an expired code → rejected, no attempt burned', () => {
    const existing = activeCode({ expiresAt: at(1000) });
    expect(evaluateConfirm({ existing, now: at(2000), code: '123456' })).toEqual({
      kind: 'reject',
      reason: 'expired',
      incrementAttempts: false,
    });
  });

  it('attempts exhausted → rejected before comparing', () => {
    const existing = activeCode({ attempts: PHONE_VERIFICATION.maxAttempts });
    expect(evaluateConfirm({ existing, now: T0, code: '123456' })).toEqual({
      kind: 'reject',
      reason: 'too_many_attempts',
      incrementAttempts: false,
    });
  });

  it('a wrong code → rejected AND burns an attempt', () => {
    const existing = activeCode();
    expect(evaluateConfirm({ existing, now: T0, code: '000000' })).toEqual({
      kind: 'reject',
      reason: 'invalid_code',
      incrementAttempts: true,
    });
  });

  it('the right code within TTL and attempts → accepted', () => {
    const existing = activeCode();
    expect(evaluateConfirm({ existing, now: at(1000), code: '123456' })).toEqual({ kind: 'accept' });
  });
});
