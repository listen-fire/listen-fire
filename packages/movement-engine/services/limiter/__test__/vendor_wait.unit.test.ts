// A vendor's rate-limit wait (`vendorWaitMs`, one parser for every caller)
// and the throttle it becomes on the caller's key (`throttleAfter`).

import { MemoryLimiter, budgetAfter, limitRequest, throttleAfter, vendorBudget, vendorWaitMs } from '../../../public/limiter';

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

describe('vendorBudget', () => {
  const iso = (ms: number) => new Date(NOW + ms).toISOString();

  it("reads Anthropic's requests family, the reset as an ISO timestamp", () => {
    const headers = { 'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-requests-reset': iso(20_000) };
    expect(vendorBudget(headers, NOW)).toEqual({ remaining: 0, resetAt: NOW + 20_000 });
  });

  it("reads OpenAI's family, the reset as a duration", () => {
    const headers = new Headers({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '6s' });
    expect(vendorBudget(headers, NOW)).toEqual({ remaining: 0, resetAt: NOW + 6_000 });
    const compound = { 'x-ratelimit-remaining-requests': '3', 'x-ratelimit-reset-requests': '1m2.5s' };
    expect(vendorBudget(compound, NOW)).toEqual({ remaining: 3, resetAt: NOW + 62_500 });
    const millis = { 'x-ratelimit-remaining-tokens': '3', 'x-ratelimit-reset-tokens': '20ms' };
    expect(vendorBudget(millis, NOW)).toEqual({ remaining: 3, resetAt: NOW + 20 });
  });

  it('reads a reset given as plain seconds', () => {
    const headers = { 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '12' };
    expect(vendorBudget(headers, NOW)).toEqual({ remaining: 0, resetAt: NOW + 12_000 });
  });

  it('reports the binding limit: an exhausted one over a plentiful one', () => {
    const headers = {
      'anthropic-ratelimit-requests-remaining': '50',
      'anthropic-ratelimit-requests-reset': iso(5_000),
      'anthropic-ratelimit-tokens-remaining': '0',
      'anthropic-ratelimit-tokens-reset': iso(30_000),
    };
    expect(vendorBudget(headers, NOW)).toEqual({ remaining: 0, resetAt: NOW + 30_000 });
  });

  it('reports the least remaining when none is exhausted', () => {
    const headers = {
      'anthropic-ratelimit-requests-remaining': '50',
      'anthropic-ratelimit-requests-reset': iso(5_000),
      'anthropic-ratelimit-tokens-remaining': '9',
      'anthropic-ratelimit-tokens-reset': iso(30_000),
    };
    expect(vendorBudget(headers, NOW)).toEqual({ remaining: 9, resetAt: NOW + 30_000 });
  });

  it('clamps a far reset to the ceiling', () => {
    const headers = { 'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-requests-reset': iso(3_600_000) };
    expect(vendorBudget(headers, NOW)).toEqual({ remaining: 0, resetAt: NOW + 120_000 });
  });

  it('is undefined when the headers are missing, half given, or unreadable', () => {
    expect(vendorBudget({}, NOW)).toBeUndefined();
    expect(vendorBudget(new Headers(), NOW)).toBeUndefined();
    expect(vendorBudget({ 'anthropic-ratelimit-requests-remaining': '0' }, NOW)).toBeUndefined();
    expect(vendorBudget({ 'anthropic-ratelimit-requests-reset': iso(1_000) }, NOW)).toBeUndefined();
    expect(vendorBudget({ 'x-ratelimit-remaining-requests': 'lots', 'x-ratelimit-reset-requests': '1s' }, NOW)).toBeUndefined();
    expect(vendorBudget({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': 'soon' }, NOW)).toBeUndefined();
    expect(vendorBudget(null, NOW)).toBeUndefined();
  });
});

describe('budgetAfter', () => {
  const caller = { module: '@acme/crm', credential: 'alice', team: 't' };

  it('closes the key until the reset when the vendor reports none left', async () => {
    const limiter = new MemoryLimiter();
    const now = Date.now();
    await budgetAfter(limiter, caller, { remaining: 0, resetAt: now + 8_000 }, now);
    const refused = await limiter.acquire(limitRequest(caller, []));
    expect(refused).toEqual({ granted: false, retryAt: new Date(now + 8_000).toISOString() });
    const other = await limiter.acquire(limitRequest({ ...caller, credential: 'bob' }, []));
    expect(other.granted).toBe(true);
  });

  it('changes nothing while the vendor reports budget left, none known, or a reset already past', async () => {
    const limiter = new MemoryLimiter();
    const now = Date.now();
    await budgetAfter(limiter, caller, { remaining: 3, resetAt: now + 8_000 }, now);
    await budgetAfter(limiter, caller, undefined, now);
    await budgetAfter(limiter, caller, { remaining: 0, resetAt: now - 1 }, now);
    expect((await limiter.acquire(limitRequest(caller, []))).granted).toBe(true);
  });
});
