// Password hashing — scrypt (salted, slow, memory-hard). The correct primitive
// for LOW-entropy human passwords, unlike:
//   • the fast SHA-256 used for HIGH-entropy Listen-Fire API keys (too fast — a
//     password would be brute-forceable), or
//   • the reversible AES-GCM used for external credentials (passwords must never
//     be decryptable).
//
// The stored form is self-describing — `scrypt$N$r$p$saltB64$hashB64` — so the
// cost parameters can be raised later for NEW hashes while existing hashes still
// verify against the params embedded in their own string. Verification is
// constant-time and never throws (any malformed input just fails to verify).

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// Cost parameters for NEW hashes (OWASP-aligned: N=2^15). Encoded into the hash.
const PARAMS = { N: 32768, r: 8, p: 1 } as const;
const KEYLEN = 64;
const SALT_BYTES = 16;
const MIN_LENGTH = 8;

/** maxmem must exceed 128·N·r; give generous headroom (Node's 32 MB default is
 *  too low for these params). */
function maxmemFor(N: number, r: number): number {
  return 128 * N * r * 4;
}

/** Hash a plaintext password → `scrypt$N$r$p$saltB64$hashB64`. */
async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const { N, r, p } = PARAMS;
  const hash = await scrypt(plain, salt, KEYLEN, { N, r, p, maxmem: maxmemFor(N, r) });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Verify a plaintext against a stored `scrypt$...` string. Constant-time; returns
 * false (never throws) on any malformed / tampered input.
 */
async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
    const N = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;

    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = await scrypt(plain, salt, expected.length, { N, r, p, maxmem: maxmemFor(N, r) });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Minimal password policy, centralised so it can tighten later without ripple. */
function isPasswordAcceptable(plain: string): { ok: true } | { ok: false; reason: string } {
  if (typeof plain !== 'string' || plain.trim().length === 0) {
    return { ok: false, reason: 'Password must not be blank.' };
  }
  if (plain.length < MIN_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_LENGTH} characters.` };
  }
  return { ok: true };
}

export { hashPassword, verifyPassword, isPasswordAcceptable };
