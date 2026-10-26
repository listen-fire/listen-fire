// What one run's adapter calls share inside the process that answers them:
// what they have already read from a third party (the memo), and how many
// calls they have made to it (the ceiling). The engine's host opens one per
// run segment around every adapter call it makes in process; the module kit
// opens one per caller's scope id around every call it serves. Both stand on
// this package, so a module reads the same scope whichever host loaded it.
//
// The scope is ambient on purpose: the API clients are process-wide
// singletons shared by every run in the process, far below the adapter
// method that reached them, so the run has to arrive the way the billing
// context does.
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
// One scope, one count. A run that parks on an `ask` and resumes hours later
// starts fresh: a spiral happens inside a single segment, and carrying a count
// across processes would cost machinery that buys nothing.

import { AsyncLocalStorage } from 'node:async_hooks';

/** The systems that count against a ceiling. One entry per system that has its
 *  own env var below; a system not listed here is simply not capped. */
export type AdapterCallSystem = 'affinity' | 'remote';

const CEILING_ENV_VAR: Record<AdapterCallSystem, string> = {
  affinity: 'AFFINITY_MAX_CALLS_PER_RUN',
  remote: 'REMOTE_ADAPTER_MAX_CALLS_PER_RUN',
};

// A remote adapter (an external speaking the adapter protocol) is a third
// party like any other: an unnarrowed walk through it spirals the same way.
const DEFAULT_CEILING: Record<AdapterCallSystem, number> = {
  affinity: 2000,
  remote: 2000,
};

const SYSTEM_LABEL: Record<AdapterCallSystem, string> = {
  affinity: 'Affinity',
  remote: 'Remote adapter',
};

/** Read per call so ops (and tests) can move the ceiling without a restart.
 *  A missing, zero, or unparseable value means the default — the safeguard is
 *  always on, there is no "unlimited". */
function ceilingFor(system: AdapterCallSystem): number {
  const fromEnv = Number(process.env[CEILING_ENV_VAR[system]]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_CEILING[system];
}

/**
 * An adapter call refused because its run made as many calls to a
 * third-party system as one run may — raised by the call that would have
 * gone one over. The engine's host answers the engine with it as a
 * `call_ceiling` error; an adapter that catches its own failures lets this
 * one through (`isAdapterCallCeilingExceeded`).
 */
export class AdapterCallCeilingExceeded extends Error {
  readonly kind = 'call_ceiling';
  constructor(
    /** The system that counts, e.g. `affinity`. */
    readonly system: string,
    readonly calls: number,
    message: string,
  ) {
    super(message);
    this.name = 'AdapterCallCeilingExceeded';
  }
}

export function isAdapterCallCeilingExceeded(err: unknown): err is AdapterCallCeilingExceeded {
  return err instanceof AdapterCallCeilingExceeded;
}

/** The call that would have gone one over. Its message is the whole failure
 *  surface an author sees, so it says the number, the knob, and why the run
 *  stopped. */
function ceilingExceeded(system: AdapterCallSystem, calls: number): AdapterCallCeilingExceeded {
  return new AdapterCallCeilingExceeded(
    system,
    calls,
    `${SYSTEM_LABEL[system]} call ceiling reached: this run made ${calls} ${SYSTEM_LABEL[system]} API calls, ` +
      `the limit set by ${CEILING_ENV_VAR[system]}. The run was stopped in case something was looping.`,
  );
}

class RunCallLedger {
  private readonly counts = new Map<AdapterCallSystem, number>();

  count(system: AdapterCallSystem): void {
    const ceiling = ceilingFor(system);
    const next = (this.counts.get(system) ?? 0) + 1;
    if (next > ceiling) throw ceilingExceeded(system, ceiling);
    this.counts.set(system, next);
  }

  calls(system: AdapterCallSystem): number {
    return this.counts.get(system) ?? 0;
  }
}

// ── The read memo ───────────────────────────────────────────────────────────

/**
 * What this run has already READ from a third party.
 *
 * Inside one run the same record is asked for over and over: the engine reads
 * it to decide whether anything changed, the adapter reads it again to write
 * it, and a second write to the same record reads it a third time. Nothing
 * happened in between except our own writes — so the answer is already in the
 * process, and asking again spends someone's API quota to be told what we
 * know.
 *
 * The lifetime is the run, deliberately. A memo that outlived the run would
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
    const pending: Promise<T> = load().catch((err) => {
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

// ── The scope ───────────────────────────────────────────────────────────────

/** One run's memo and call count, as its host holds it. */
export class RunScope {
  readonly ledger = new RunCallLedger();
  readonly memo = new RunReadMemo();
}

const asyncLocalStorage = new AsyncLocalStorage<RunScope>();

/** Run `fn` inside `scope`: every memoised read and counted call it makes,
 *  however deep, is the scope's. */
export function inRunScope<T>(scope: RunScope, fn: () => T): T {
  return asyncLocalStorage.run(scope, fn);
}

// ── What an adapter reads off its run ───────────────────────────────────────

/**
 * Serve `key` from what this run has already read, or read it and
 * remember.
 *
 * Outside a run — CLI scripts, catalog describe, the MCP connection
 * describer, tests — there is no memo and this is exactly `load()`.
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

/** Drop what this run's own write just made wrong. No-op outside one. */
export function forgetMemoisedReads(...keys: string[]): void {
  asyncLocalStorage.getStore()?.memo.forget(keys);
}

/** Drop a whole family of reads — used where a write invalidates an unknown
 *  number of them (a field-value row names its own id, not its owner). */
export function forgetMemoisedReadsUnder(prefix: string): void {
  asyncLocalStorage.getStore()?.memo.forgetUnder(prefix);
}

/**
 * Record one outbound HTTP attempt, throwing once the run is over its
 * ceiling.
 *
 * Outside a run — CLI scripts, catalog describe, the MCP connection
 * describer, tests — there is no ledger and this does nothing.
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
 * charge the wrong run (or none). Capturing it where the call was ISSUED
 * keeps the count with the run that asked for it.
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
