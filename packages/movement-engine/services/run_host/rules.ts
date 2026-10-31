// The run host's rules, written once over the backend families (store.ts):
// what a park writes and in which order, when a run counts as complete, how a
// run that failed or was cancelled is torn down, and how a race's losing
// subtrees are withdrawn. The hosted product and `listen-fire` both run these; neither
// keeps a copy.

import { createHash, randomUUID } from 'node:crypto';
import type { Arrival, AwaitWakeRequest, HostWaits, LoggedArrival } from 'engine-contracts';
import { isAncestorOrSelf, parseAddress } from '../movement_engine/address';
import type { ParkSink, RunLimitPause } from '../movement_engine/run_types';
import type { ParkSources } from '../movement_engine/host';
import { RESUME_TIMER_WORK_KIND, WAKE_AWAIT_WORK_KIND, type ListedArrival, type NewArrival, type RunHostStore, type SourceStore, type WaitWake } from './store';

/** What the product keeps about a run beyond its live state: its status, and
 *  the records only it knows of (the ops feed). */
export interface RunRecords {
  /** The operator's cancel request on the run, with its reason; null when none. */
  cancelRequest(input: { runId: string }): Promise<{ reason: string | null } | null>;
  /** The run is over without completing: mark it failed with `message`. A run
   *  already settled stays as it is. */
  markFailed(input: { runId: string; message: string }): Promise<void>;
}

/** A run host: its backend and the product's run records. */
export interface RunHost {
  store: RunHostStore;
  runs: RunRecords;
  log?: RunHostLog;
}

export interface RunHostLog {
  warn(message: string, fields: Record<string, unknown>): void;
  error(message: string, fields: Record<string, unknown>): void;
}

export const CANCELLED_BY_OPERATOR = 'Cancelled by an operator';

// ── The library texts a park pins ───────────────────────────────────────────

/** The `park.sources` family over a backend's source store: a text is named
 *  by the sha-256 of its UTF-8 bytes, so the same library text parked by any
 *  number of runs is one row. */
export function parkSources(sources: SourceStore, teamId: string): ParkSources {
  return {
    save: async ({ source }) => {
      const hash = `sha256:${createHash('sha256').update(source, 'utf8').digest('hex')}`;
      await sources.put({ teamId, hash, source });
      return { hash };
    },
    load: async ({ hash }) => {
      const source = await sources.get({ teamId, hash });
      return source === null ? null : { source };
    },
  };
}

// ── Work the run host queues ────────────────────────────────────────────────

/** One row per run, shared by every timer leaf the run parks: due at its
 *  earliest. */
export function timerWorkKey(runId: string): string {
  return `${RESUME_TIMER_WORK_KIND}:${runId}`;
}

export async function armTimerWake(store: RunHostStore, input: { runId: string; teamId: string; wakeAt: string }): Promise<void> {
  await store.work.enqueue({
    kind: RESUME_TIMER_WORK_KIND,
    key: timerWorkKey(input.runId),
    teamId: input.teamId,
    payload: { runId: input.runId },
    dueAt: input.wakeAt,
  });
}

/** Queue the wake of one wait parked at `address`: its run re-enters the
 *  await there, which reads the wait's arrivals. Never coalesced: a second
 *  arrival while the first wake runs must still drive the park again. */
export async function queueWaitWake(store: RunHostStore, wake: WaitWake & { teamId: string }): Promise<void> {
  const { teamId, ...payload } = wake;
  await store.work.enqueue({ kind: WAKE_AWAIT_WORK_KIND, key: `${WAKE_AWAIT_WORK_KIND}:${randomUUID()}`, teamId, payload });
}

/** A wake row's payload, or null for a row that is not one. */
export function waitWakeOf(payload: unknown): WaitWake | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const [runId, waitId, address]: unknown[] = ['runId', 'waitId', 'address'].map((key) => Reflect.get(payload, key));
  return typeof runId === 'string' && typeof waitId === 'string' && typeof address === 'string' ? { runId, waitId, address } : null;
}

/** What a module reported, as the log keeps it. */
export function newArrivalsOf(arrivals: readonly Arrival[]): NewArrival[] {
  return arrivals.map((arrival) =>
    'gone' in arrival
      ? { edge: arrival.edge, key: arrival.key, identity: null, version: null, landing: null, gone: true }
      : { edge: arrival.edge, key: arrival.key, identity: arrival.identity, version: arrival.version ?? null, landing: arrival.landing, gone: false },
  );
}

