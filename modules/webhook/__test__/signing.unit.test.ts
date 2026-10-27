// Each scheme against a request: signed right, with the wrong secret, with no
// signature, and (Stripe) too old.

import { createHmac } from 'node:crypto';

import { signingOf, stripeSignature, verify, type Signed } from '../signing';

const BODY = '{"id":"pay_1","amount":1200}';
const NOW = 1_800_000_000;

function signed(headers: Record<string, string>, body = BODY): Signed {
  return { header: (name) => headers[name.toLowerCase()], bytes: Buffer.from(body, 'utf-8') };
}

describe('stripe', () => {
  const signing = signingOf('StripeHook', { scheme: 'stripe', secret: 'whsec_test' });

  it('accepts a signature made with the secret, within the tolerance', () => {
    expect(verify(signing, signed({ 'stripe-signature': stripeSignature('whsec_test', BODY, NOW - 60) }), NOW)).toEqual({ ok: true });
  });

  it('accepts when any v1 matches, as Stripe sends one per secret while rolling it', () => {
    const good = stripeSignature('whsec_test', BODY, NOW).split(',v1=')[1];
    expect(verify(signing, signed({ 'stripe-signature': `t=${NOW},v1=${'0'.repeat(64)},v1=${good}` }), NOW)).toEqual({ ok: true });
  });

  it('refuses a signature made with another secret', () => {
    expect(verify(signing, signed({ 'stripe-signature': stripeSignature('whsec_other', BODY, NOW) }), NOW)).toEqual({ ok: false, reason: 'the signature does not match the secret' });
  });

  it('refuses a body changed after signing', () => {
    expect(verify(signing, signed({ 'stripe-signature': stripeSignature('whsec_test', BODY, NOW) }, BODY.replace('1200', '1')), NOW).ok).toBe(false);
  });

  it('refuses a request with no signature header, or one without t and v1', () => {
    expect(verify(signing, signed({}), NOW)).toEqual({ ok: false, reason: 'no stripe-signature header' });
    expect(verify(signing, signed({ 'stripe-signature': 'v0=abc' }), NOW)).toEqual({ ok: false, reason: 'the stripe-signature header has no t= and v1=' });
  });

  it('refuses a stale timestamp, older than five minutes', () => {
    expect(verify(signing, signed({ 'stripe-signature': stripeSignature('whsec_test', BODY, NOW - 301) }), NOW)).toEqual({ ok: false, reason: 'the signature is older than 300 seconds' });
  });
});

describe('hmac-sha256', () => {
  const digest = (secret: string, encoding: 'hex' | 'base64') => createHmac('sha256', secret).update(BODY).digest(encoding);

  it('accepts a hex digest in the named header, with or without sha256=', () => {
    const signing = signingOf('Forms', { scheme: 'hmac-sha256', secret: 's3cret', header: 'X-Signature' });
    expect(verify(signing, signed({ 'x-signature': digest('s3cret', 'hex') }), NOW)).toEqual({ ok: true });
    expect(verify(signing, signed({ 'x-signature': `sha256=${digest('s3cret', 'hex')}` }), NOW)).toEqual({ ok: true });
  });

  it('accepts a base64 digest when the credential says base64', () => {
    const signing = signingOf('Forms', { scheme: 'hmac-sha256', secret: 's3cret', header: 'x-signature', encoding: 'base64' });
    expect(verify(signing, signed({ 'x-signature': digest('s3cret', 'base64') }), NOW)).toEqual({ ok: true });
    expect(verify(signing, signed({ 'x-signature': digest('s3cret', 'hex') }), NOW).ok).toBe(false);
  });

  it('refuses another secret and a missing header', () => {
    const signing = signingOf('Forms', { scheme: 'hmac-sha256', secret: 's3cret', header: 'x-signature' });
    expect(verify(signing, signed({ 'x-signature': digest('other', 'hex') }), NOW)).toEqual({ ok: false, reason: 'the signature does not match the secret' });
    expect(verify(signing, signed({}), NOW)).toEqual({ ok: false, reason: 'no x-signature header' });
  });
});

describe('none', () => {
  it('accepts an unsigned request: the credential says so', () => {
    expect(verify(signingOf('Open', { scheme: 'none' }), signed({}), NOW)).toEqual({ ok: true });
  });
});

describe('a credential that does not say how', () => {
  it('is refused by name, with what to set', () => {
    expect(() => signingOf('Hook', {})).toThrow('the webhook credential Hook names no scheme: it is one of stripe, hmac-sha256, none');
    expect(() => signingOf('Hook', { scheme: 'github' })).toThrow('names the scheme "github"');
    expect(() => signingOf('Hook', { scheme: 'stripe' })).toThrow('is signed with stripe but holds no secret');
    expect(() => signingOf('Hook', { scheme: 'hmac-sha256', secret: 'x' })).toThrow('names no header');
    expect(() => signingOf('Hook', { scheme: 'hmac-sha256', secret: 'x', header: 'x-sig', encoding: 'b32' })).toThrow('it is hex or base64');
  });
});
