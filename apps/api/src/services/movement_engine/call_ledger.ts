// A ceiling on how many network calls one run may make to a third-party
// system.
//
// The failure this catches is a read that was supposed to be narrowed and
// wasn't: a filter that didn't push down turns "the three organizations this
// person works at" into a walk of the whole workspace, one page at a time,
// forever. Nothing else notices — the run is not stuck, it is working, and it
// is burning someone's API quota to do it. The ceiling stops it and says so.
//
// The count belongs to the RUN, not to the client: the API clients are
// process-wide singletons shared by every run in the process, so the run
// identity has to arrive ambiently. A dedicated AsyncLocalStorage is that
// seam — deliberately not the request `Context`, which is the request/DB
// scope and is not owned by a listener firing the way a run owns its own
// segment.
//
// One segment, one count. A run that parks on an `ask` and resumes hours later
// starts fresh: a spiral happens inside a single segment, and carrying a count
// across processes would cost machinery that buys nothing.

import { AsyncLocalStorage } from 'node:async_hooks';

/** The systems that count against a ceiling. One entry per system that has its
 *  own env var below; a system not listed here is simply not capped. */
export type AdapterCallSystem = 'affinity';

const CEILING_ENV_VAR: Record<AdapterCallSystem, string> = {
  affinity: 'AFFINITY_MAX_CALLS_PER_RUN',
};

const DEFAULT_CEILING: Record<AdapterCallSystem, number> = {
  affinity: 2000,
};

const SYSTEM_LABEL: Record<AdapterCallSystem, string> = {
  affinity: 'Affinity',
};

/** Read per call so ops (and tests) can move the ceiling without a restart.
 *  A missing, zero, or unparseable value means the default — the safeguard is
 *  always on, there is no "unlimited". */
function ceilingFor(system: AdapterCallSystem): number {
  const fromEnv = Number(process.env[CEILING_ENV_VAR[system]]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_CEILING[system];
}

/** Thrown at the call that would have gone one over. Its message is the whole
 *  failure surface an author sees (it lands verbatim in the run's failure
 *  reason), so it says the number, the knob, and why the run stopped. */
export class AdapterCallCeilingExceeded extends Error {
  constructor(
    readonly system: AdapterCallSystem,
    readonly calls: number,
  ) {
    super(
      `${SYSTEM_LABEL[system]} call ceiling reached: this run made ${calls} ${SYSTEM_LABEL[system]} API calls, ` +
        `the limit set by ${CEILING_ENV_VAR[system]}. The run was stopped in case something was looping.`,
    );
    this.name = 'AdapterCallCeilingExceeded';
  }
}

export function isAdapterCallCeilingExceeded(err: unknown): err is AdapterCallCeilingExceeded {
  return err instanceof AdapterCallCeilingExceeded;
}

class RunCallLedger {
  private readonly counts = new Map<AdapterCallSystem, number>();

  count(system: AdapterCallSystem): void {
    const ceiling = ceilingFor(system);
    const next = (this.counts.get(system) ?? 0) + 1;
    if (next > ceiling) throw new AdapterCallCeilingExceeded(system, ceiling);
    this.counts.set(system, next);
  }

  calls(system: AdapterCallSystem): number {
    return this.counts.get(system) ?? 0;
  }
}

const asyncLocalStorage = new AsyncLocalStorage<RunCallLedger>();

/** Run one interpreter segment under its own fresh count. */
export function withRunCallLedger<T>(fn: () => Promise<T>): Promise<T> {
  return asyncLocalStorage.run(new RunCallLedger(), fn);
}

/**
 * Record one outbound HTTP attempt, throwing once the run is over its ceiling.
 *
 * Outside a run — CLI scripts, catalog describe, the MCP connection describer,
 * tests — there is no ledger and this does nothing.
 */
export function countAdapterCall(system: AdapterCallSystem): void {
  asyncLocalStorage.getStore()?.count(system);
}

/**
 * Bind the CURRENT run's counter for a call that will execute later, in
 * someone else's async context.
 *
 * The API clients queue their requests behind a shared concurrency limiter, so
 * a queued job is dequeued by whichever other job happened to finish — in that
 * job's async context, not its own. Reading the ledger at that point would
 * charge the wrong run (or none). Capturing it where the call was ISSUED keeps
 * the count with the run that asked for it.
 */
export function bindAdapterCallCounter(system: AdapterCallSystem): () => void {
  const ledger = asyncLocalStorage.getStore();
  if (ledger === undefined) return () => {};
  return () => ledger.count(system);
}

/** The calls charged to the current run so far — diagnostics and tests. */
export function currentRunCallCount(system: AdapterCallSystem): number {
  return asyncLocalStorage.getStore()?.calls(system) ?? 0;
}
