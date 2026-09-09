// Password hashing helper — round-trips, negative cases, policy. Pure crypto,
// no mocks.

import { hashPassword, verifyPassword, isPasswordAcceptable } from '../password';

describe('hashPassword / verifyPassword', () => {
  it('round-trips the correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('s3cret-passw0rd');
    expect(await verifyPassword('s3cret-passw0rd ', stored)).toBe(false); // trailing space
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('uses a fresh salt each time (same password → different stored strings)', async () => {
    const a = await hashPassword('same-password-123');
    const b = await hashPassword('same-password-123');
    expect(a).not.toBe(b);
    // ...but both verify.
    expect(await verifyPassword('same-password-123', a)).toBe(true);
    expect(await verifyPassword('same-password-123', b)).toBe(true);
  });

  it('returns false (never throws) on malformed / tampered stored strings', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$32768$8$1$onlyfourparts')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$1$1$1$aa$bb')).toBe(false); // wrong scheme
    const stored = await hashPassword('tamper-me-please');
    // Flip a MID-segment char of the hash (last-char flips can be a base64 no-op
    // via unused trailing bits; a mid-segment flip reliably changes the bytes).
    const parts = stored.split('$');
    const h = parts[5];
    parts[5] = h.slice(0, 4) + (h[4] === 'A' ? 'B' : 'A') + h.slice(5);
    expect(await verifyPassword('tamper-me-please', parts.join('$'))).toBe(false);
  });
});

describe('isPasswordAcceptable', () => {
  it('accepts an 8+ character password', () => {
    expect(isPasswordAcceptable('abcdefgh')).toEqual({ ok: true });
  });
  it('rejects too-short and blank passwords', () => {
    expect(isPasswordAcceptable('short').ok).toBe(false);
    expect(isPasswordAcceptable('').ok).toBe(false);
    expect(isPasswordAcceptable('        ').ok).toBe(false); // blank/whitespace
  });
});
