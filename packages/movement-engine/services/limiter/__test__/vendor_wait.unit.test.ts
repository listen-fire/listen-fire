// A vendor's rate-limit wait (`vendorWaitMs`, one parser for every caller)
// and the throttle it becomes on the caller's key (`throttleAfter`).

import { MemoryLimiter, limitRequest, throttleAfter, vendorWaitMs } from '../../../public/limiter';

const NOW = Date.parse('2026-10-21T12:00:00Z');

describe('vendorWaitMs', () => {
  it('reads Retry-After seconds from a plain header object', () => {
    expect(vendorWaitMs({ headers: { 'retry-after': '7' } })).toBe(7000);
  });

  it('reads Retry-After from a fetch Headers object, and from a Response', () => {
    expect(vendorWaitMs({ headers: new Headers({ 'Retry-After': '7' }) })).toBe(7000);
    expect(vendorWaitMs(new Response(null, { status: 429, headers: { 'retry-after': '9' } }))).toBe(9000);
  });

  it("reads Retry-After from an error's response", () => {
    expect(vendorWaitMs({ response: { headers: { 'Retry-After': '5' } } })).toBe(5000);
  });

  it('reads Retry-After as an HTTP date', () => {
    const date = new Date(NOW + 30_000).toUTCString();
    expect(vendorWaitMs({ headers: { 'retry-after': date } }, NOW)).toBe(30_000);
  });

  it('reads Google RetryInfo from the error text', () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' }],
      },
    });
    expect(vendorWaitMs(new Error(body))).toBe(17_000);
  });

  it('reads a decoded retryDelay object', () => {
    expect(vendorWaitMs(new Error('{"retryDelay":{"seconds":9}}'))).toBe(9000);
  });

  it('is undefined when the vendor did not say', () => {
    expect(vendorWaitMs(new Error('429 Too Many Requests'))).toBeUndefined();
    expect(vendorWaitMs({ headers: { 'retry-after': 'soon' } })).toBeUndefined();
    expect(vendorWaitMs('nope')).toBeUndefined();
    expect(vendorWaitMs(null)).toBeUndefined();
  });

  it('clamps to the ceiling and the floor', () => {
    expect(vendorWaitMs({ headers: { 'retry-after': '600' } })).toBe(120_000);
    expect(vendorWaitMs({ headers: { 'retry-after': '0' } })).toBe(1000);
    expect(vendorWaitMs({ headers: { 'retry-after': new Date(NOW - 5_000).toUTCString() } }, NOW)).toBe(1000);
  });
});

describe('throttleAfter', () => {
  const caller = { module: '@acme/crm', credential: 'alice', team: 't' };

  it("closes the caller's key until the wait is over, and no other caller's", async () => {
    const limiter = new MemoryLimiter();
    const now = Date.now();
    await throttleAfter(limiter, caller, 7_000, now);
    const refused = await limiter.acquire(limitRequest(caller, []));
    expect(refused).toEqual({ granted: false, retryAt: new Date(now + 7_000).toISOString() });
    const other = await limiter.acquire(limitRequest({ ...caller, credential: 'bob' }, []));
    expect(other.granted).toBe(true);
  });
});
