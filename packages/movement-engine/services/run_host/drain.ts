// Stepping a parked run forward, written once for every backend: a wake names
// the wait an arrival answered and the address it is parked at, the run is
// stepped under its lease, and each of the leaves a drain chooses is claimed
// and stepped in one batch. A race branch that completes in the batch DEFERS its
// race: the step's end, one write, finishes its leaf and owes the race (a
// `settle_race` row). Once every leaf has stepped, each race the run owes
// settles once, with every winner on its receipt, and its settling step's end
// discharges it. A drain that dies between leaves the race owed, and its row
// drives the run's next drain. Then a run that nothing waits on any more has
// its residual state cleared.
//
// The product supplies only the step itself (`StepLeaf`): running one engine
// segment for one leaf, and recording what it did.

import type { ParkedScopeState } from 'engine-contracts';
import type { ParkReason } from 'engine-contracts';
import { RunLeaseLost } from '../movement_engine/errors';
import { withRunLease, type HeldRunLease, type LeaseOptions } from './lease';
import {
  abandonRun,
  clearIfQuiescent,
  failRun,
  CANCELLED_BY_OPERATOR,
  runCompleteWithout,
  settleIfCancelRequested,
  type RunHost,
} from './rules';
import type { OwedRace, WaitWake } from './store';

/** One segment the drain asks the product to run. */
export type StepRequest =
  /** Resume a claimed leaf: re-enter at its statement (an await, a suspension,
   *  an `await until`) or step past it (a slept timer). A completing race
   *  branch defers its race. */
  | { kind: 'leaf'; address: string; reason: ParkReason; state: ParkedScopeState; reenter: boolean; deferRaceSettlement: true }
  /** Settle a race the run owes, with all its winners. `state` is a
   *  completed branch's (its scope chain covers the race). */
  | { kind: 'race'; frameAddress: string; state: ParkedScopeState };

/** What one segment came to. */
export type StepOutcome =
  /** The segment stopped because the run lease was lost: the run may be
   *  another instance's, so the drain leaves every row as it is. */
  | { kind: 'leaseLost' }
  /** The engine failed the run: the product recorded it failed; the drain
   *  tears its live state down. */
  | { kind: 'failed'; error: string }
  /** An operator's cancel stopped the segment. */
  | { kind: 'cancelled'; reason?: string }
  /** It parked again: at the same address (an await re-armed without
   *  resolving), or further on. */
  | { kind: 'parked'; parkedAddress: string | undefined; deferredRaceFrames: readonly string[] }
  | { kind: 'completed'; deferredRaceFrames: readonly string[] };

/**
 * Run one segment. When it completes, the product asks `runComplete()`
 * whether the run as a whole is now complete (the core's rule: no join
 * waiting, no other leaf parked, no other race owed) and records the run
 * completed, or still parked, accordingly. A segment that left races to
 * settle (`deferredRaceFrames`) never completes its run: the drain owes them
 * in the step's end and settles them after.
 */
export type StepLeaf = (request: StepRequest, settle: { runComplete(): Promise<boolean> }) => Promise<StepOutcome>;

/** Which of a run's leaves a drain steps, and how a leaf is claimed. */
export interface DrainLeaves {
  addresses: readonly string[];
  /** Claim only leaves parked for this reason. */
  reason?: ParkReason;
}

/**
 * Step the chosen leaves of one run, under the lease the caller holds. A
 * cancel requested meanwhile settles the run instead of stepping it. Answers
 * `leaseLost` when the lease went mid-drain (every row is left as it is).
 *
 * `until` stops the batch early once it holds after a leaf (a limit resume
 * stops once a flow paused the run again: the leaves not yet reached stay
 * paused with it); the races already deferred still settle.
 */