/**
 * Log what arrived on an adapter's listenable edges for a team, and queue a
 * wake for each wait parked on their records: one write (`waits.log`), so a
 * crash leaves both or neither, and a sender's retry of arrivals that were
 * not kept logs them again. Answers the wakes queued.
 */
export async function logArrivals(
  store: RunHostStore,
  input: { teamId: string; adapterType: string; arrivals: readonly Arrival[]; at?: string },
): Promise<WaitWake[]> {
  const at = input.at ?? new Date().toISOString();
  return store.waits.log({ teamId: input.teamId, adapterType: input.adapterType, arrivals: newArrivalsOf(input.arrivals), at });
}

/** How long an arrival no live wait reads is kept: a repeat within it is a
 *  sender's retry. */
export const ARRIVAL_RETENTION_MS = 3_600_000;

/** How many arrivals one sweep forgets at most (listen-fire's drain takes as many). */
export const ARRIVALS_PER_SWEEP = 100;

/**
 * Forget the arrivals logged more than `ARRIVAL_RETENTION_MS` before `now`
 * that no wait reads, at most `ARRIVALS_PER_SWEEP`; answers how many went. A
 * product sweeps on its own schedule, as listen-fire's drain does on each
 * pass (an embedded host's `tick` does): unswept, the log only grows.
 */
export async function sweepArrivals(store: RunHostStore, input: { now: Date }): Promise<number> {
  const before = new Date(input.now.getTime() - ARRIVAL_RETENTION_MS).toISOString();
  return store.waits.sweep({ before, limit: ARRIVALS_PER_SWEEP });
}

// ── Completion ──────────────────────────────────────────────────────────────

/**
 * A branch just completed: is the run complete? Only when no join still waits
 * on a branch, no OTHER leaf is parked (a sibling not yet due, a sibling
 * under another join), and the run owes no OTHER race. `leafAddress` is what
 * the step completes: the leaf it resumed, whose own row goes after its step,
 * or the race it settles, whose row goes with it.
 */
export async function runCompleteWithout(store: RunHostStore, input: { runId: string; leafAddress: string }): Promise<boolean> {
  if (await store.joins.hasPendingJoins({ runId: input.runId })) return false;
  const parked = await store.parks.leaves({ runId: input.runId, parkedOnly: true });
  if (!parked.every((leaf) => leaf.address === input.leafAddress)) return false;
  const owed = await store.parks.owedRaces({ runId: input.runId });
  return owed.every((race) => race.frameAddress === input.leafAddress);
}

/** Whether nothing waits on the run: no join pending, no leaf parked, no race
 *  owed. */
export async function runQuiescent(store: RunHostStore, input: { runId: string }): Promise<boolean> {
  if (await store.joins.hasPendingJoins(input)) return false;
  if ((await store.parks.leaves({ runId: input.runId, parkedOnly: true })).length > 0) return false;
  return (await store.parks.owedRaces(input)).length === 0;
}

/** A quiescent run's residual live state (closed joins and their exports)
 *  goes; under `fence`, only while the run is still that holder's. True when
 *  the run was quiescent. */
export async function clearIfQuiescent(store: RunHostStore, input: { runId: string; fence?: string }): Promise<boolean> {
  if (!(await runQuiescent(store, input))) return false;
  await store.leases.dropRunState(input);
  return true;
}

// ── A run that ends without completing ──────────────────────────────────────

/**
 * Tear a run's live state down: every leaf, join and wait (a late arrival
 * lands in the log and wakes nothing). Under `fence`, only while the run is
 * still that holder's: a holder whose lease lapsed tears down nothing of the
 * new holder's. False when fenced out.
 */
export async function abandonRun(host: RunHost, input: { runId: string; fence?: string }): Promise<boolean> {
  return host.store.leases.dropRunState(input);
}

/** An error in any branch fails the whole run; the writes it made stand. */
export async function failRun(host: RunHost, input: { runId: string; message: string; fence?: string }): Promise<boolean> {
  await host.runs.markFailed({ runId: input.runId, message: input.message });
  return abandonRun(host, input);
}

/** A run an operator asked to cancel is settled as failed with the reason they
 *  gave, its live state torn down. False when no cancel was asked for. */
