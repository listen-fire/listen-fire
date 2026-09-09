import { createHmac, timingSafeEqual } from 'node:crypto';

import { signMailgunPayload } from './mailgun-sign';

/**
 * The signature contract the inbound mailgun adapter verifies. Lifted
 * verbatim from `InboundMailgunAdapter.verifyMailgunValues` so the test
 * fails loudly if either side drifts.
 */
function verify(apiKey: string, ts: string, token: string, signature: string): boolean {
  const expected = createHmac('sha256', apiKey).update(ts + token).digest('hex');
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

describe('signMailgunPayload', () => {
  test('produces a signature that the adapter verifier accepts', () => {
    const sig = signMailgunPayload({ apiKey: 'test-harness-dummy-key' });
    expect(verify('test-harness-dummy-key', sig.timestamp, sig.token, sig.signature)).toBe(true);
  });

  test('honours an explicit timestamp + token', () => {
    const sig = signMailgunPayload({
      apiKey: 'k',
      timestamp: '1700000000',
      token: 'fixed-token',
    });
    expect(sig.timestamp).toBe('1700000000');
    expect(sig.token).toBe('fixed-token');
    expect(verify('k', '1700000000', 'fixed-token', sig.signature)).toBe(true);
  });

  test('signatures differ across api keys', () => {
    const a = signMailgunPayload({ apiKey: 'key-a', timestamp: '1', token: 't' });
    const b = signMailgunPayload({ apiKey: 'key-b', timestamp: '1', token: 't' });
    expect(a.signature).not.toBe(b.signature);
  });

  test('rejects a tampered signature', () => {
    const sig = signMailgunPayload({ apiKey: 'k', timestamp: '1', token: 't' });
    const tampered = sig.signature.replace(/^./, sig.signature[0] === '0' ? '1' : '0');
    expect(verify('k', '1', 't', tampered)).toBe(false);
  });
});
