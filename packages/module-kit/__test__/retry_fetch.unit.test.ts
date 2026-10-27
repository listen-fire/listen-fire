// `retryingFetch`: a fetch that sends a request again after a transient
// failure (429, 5xx, a network error) with exponential backoff and full
// jitter, honours Retry-After on 429/503, stops at its attempts or its waiting
// budget with an error naming both, and never retries what the caller's rule
// refuses or a status that is not transient.

import { RetriesExhaustedError, retryingFetch, networkErrorCode } from '../retry_fetch';

const URL_ = 'https://api.example.com/x';

type Step = { status: number; retryAfter?: string; body?: string } | { error: Error };

function script(steps: Step[]) {
  const sent: number[] = [];
  const impl: typeof fetch = async () => {
    sent.push(sent.length + 1);
    const step = steps.shift() ?? { status: 200 };
    if ('error' in step) throw step.error;
    return new Response(step.body ?? '{}', { status: step.status, headers: step.retryAfter === undefined ? {} : { 'retry-after': step.retryAfter } });
  };
  return { impl, sent };
}

function clock() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms), random: () => 1, now: () => Date.parse('2026-10-27T12:00:00Z') };
}

const connectionRefused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

test('a 503 then success: sent twice, one wait of up to the base delay', async () => {
  const { impl, sent } = script([{ status: 503 }, { status: 200 }]);
  const c = clock();
  const response = await retryingFetch(impl, { ...c, baseDelayMs: 100 })(URL_);
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(2);
  expect(c.waits).toEqual([100]);
});

test('waits grow exponentially, capped, with jitter drawing below the ceiling', async () => {
  const { impl } = script([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 200 }]);
  const c = clock();
  await retryingFetch(impl, { ...c, attempts: 4, baseDelayMs: 100, maxDelayMs: 300, random: () => 0.5 })(URL_);
  expect(c.waits).toEqual([50, 100, 150]);
});

test('429 with Retry-After in seconds is waited as asked', async () => {
  const { impl } = script([{ status: 429, retryAfter: '3' }, { status: 200 }]);
  const c = clock();
  await retryingFetch(impl, { ...c })(URL_);
  expect(c.waits).toEqual([3000]);
});

test('503 with Retry-After as an HTTP date is waited until then', async () => {
  const { impl } = script([{ status: 503, retryAfter: 'Tue, 27 Oct 2026 12:00:04 GMT' }, { status: 200 }]);
  const c = clock();
  await retryingFetch(impl, { ...c })(URL_);
  expect(c.waits).toEqual([4000]);
});

test('Retry-After on a 500 is not honoured: it is not a rate limit', async () => {
  const { impl } = script([{ status: 500, retryAfter: '9' }, { status: 200 }]);
  const c = clock();
  await retryingFetch(impl, { ...c, baseDelayMs: 100 })(URL_);
  expect(c.waits).toEqual([100]);
});

test('a Retry-After beyond the waiting budget stops at once, saying so', async () => {
  const { impl, sent } = script([{ status: 429, retryAfter: '60' }]);
  const c = clock();
  const error = await retryingFetch(impl, { ...c, budgetMs: 10_000 })(URL_).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RetriesExhaustedError);
  expect((error as Error).message).toMatch(/HTTP 429 .*asked to wait 60s.*budget of 10s/);
  expect(sent).toHaveLength(1);
  expect(c.waits).toEqual([]);
});

test('exhaustion after the attempts names the status, the attempts, the wait and the body', async () => {
  const { impl, sent } = script([{ status: 502, body: 'bad gateway' }, { status: 502 }, { status: 502 }, { status: 502, body: 'still bad' }]);
  const c = clock();
  const error = await retryingFetch(impl, { ...c, attempts: 4, baseDelayMs: 100 })(URL_).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RetriesExhaustedError);
  expect((error as RetriesExhaustedError).status).toBe(502);
  expect((error as RetriesExhaustedError).attempts).toBe(4);
  expect((error as Error).message).toBe('HTTP 502 after 4 attempts (waited 0.7s): still bad');
  expect(sent).toHaveLength(4);
});

test('a network error is retried, and exhausts naming its code', async () => {
  const { impl, sent } = script([{ error: connectionRefused }, { error: connectionRefused }, { error: connectionRefused }]);
  const c = clock();
  const error = await retryingFetch(impl, { ...c, attempts: 3, baseDelayMs: 10 })(URL_).catch((e: unknown) => e);
  expect((error as Error).message).toBe('network error (fetch failed, ECONNREFUSED) after 3 attempts (waited 0.0s)');
  expect(sent).toHaveLength(3);
  expect(networkErrorCode(connectionRefused)).toBe('ECONNREFUSED');
});

test('a status that is not transient comes back to the caller untouched, unretried', async () => {
  for (const status of [400, 401, 403, 404, 422, 501]) {
    const { impl, sent } = script([{ status }]);
    const response = await retryingFetch(impl, { ...clock() })(URL_);
    expect(response.status).toBe(status);
    expect(sent).toHaveLength(1);
  }
});

test('the caller’s rule can refuse a retry: the failed response returns as it is', async () => {
  const { impl, sent } = script([{ status: 500 }]);
  const response = await retryingFetch(impl, { ...clock(), mayRetry: () => false })(URL_);
  expect(response.status).toBe(500);
  expect(sent).toHaveLength(1);
});

test('the caller’s rule sees the failure and the request it failed', async () => {
  const seen: unknown[] = [];
  const { impl } = script([{ status: 429, retryAfter: '2' }, { status: 200 }]);
  await retryingFetch(impl, {
    ...clock(),
    mayRetry: (failure, init) => (seen.push(failure, init?.method), true),
  })(URL_, { method: 'POST' });
  expect(seen).toEqual([{ kind: 'status', status: 429, retryAfterMs: 2000 }, 'POST']);
});

test('each retry is reported before its wait', async () => {
  const { impl } = script([{ status: 503, retryAfter: '2' }, { status: 200 }]);
  const retries: unknown[] = [];
  await retryingFetch(impl, { ...clock(), onRetry: (r) => retries.push(r) })(URL_);
  expect(retries).toEqual([{ attempt: 1, of: 4, waitMs: 2000, because: 'HTTP 503' }]);
});

test('an aborted request is not retried', async () => {
  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const { impl, sent } = script([{ error: aborted }]);
  await expect(retryingFetch(impl, { ...clock() })(URL_)).rejects.toBe(aborted);
  expect(sent).toHaveLength(1);
});