export async function settleIfCancelRequested(host: RunHost, input: { runId: string; fence?: string }): Promise<boolean> {
  const request = await host.runs.cancelRequest({ runId: input.runId });
  if (request === null) return false;
  await failRun(host, { ...input, message: request.reason ?? CANCELLED_BY_OPERATOR });
  return true;
}

// ── A race's losers ─────────────────────────────────────────────────────────

/**
 * Withdraw every park at or below one of the subtree addresses (a race's losing
 * arms), sparing `excludeLeaf` (the winner, whose own row may still be
 * mid-resume). The prefix algebra runs on the parsed address: `s1.b1` is not
 * an ancestor of `s1.b10`. A withdrawn await's wait answers no later log (its
 * leaf is gone), and every join frame inside the subtrees goes with its
 * exports. Idempotent.
 */
export async function cancelSubtrees(
  host: RunHost,
  input: { runId: string; subtreeAddresses: readonly string[]; excludeLeaf?: string },
): Promise<void> {
  if (input.subtreeAddresses.length === 0) return;
  const prefixes = input.subtreeAddresses.map(parseAddress);
  const inSubtree = (address: string): boolean =>
    address !== input.excludeLeaf && prefixes.some((p) => isAncestorOrSelf(p, parseAddress(address)));
  const { runId } = input;
  const doomed = (await host.store.parks.leaves({ runId, parkedOnly: true })).map((l) => l.address).filter(inSubtree);
  if (doomed.length > 0) await host.store.parks.deleteLeaves({ runId, addresses: doomed });
  const deadFrames = (await host.store.joins.frames({ runId })).filter(inSubtree);
  if (deadFrames.length > 0) await host.store.joins.deleteFrames({ runId, frameAddresses: deadFrames });
}

// ── The park sink ───────────────────────────────────────────────────────────

/** What the product does around a park: the run's own row and status. */
export interface ParkRecords {
  /** The run's record exists before anything is parked against it. */
  ensureRun(): Promise<void>;
  /** The run is observably parked. */
  markParked(): Promise<void>;
  /** The run met a limit and is pausing (status, and the system event). */
  markLimitPaused?(pause: RunLimitPause): Promise<void>;
}

/** What the engine's `park` group needs of the run host for one segment:
 *  where its parks go, its waits, and the wake it asks for an arrival that
 *  landed while an await parked. */
export interface RunParkHost {
  sink: ParkSink;
  waits: HostWaits;
  wake(request: AwaitWakeRequest): Promise<void>;
}

/** A landing as the log kept it, in the shape the engine reads: none, or
 *  what a module reports, `{ recordId?, recordType?, fields }`. Anything else
 *  is refused, naming the arrival: read as none, the await would bind a
 *  landing that is not what arrived. */
function loggedLanding(arrival: ListedArrival): LoggedArrival['landing'] {
  const { landing } = arrival;
  if (landing === null || landing === undefined) return null;
  const refused = (why: string): Error => new Error(`the arrival logged at seq ${arrival.seq} (identity ${arrival.identity}) has a landing ${why}: ${JSON.stringify(landing)}`);
  if (typeof landing !== 'object' || Array.isArray(landing)) throw refused('that is not an object');
  const fields: unknown = Reflect.get(landing, 'fields');
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) throw refused('without an object of fields');
  const recordId: unknown = Reflect.get(landing, 'recordId');
  const recordType: unknown = Reflect.get(landing, 'recordType');
  if (recordId !== undefined && typeof recordId !== 'string') throw refused('whose recordId is not a text');
  if (recordType !== undefined && typeof recordType !== 'string') throw refused('whose recordType is not a text');
  return {
    fields: Object.fromEntries(Object.entries(fields)),
    ...(recordId !== undefined ? { recordId } : {}),
    ...(recordType !== undefined ? { recordType } : {}),
  };
}

function loggedArrival(arrival: ListedArrival): LoggedArrival {
  return { seq: arrival.seq, identity: arrival.identity, version: arrival.version, landing: loggedLanding(arrival) };
}

/**
 * The engine's park group for one run segment. Given the run lease the
 * segment holds (`fence`), every leaf, join and note it writes lands only
 * while the run's lease is still that token's; a holder whose lease lapsed is
 * refused (`RunLeaseLost`) rather than overwriting the parks of whoever took
 * the run. `resumed` is the leaf the segment resumed: a note its awaits make
 * is kept with the segment's progress past that leaf, and read again if the
 * segment dies first.
 *
 * Each park is its own write, made as the engine parks (host-families.md
 * allows a host to hold them to the segment's end; this one does not): a
 * segment that dies after parking one arm of a `parallel` leaves that arm
 * parked and the leaf it resumed resuming, which the next lease returns to
 * parked. After each park, a cancel an operator stamped meanwhile settles the
 * run at once: the park just written is stale.
 */
