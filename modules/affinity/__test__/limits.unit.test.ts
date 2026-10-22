// Affinity's limits are the limiter slot's: the module declares four requests
// in flight per credential, the client asks the slot before each request, and
// a 429 closes the credential's key for Affinity's Retry-After (else 30s), so
// every request on that key, the retry included, waits it out.

jest.mock('movement-engine/public/log', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { installLimiter, MemoryLimiter } from 'movement-engine/public/limiter';
import { AffinityAPIClient } from '../api_client';
import { affinityModule } from '../index';

const BASE = 'https://affinity.test';

function ok(): Response {
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}

function stubFetch(answer: (n: number) => Promise<Response>): () => number {
  let calls = 0;
  const stub: typeof fetch = async () => answer(++calls);
  global.fetch = stub;
  return () => calls;
}

function get(client: AffinityAPIClient): Promise<unknown> {
  return client.fetch({ route: '/organizations/1', method: 'GET' });
}

describe("Affinity's limits", () => {
  const original = global.fetch;

  beforeEach(() => installLimiter(new MemoryLimiter()));

  afterEach(() => {
    global.fetch = original;
    installLimiter(new MemoryLimiter());
    jest.useRealTimers();
  });

  it('declares four requests in flight per credential', () => {
    expect(affinityModule.limits).toEqual([{ scope: 'credential', concurrent: 4 }]);
  });

  it('sends at most four requests at once on one credential, and another credential is counted apart', async () => {
    const waiting: Array<() => void> = [];
    const calls = stubFetch(() => new Promise<Response>((resolve) => waiting.push(() => resolve(ok()))));
    const client = new AffinityAPIClient({ apiKey: 'limits-a', baseUrl: BASE });
    const requests = Array.from({ length: 6 }, () => get(client));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls()).toBe(4);

    const other = get(new AffinityAPIClient({ apiKey: 'limits-b', baseUrl: BASE }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls()).toBe(5);

    waiting.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls()).toBe(6);
    while (waiting.length > 0) {
      waiting.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await Promise.all([...requests, other]);
    expect(calls()).toBe(7);
  });

  it("a 429 closes the credential for Affinity's Retry-After: the retry and every other request wait it out", async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-22T12:00:00Z') });
    const calls = stubFetch(async (n) => (n === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }) : ok()));
    const client = new AffinityAPIClient({ apiKey: 'throttled', baseUrl: BASE });
    const first = get(client);
    await jest.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(1);

    const second = get(client);
    await jest.advanceTimersByTimeAsync(6_999);
    expect(calls()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(calls()).toBe(3);
  });

  it('a 429 naming no wait closes the credential for 30s', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-10-22T12:00:00Z') });
    const calls = stubFetch(async (n) => (n === 1 ? new Response('slow down', { status: 429 }) : ok()));
    const client = new AffinityAPIClient({ apiKey: 'throttled-default', baseUrl: BASE });
    const first = get(client);
    await jest.advanceTimersByTimeAsync(29_999);
    expect(calls()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    await first;
    expect(calls()).toBe(2);
  });
});