export async function drainRun(
  host: RunHost,
  input: { runId: string; teamId: string; leaves: DrainLeaves; lease?: HeldRunLease; step: StepLeaf; until?: () => Promise<boolean> },
): Promise<'done' | 'leaseLost'> {
  const { store } = host;
  const { runId, teamId, lease, step } = input;
  const fence = lease !== undefined ? { fence: lease.token } : {};
  if (await settleIfCancelRequested(host, { runId, ...fence })) return 'done';

  for (const address of input.leaves.addresses) {
    if (lease?.isLost()) return 'leaseLost';
    // Claimed before it is stepped: a leaf another entry already took, or a
    // race this batch settled cancelled, is not parked any more.
    const claimed = await store.parks.claimLeaf({ runId, address, ...(input.leaves.reason !== undefined ? { reason: input.leaves.reason } : {}) });
    if (claimed === null) {
      // Not ours to judge once the lease is lost: the new holder may have
      // claimed it itself.
      if (lease?.isLost()) return 'leaseLost';
      // Already drained, or cancelled as a race loser.
      continue;
    }
    const state = parkedStateOf(claimed.state);
    const outcome = await step(
      {
        kind: 'leaf',
        address,
        reason: claimed.reason,
        state,
        // A slept timer steps past its sleep (re-entering would sleep again);
        // everything else re-enters to re-check live.
        reenter: claimed.reason !== 'timer' || state.until === true,
        deferRaceSettlement: true,
      },
      { runComplete: () => runCompleteWithout(store, { runId, leafAddress: address }) },
    );
    const settled = await afterStep(host, { runId, ...fence, outcome });
    if (settled !== 'continue') return settled;
    if (outcome.kind !== 'parked' && outcome.kind !== 'completed') continue;
    // The leaf's end: its claimed row goes (one the step parked again, an
    // await re-armed without resolving, stays), the notes its segment made
    // are kept, and each race its arm won is owed, in one write.
    const ended = await endStep(host, { runId, teamId, ...fence, resumed: address, owedRaces: owed(outcome.deferredRaceFrames, state) });
    if (!ended) return 'leaseLost';
    if (input.until !== undefined && (await input.until())) break;
  }

  // Read again before each: settling one race withdraws a race inside the
  // arms it lost, which is then owed no more. Each is stepped once here: a
  // step that failed to discharge it leaves it to the run's next drain.
  const stepped = new Set<string>();
  for (;;) {
    if (lease?.isLost()) return 'leaseLost';
    const race = (await store.parks.owedRaces({ runId })).find((owedRace) => !stepped.has(owedRace.frameAddress));
    if (race === undefined) break;
    stepped.add(race.frameAddress);
    const state = parkedStateOf(race.state);
    const outcome = await step(
      { kind: 'race', frameAddress: race.frameAddress, state },
      { runComplete: () => runCompleteWithout(store, { runId, leafAddress: race.frameAddress }) },
    );
    const settled = await afterStep(host, { runId, ...fence, outcome });
    if (settled !== 'continue') return settled;
    if (outcome.kind !== 'parked' && outcome.kind !== 'completed') continue;
    const ended = await endStep(host, { runId, teamId, ...fence, resumed: null, settledRace: race.frameAddress, owedRaces: owed(outcome.deferredRaceFrames, state) });
    if (!ended) return 'leaseLost';
  }

  await clearIfQuiescent(store, { runId, ...fence });
  return 'done';
}

/** Settle only the races the run owes: a `settle_race` row's drain, under the
 *  lease the caller holds. A race settled meanwhile is owed no more, and
 *  steps nothing. */
export async function drainOwedRaces(
  host: RunHost,
  input: { runId: string; teamId: string; lease?: HeldRunLease; step: StepLeaf },
): Promise<'done' | 'leaseLost'> {
  return drainRun(host, { ...input, leaves: { addresses: [] } });
}

function owed(frames: readonly string[], state: ParkedScopeState): OwedRace[] {
  return frames.map((frameAddress) => ({ frameAddress, state }));
}

/** A step's end, in one fenced write (`parks.commitSegment`): the leaf it
 *  resumed finished, the race it settled discharged, the races it owes
 *  queued. False when the lease was lost, and nothing was written. */
async function endStep(
  host: RunHost,
  input: { runId: string; teamId: string; fence?: string; resumed: string | null; owedRaces: OwedRace[]; settledRace?: string },
): Promise<boolean> {
  try {
    await host.store.parks.commitSegment({ ...input, joins: [], parks: [], settle: null, settledRace: input.settledRace ?? null });
    return true;
  } catch (error) {
    if (error instanceof RunLeaseLost) return false;
    throw error;
  }
}

