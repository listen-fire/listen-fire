// Stripe's signature check, shared by `@lf/webhook` and `@lf/stripe`: signed
// right, with another secret, changed after signing, unsigned, malformed, and
// too old.

import { stripeSignature, verifyStripeSignature, type SignedRequest } from '../stripe_signature';

const BODY = '{"id":"evt_1","type":"invoice.payment_failed"}';
const NOW = 1_800_000_000;

function signed(headers: Record<string, string>, body = BODY): SignedRequest {
  return { header: (name) => headers[name.toLowerCase()], bytes: Buffer.from(body, 'utf-8') };
}

const check = (request: SignedRequest, toleranceSeconds?: number) =>
  verifyStripeSignature(request, { secret: 'whsec_test', nowSeconds: NOW, ...(toleranceSeconds !== undefined ? { toleranceSeconds } : {}) });

describe('verifyStripeSignature', () => {
  it('accepts a signature made with the secret, within the tolerance', () => {
    expect(check(signed({ 'stripe-signature': stripeSignature('whsec_test', BODY, NOW - 60) }))).toEqual({ ok: true });
  });

  it('accepts when any v1 matches, as Stripe sends one per secret while rolling it', () => {
    const good = stripeSignature('whsec_test', BODY, NOW).split(',v1=')[1];
    expect(check(signed({ 'stripe-signature': `t=${NOW},v1=${'0'.repeat(64)},v0=abc,v1=${good}` }))).toEqual({ ok: true });
  });

  it('refuses a signature made with another secret, and a body changed after signing', () => {
    expect(check(signed({ 'stripe-signature': stripeSignature('whsec_other', BODY, NOW) }))).toEqual({ ok: false, reason: 'the signature does not match the secret' });
    expect(check(signed({ 'stripe-signature': stripeSignature('whsec_test', BODY, NOW) }, BODY.replace('evt_1', 'evt_2'))).ok).toBe(false);
  });

  it('refuses a request with no header, or a header without t= and v1=, or with a v1 that is not hex', () => {
    expect(check(signed({}))).toEqual({ ok: false, reason: 'no stripe-signature header' });
    expect(check(signed({ 'stripe-signature': 'v0=abc' }))).toEqual({ ok: false, reason: 'the stripe-signature header has no t= and v1=' });
    expect(check(signed({ 'stripe-signature': `t=${NOW},v1=zz` }))).toEqual({ ok: false, reason: 'the signature does not match the secret' });
  });

  it('refuses a timestamp older than five minutes, or than the tolerance given', () => {
    expect(check(signed({ 'stripe-signature': stripeSignature('whsec_test', BODY, NOW - 300) }))).toEqual({ ok: true });
    expect(check(signed({ 'stripe-signature': stripeSignature('whsec_test', BODY, NOW - 301) }))).toEqual({ ok: false, reason: 'the signature is older than 300 seconds' });
    expect(check(signed({ 'stripe-signature': stripeSignature('whsec_test', BODY, NOW - 61) }), 60)).toEqual({ ok: false, reason: 'the signature is older than 60 seconds' });
  });
});
