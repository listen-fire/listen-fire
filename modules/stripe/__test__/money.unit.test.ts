// Stripe's minor units to major ones, by Stripe's own currency lists.

import { majorUnits, minorDigits } from '../money';

describe('majorUnits', () => {
  it('divides a two-decimal currency by 100, whatever the case of its code', () => {
    expect(majorUnits(1999, 'usd')).toBe(19.99);
    expect(majorUnits(4900, 'EUR')).toBe(49);
    expect(majorUnits(-250, 'gbp')).toBe(-2.5);
  });

  it('takes a zero-decimal currency as it is', () => {
    expect(majorUnits(500, 'jpy')).toBe(500);
    expect(majorUnits(25000, 'krw')).toBe(25000);
    for (const code of ['bif', 'clp', 'djf', 'gnf', 'kmf', 'mga', 'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']) expect(minorDigits(code)).toBe(0);
  });

  it('divides a three-decimal currency by 1000', () => {
    expect(majorUnits(5120, 'kwd')).toBe(5.12);
    for (const code of ['bhd', 'jod', 'kwd', 'omr', 'tnd']) expect(minorDigits(code)).toBe(3);
  });

  it('reads ISK and UGX as Stripe sends them, two-decimal values with 00 decimals', () => {
    expect(majorUnits(500, 'isk')).toBe(5);
    expect(majorUnits(500, 'ugx')).toBe(5);
  });

  it('keeps an amount it cannot read by a currency unread, but zero is zero', () => {
    expect(majorUnits(null, 'usd')).toBeNull();
    expect(majorUnits(1200, null)).toBeNull();
    expect(majorUnits(0, null)).toBe(0);
  });
});