/** What one segment's outcome does to the run: a failure or a cancel tears
 *  it down and ends the drain, a lost lease ends it leaving every row. Also
 *  for an entry that is not a drain (a run's first firing). */
export async function afterStep(
  host: RunHost,
  input: { runId: string; fence?: string; outcome: StepOutcome },
): Promise<'continue' | 'done' | 'leaseLost'> {
  const { runId, fence, outcome } = input;
  const fenced = fence !== undefined ? { fence } : {};
  switch (outcome.kind) {
    case 'leaseLost':
      return 'leaseLost';
    case 'failed':
      // An error in any branch fails the whole run; the product already
      // recorded the failure.
      await abandonRun(host, { runId, ...fenced });
      return 'done';
    case 'cancelled':
      await failRun(host, { runId, message: outcome.reason ?? CANCELLED_BY_OPERATOR, ...fenced });
      return 'done';
    case 'parked':
    case 'completed':
      return 'continue';
    default: {
      const unreachable: never = outcome;
      throw new Error(`unhandled step outcome ${JSON.stringify(unreachable)}`);
    }
  }
}

function parkedStateOf(state: unknown): ParkedScopeState {
  if (typeof state !== 'object' || state === null) throw new Error('a parked leaf has no state to resume from');
  // The backend stores what the engine handed it; the engine re-validates the
  // shape (and its version) when it resumes.
  return state as ParkedScopeState;
}

// ── Waits ───────────────────────────────────────────────────────────────────

/** How the drain reaches the product for one run: the step it runs each
 *  segment with, or null when the run cannot be resumed (logged by the
 *  product). */
export type StepperFor = (input: { runId: string; lease: HeldRunLease }) => Promise<StepLeaf | null>;

/**
 * A wake on one wait (a `wake_await` row): under the run's lease (and inside
 * `around`, the product's in-process slot, when it has one), re-enter the
 * await parked at the wake's address, which reads the wait's arrivals. A run
 * held elsewhere is `busy`, and its wake retries; a leaf no longer parked
 * there (drained by another wake, withdrawn by a race) steps nothing.
 */
export async function wakeWait(
  host: RunHost,
  input: {
    wake: WaitWake;
    /** The run's tenant: a race its step owes is queued under it. */
    teamId: string;
    stepper: StepperFor;
    around?: (runId: string, body: () => Promise<void>) => Promise<void>;
    lease?: LeaseOptions;
  },
): Promise<{ busy: boolean }> {
  const { runId, address } = input.wake;
  const around = input.around ?? ((_runId: string, body: () => Promise<void>) => body());
  let busy = false;
  await around(runId, async () => {
    const drained = await withRunLease(
      host.store.leases,
      runId,
      async (lease) => {
        const step = await input.stepper({ runId, lease });
        if (step === null) return 'done';
        return drainRun(host, { runId, teamId: input.teamId, leaves: { addresses: [address], reason: 'await' }, lease, step });
      },
      input.lease,
    );
    busy = drained.kind === 'busy';
  });
  return { busy };
}

// ── Timers ──────────────────────────────────────────────────────────────────

/** Step one run's timer leaves due by `dueBy`, under the lease the caller
 *  holds. A not-yet-due sibling still counts as parked. */
export async function drainDueTimers(
  host: RunHost,
  input: { runId: string; teamId: string; dueBy: string; lease?: HeldRunLease; step: StepLeaf },
): Promise<'done' | 'leaseLost'> {
  const due = await host.store.parks.leaves({ runId: input.runId, parkedOnly: true, reason: 'timer', dueBy: input.dueBy });
  return drainRun(host, {
    runId: input.runId,
    teamId: input.teamId,
    leaves: { addresses: due.map((l) => l.address), reason: 'timer' },
    ...(input.lease !== undefined ? { lease: input.lease } : {}),
    step: input.step,
  });
}

/** The earliest wake of the run's still-parked timers, for re-arming its row. */
export async function nextTimerWake(host: RunHost, input: { runId: string }): Promise<string | null> {
  const timers = await host.store.parks.leaves({ runId: input.runId, parkedOnly: true, reason: 'timer' });
  const wakes = timers.map((t) => t.wakeAt).filter((w): w is string => w !== null).sort();
  return wakes[0] ?? null;
}
