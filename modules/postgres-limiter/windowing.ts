// The limiter's decision, apart from the database that holds its state: given
// the calls in each rate limit's window and the instant, is a call granted,
// and if not, when to ask again. The same rolling window as the in-process
// built-in (MemoryLimiter), so the two limiters mean one thing by `calls`/`perMs`.

import { inWindow, windowCost, windowRetryAt, type LimitRequest, type WindowCall } from 'movement-engine/public/limiter';

/** How soon a call refused for concurrency asks again if nothing frees a
 *  place sooner (a release carries no wake-up across hosts). */
export const CONCURRENCY_RECHECK_MS = 1_000;

/** The permits live in a bucket: how many, and when the first lapses. */
export interface HeldState {
  count: number;
  soonestLapse: number;
}

export type Decision =
  | { granted: false; retryAt: number }
  | {
      granted: true;
      /** The calls to store, one per rate limit the call counts in. */
      counted: { bucket: string; call: WindowCall }[];
      /** The buckets the permit holds a place in. */
      holds: string[];
    };

export function decide(input: {
  request: LimitRequest;
  /** Each rate limit's calls, oldest first. */
  windows: ReadonlyMap<string, readonly WindowCall[]>;
  held: ReadonlyMap<string, HeldState>;
  now: number;
}): Decision {
  const { request, now } = input;
  let retryAt: number | undefined;
  const later = (at: number) => (retryAt = retryAt === undefined ? at : Math.max(retryAt, at));

  for (const limit of request.limits) {
    if (limit.calls !== undefined && limit.perMs !== undefined) {
      const window = inWindow(input.windows.get(limit.key) ?? [], limit.perMs, now);
      const room = windowRetryAt(window, { calls: limit.calls, perMs: limit.perMs }, request.cost);
      if (room !== undefined) later(room);
    }
    const held = input.held.get(limit.key);
    if (limit.concurrent !== undefined && held !== undefined && held.count >= limit.concurrent) {
      later(Math.min(held.soonestLapse, now + CONCURRENCY_RECHECK_MS));
    }
  }
  if (retryAt !== undefined) return { granted: false, retryAt };

  const counted: { bucket: string; call: WindowCall }[] = [];
  const holds: string[] = [];
  for (const limit of request.limits) {
    if (limit.calls !== undefined && limit.perMs !== undefined) counted.push({ bucket: limit.key, call: { at: now, cost: windowCost(request.cost, limit.calls) } });
    if (limit.concurrent !== undefined) holds.push(limit.key);
  }
  return { granted: true, counted, holds };
}
