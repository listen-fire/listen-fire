/**
 * The valuations delivery loop (V-16).
 *
 * The copy has to be a faithful one, because integrators depend on the parts
 * that look incidental: the HMAC over the RAW body, the base-7 backoff, and the
 * fact that removing a destination stops its queued deliveries rather than
 * retrying them to exhaustion. Those are what this pins; the payload shape is
 * the outbox worker's and is asserted end-to-end in `verify_valuations_delivery`.
 */

import { createHmac } from 'node:crypto';

import { signPayload } from '../delivery';

describe('signPayload', () => {
  it('is HMAC-SHA256 hex over the body, unprefixed — the header integrators already verify', () => {
    const body = JSON.stringify({ event: 'valuations:investment:update' });
    expect(signPayload(body, 's3cret')).toBe(
      createHmac('sha256', 's3cret').update(body).digest('hex'),
    );
  });

  it('signs the exact bytes sent, not a re-serialisation of them', () => {
    // Two JSON strings with the same MEANING and different bytes must not share
    // a signature — otherwise a receiver that re-serialises before verifying
    // would appear to work until the day key order changed.
    const a = '{"a":1,"b":2}';
    const b = '{"b":2,"a":1}';
    expect(signPayload(a, 'k')).not.toBe(signPayload(b, 'k'));
  });
});

describe('the delivery loop, as source', () => {
  // Same idiom as the dispatch-gate wiring tests: the loop's load-bearing
  // properties are structural, and driving them needs a live DB (which
  // `verify_valuations_delivery` does).
  const src = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '..', 'delivery.ts'),
    'utf-8',
  ) as string;

  it('skips deleted AND disabled destinations when claiming', () => {
    expect(src).toMatch(/\.where\('s\.deleted_at', 'is', null\)/);
    expect(src).toMatch(/\.where\('s\.disabled_at', 'is', null\)/);
  });

  it('backs off on base 7, as the legacy loop did', () => {
    expect(src).toMatch(/Math\.pow\(7, attempts\) \* 1000/);
  });

  it('reads the destination through the subscription rather than snapshotting it', () => {
    expect(src).toMatch(/innerJoin\('webhook_subscription as s', 's\.id', 'd\.subscription_id'\)/);
    expect(src).toMatch(/\.select\(\['d\.id', 's\.url', 's\.secret'/);
  });

  it('an unsigned subscription sends no signature header at all', () => {
    expect(src).toMatch(/if \(row\.secret\) headers\['X-Webhook-Signature'\]/);
  });
});
