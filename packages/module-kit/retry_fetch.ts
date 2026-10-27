// A fetch that sends a request again after a transient failure. Transient is
// a 429, a 5xx (not 501) or a network error; every other status returns to the
// caller as it is. The wait before a retry is exponential with full jitter,
// or, on a 429 or 503, as long as the server's Retry-After asked (seconds or
// an HTTP date, `vendorWaitMs`). Attempts and total waiting are both capped so
// a run is never stalled past the call that holds it; past either, the error
// says which status, how many attempts and how long was waited.
//
// An error carrying `POLICY_REFUSAL_CODE` is a refusal, not a network error,
// and is thrown at once.
//
// Wrap `ctx.fetch`, not the global one: each retry then asks the host's limits
// door again (a module that declares `hostLimits`), and a 429 or 503 the
// server answered with a Retry-After has already been reported there as a
// throttle by the time this waits.

import { vendorWaitMs } from 'module-runtime/vendor_wait';

export type AttemptFailure = { kind: 'status'; status: number; retryAfterMs?: number } | { kind: 'network'; error: unknown };

/** What `onRetry` is told before each wait. */
export interface RetryNote {
  attempt: number;
  of: number;
  waitMs: number;
  because: string;
}

export interface RetryFetchOptions {
  /** Tries in all, the first included. Default: 4. */
  attempts?: number;
  /** The ceiling of the first wait; each next one doubles. Default: 500. */
  baseDelayMs?: number;
  /** The ceiling of any one wait the server did not ask for. Default: 8000. */
  maxDelayMs?: number;
  /** The most all waiting may add up to; a Retry-After past what is left
   *  fails at once rather than waiting. Default: 20000. */
  budgetMs?: number;
  /** Whether a failed attempt may be sent again, asked only of a transient
   *  failure. Default: always. A refusal returns the failed response (or
   *  rethrows the network error) as it is. */
  mayRetry?: (failure: AttemptFailure, init: RequestInit | undefined) => boolean;
  /** Told before each wait. */
  onRetry?: (retry: RetryNote) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** The retries were spent, or the server asked for more waiting than allowed. */
export class RetriesExhaustedError extends Error {
  constructor(
    message: string,
    readonly details: { status?: number; attempts: number; waitedMs: number; cause?: unknown },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'RetriesExhaustedError';
  }
  get status(): number | undefined {
    return this.details.status;
  }
  get attempts(): number {
    return this.details.attempts;
  }
}

/** The system error code under a failed fetch (`ECONNREFUSED`), if it has one. */
export function networkErrorCode(error: unknown): string | undefined {
  // Duck-typed: an error from the runtime's own fetch is not `instanceof Error`
  // in a test sandbox's realm.
  for (let e: unknown = error, depth = 0; typeof e === 'object' && e !== null && depth < 4; e = Reflect.get(e, 'cause'), depth++) {
    const code: unknown = Reflect.get(e, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** The `code` a host sets on the error its fetch throws when it refuses a
 *  request by policy (a non-public address, a disallowed scheme). A refusal is
 *  deterministic, so it is never retried and its own message reaches the caller. */
export const POLICY_REFUSAL_CODE = 'LF_POLICY_REFUSAL';

/** Whether `error`, or a cause under it, is a host's refusal by policy. */
export function isPolicyRefusal(error: unknown): boolean {
  return networkErrorCode(error) === POLICY_REFUSAL_CODE;
}

function transient(status: number): boolean {
  return status === 429 || (status >= 500 && status !== 501);
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function retryingFetch(fetchImpl: typeof fetch, options: RetryFetchOptions = {}): typeof fetch {
  const attempts = options.attempts ?? 4;
  const base = options.baseDelayMs ?? 500;
  const cap = options.maxDelayMs ?? 8000;
  const budget = options.budgetMs ?? 20_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  return async (input, init) => {
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      let failure: AttemptFailure;
      let response: Response | undefined;
      let thrown: unknown;
      try {
        response = await fetchImpl(input, init);
        if (!transient(response.status)) return response;
        const asked = response.status === 429 || response.status === 503 ? vendorWaitMs(response, now()) : undefined;
        failure = { kind: 'status', status: response.status, ...(asked === undefined ? {} : { retryAfterMs: asked }) };
      } catch (error) {
        if (typeof error === 'object' && error !== null && Reflect.get(error, 'name') === 'AbortError') throw error;
        if (isPolicyRefusal(error)) throw error;
        thrown = error;
        failure = { kind: 'network', error };
      }
      if (options.mayRetry?.(failure, init) === false) {
        if (response !== undefined) return response;
        throw thrown;
      }

      const because = failure.kind === 'status' ? `HTTP ${failure.status}` : `network error (${describeNetwork(failure.error)})`;
      const exhausted = async (why: string): Promise<never> => {
        const body = response === undefined ? '' : (await response.text().catch(() => '')).slice(0, 300);
        throw new RetriesExhaustedError(`${because} ${why}${body === '' ? '' : `: ${body}`}`, {
          ...(failure.kind === 'status' ? { status: failure.status } : { cause: failure.error }),
          attempts: attempt,
          waitedMs: waited,
        });
      };
      if (attempt >= attempts) return exhausted(`after ${attempt} attempts (waited ${seconds(waited)})`);

      const asked = failure.kind === 'status' ? failure.retryAfterMs : undefined;
      const wait = asked ?? Math.round(random() * Math.min(cap, base * 2 ** (attempt - 1)));
      if (waited + wait > budget) {
        return exhausted(asked === undefined ? `after ${attempt} attempts (waited ${seconds(waited)})` : `(the server asked to wait ${asked / 1000}s, over the retry budget of ${budget / 1000}s)`);
      }
      await response?.body?.cancel().catch(() => undefined);
      options.onRetry?.({ attempt, of: attempts, waitMs: wait, because });
      waited += wait;
      await sleep(wait);
    }
  };
}

function describeNetwork(error: unknown): string {
  const message = typeof error === 'object' && error !== null && typeof Reflect.get(error, 'message') === 'string' ? String(Reflect.get(error, 'message')) : String(error);
  const code = networkErrorCode(error);
  return code === undefined ? message : `${message}, ${code}`;
}