export function runParkHost(
  host: RunHost,
  input: { runId: string; teamId: string; fence?: string; resumed?: string; records: ParkRecords },
): RunParkHost {
  const { store } = host;
  const { runId, teamId, records } = input;
  const fence = input.fence !== undefined ? { fence: input.fence } : {};
  /** Where this segment parked each wait, for the wake it may ask. */
  const parkedWaits = new Map<string, string>();
  const afterPark = async (): Promise<void> => {
    await records.markParked();
    try {
      await settleIfCancelRequested(host, { runId });
    } catch (error) {
      // Never break the park path: the stamped-run sweep settles it later.
      host.log?.error('[ParkSink] cancel-race settle failed', { runId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  const sink: ParkSink = {
    async commitTimerPark({ address, state, wakeAt }) {
      await records.ensureRun();
      // The leaf and its run's timer row, in one write.
      await store.parks.commit({ runId, teamId, address, state, park: { kind: 'timer', wakeAt }, ...fence });
      await afterPark();
    },
    async commitAwaitPark({ address, state, waitId }) {
      // The leaf and its wait parked there, in one write: a log on the wait's
      // record either sees the park and answers it, or lands before it and is
      // read by the engine's second reading after this returns.
      await records.ensureRun();
      await store.parks.commit({ runId, teamId, address, state, park: { kind: 'wait', waitId }, ...fence });
      parkedWaits.set(waitId, address);
      await afterPark();
    },
    ...(records.markLimitPaused !== undefined
      ? {
          commitLimitPause: async (pause: RunLimitPause) => {
            await records.ensureRun();
            await records.markLimitPaused?.(pause);
          },
        }
      : {}),
    async commitSuspension({ address, state }) {
      // An await that took the pause before re-checking is unparked from its
      // wait by this park at its address: resuming the run re-enters it, which
      // parks it on its wait again if it still waits. Left parked, every
      // arrival would wake it into the pause again.
      await records.ensureRun();
      await store.parks.commit({ runId, teamId, address, state, park: { kind: 'limit' }, rewritten: true, ...fence });
      await afterPark();
    },
    async recordJoin({ frameAddress, parkedChildren }) {
      await store.joins.recordJoin({ runId, frameAddress, pending: parkedChildren, ...fence });
    },
    decrementJoin: ({ frameAddress, branchAddress, leafAddress }) =>
      store.joins.decrementJoin({ runId, frameAddress, branchAddress, leafAddress }),
    persistBranchExport: ({ frameAddress, branchAddress, branchIndex, exports }) =>
      store.joins.persistBranchExport({ runId, frameAddress, branchAddress, branchIndex, exports }),
    collectBranchExports: ({ frameAddress }) => store.joins.collectBranchExports({ runId, frameAddress }),
    cancelSubtrees: ({ subtreeAddresses, excludeLeaf }) =>
      cancelSubtrees(host, { runId, subtreeAddresses, ...(excludeLeaf !== undefined ? { excludeLeaf } : {}) }),
  };
  const waits: HostWaits = {
    mark: async () => ({ mark: await store.waits.mark() }),
    open: ({ adapterType, edge, key, since }) => store.waits.open({ runId, teamId, adapterType, edge, key, since }),
    arrivals: async ({ waitId }) => {
      const { gone, arrivals } = await store.waits.arrivals({ waitId });
      return { gone, arrivals: arrivals.map(loggedArrival) };
    },
    note: async ({ waitId, identity, version, matched }) => ({
      counts: await store.waits.note({
        waitId,
        identity,
        version: version ?? null,
        matched,
        ...(input.resumed !== undefined ? { leaf: input.resumed } : {}),
        ...fence,
      }),
    }),
  };
  return {
    sink,
    waits,
    async wake({ waitId }) {
      const address = parkedWaits.get(waitId);
      if (address === undefined) throw new Error(`park.wake names the wait ${waitId}, which this segment parked nothing on`);
      await queueWaitWake(store, { runId, waitId, address, teamId });
    },
  };
}
