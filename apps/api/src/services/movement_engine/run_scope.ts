// What one run SEGMENT knows about its own third-party traffic: how many calls
// it has made (the ceiling below), and what it has already read (the memo at
// the bottom).
//
// Both are the same fact wearing two hats — the API clients are process-wide
// singletons shared by every run in the process, so a run's identity has to
// arrive ambiently. One AsyncLocalStorage carries both.
//
// ── The ceiling ─────────────────────────────────────────────────────────────
//
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

// ── The read memo ───────────────────────────────────────────────────────────

/**
 * What this segment has already READ from a third party.
 *
 * Inside one run the same record is asked for over and over: the engine reads
 * it to decide whether anything changed, the adapter reads it again to write
 * it, and a second write to the same record reads it a third time. Nothing
 * happened in between except our own writes — so the answer is already in the
 * process, and asking again spends someone's API quota to be told what we
 * know.
 *
 * The lifetime is the segment, deliberately. A memo that outlived the run would
 * have to reason about who else might be editing the workspace; a memo that
 * dies with it only has to reason about what the run ITSELF wrote — which it
 * can, exactly, because it did the writing. That is what `forget` is for: every
 * write evicts the reads it invalidated, so "stale" here means "stale by
 * someone else's hand, within one run", which is the same window a single
 * uncached read already has.
 *
 * The PROMISE is stored, so callers asking at the same moment share one flight.
 */
class RunReadMemo {
  private readonly reads = new Map<string, Promise<unknown>>();

  read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.reads.get(key);
    if (hit) return hit as Promise<T>;
    // A rejected read is not an answer. Remembering it would serve the failure
    // to every later caller and never retry.
    let pending: Promise<T>;
    pending = load().catch((err) => {
      if (this.reads.get(key) === pending) this.reads.delete(key);
      throw err;
    });
    this.reads.set(key, pending);
    return pending;
  }

  /** File a record we were HANDED rather than asked for — a create's or an
   *  update's own response is the record, and the next read of it should not
   *  be a request. */
  fill(key: string, value: unknown): void {
    this.reads.set(key, Promise.resolve(value));
  }

  forget(keys: readonly string[]): void {
    for (const key of keys) this.reads.delete(key);
  }

  forgetUnder(prefix: string): void {
    for (const key of [...this.reads.keys()]) {
      if (key.startsWith(prefix)) this.reads.delete(key);
    }
  }
}

interface RunScope {
  readonly ledger: RunCallLedger;
  readonly memo: RunReadMemo;
}

const asyncLocalStorage = new AsyncLocalStorage<RunScope>();

/** Run one interpreter segment under its own fresh count and its own memo. */
export function withRunCallLedger<T>(fn: () => Promise<T>): Promise<T> {
  return asyncLocalStorage.run({ ledger: new RunCallLedger(), memo: new RunReadMemo() }, fn);
}

/**
 * Serve `key` from what this run has already read, or read it and remember.
 *
 * Outside a run — CLI scripts, catalog describe, the MCP connection describer,
 * tests — there is no memo and this is exactly `load()`.
 *
 * The key must name the CREDENTIAL as well as the record: one run may speak to
 * two workspaces of the same system, and `person 41` is a different person in
 * each.
 */
export function memoisedRead<T>(key: string, load: () => Promise<T>): Promise<T> {
  const memo = asyncLocalStorage.getStore()?.memo;
  return memo ? memo.read(key, load) : load();
}

/** File a record the system just handed back (a create's or an update's own
 *  response), so the next read of it is free. No-op outside a run. */
export function fillMemoisedRead(key: string, value: unknown): void {
  asyncLocalStorage.getStore()?.memo.fill(key, value);
}

/** Drop what this run's own write just made wrong. No-op outside a run. */
export function forgetMemoisedReads(...keys: string[]): void {
  asyncLocalStorage.getStore()?.memo.forget(keys);
}

/** Drop a whole family of reads — used where a write invalidates an unknown
 *  number of them (a field-value row names its own id, not its owner). */
export function forgetMemoisedReadsUnder(prefix: string): void {
  asyncLocalStorage.getStore()?.memo.forgetUnder(prefix);
}

/**
 * Record one outbound HTTP attempt, throwing once the run is over its ceiling.
 *
 * Outside a run — CLI scripts, catalog describe, the MCP connection describer,
 * tests — there is no ledger and this does nothing.
 */
export function countAdapterCall(system: AdapterCallSystem): void {
  asyncLocalStorage.getStore()?.ledger.count(system);
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
  const ledger = asyncLocalStorage.getStore()?.ledger;
  if (ledger === undefined) return () => {};
  return () => ledger.count(system);
}

/** The calls charged to the current run so far — diagnostics and tests. */
export function currentRunCallCount(system: AdapterCallSystem): number {
  return asyncLocalStorage.getStore()?.ledger.calls(system) ?? 0;
}
