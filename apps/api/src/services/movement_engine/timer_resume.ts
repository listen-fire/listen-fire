// The timer-resume driver (movement `sleep`, plans/2026-07-01-movement-sleep §4)
// — the wake driver. A near-clone of the cost-resume worker
// (the retired cost-resume driver), which was itself the ask-resume sibling
// (`interaction/resume.ts`). All three share the serialize/rehydrate +
// `join_pending` substrate; they differ only in WHAT parks and HOW the leaf
// resumes.
//
// A `sleep` parks the branch AT the sleep statement via `commitTimerPark`
// (`park_reason='timer'`, an absolute `wake_at`, no `interaction_request`, no
// answer, `state.bindingName = null`). This worker scans every 30s for timer
// parks whose `wake_at` has passed and drives each due leaf forward.
//
// Resume mode (the one thing that differs from cost-resume): a slept leaf's
// statement is DONE — the sleep already happened — so resume must step PAST it,
// exactly like the ask worker (`reenter=false`, the default), NOT re-enter AT it
// (which cost-resume does). It binds NOTHING: `answer` is omitted and the parked
// `state.bindingName` is null, so the interpreter's step-past path
// (`resumeAlongAddress`, run.ts) declares nothing and continues from the
// statement AFTER the sleep. Using `reenter=true` would re-run the sleep and
// re-park forever — so we omit it.
//
// Single-instance (startup.ts runs every worker under the app advisory lock) and
// idempotent: a crash mid-drain leaves the timer-parked rows for the next scan to
// re-process; a completed leaf's `parked_run` is deleted, so it's skipped. A
// not-yet-due sibling leaf (fan-out sleep) stays parked and holds the join —
// verified separately (§9), not broken here.

import { SECOND } from '../../constants';
import { getQb, getAutomationsQb } from '../../lib/kysely';
import { worker } from '../../lib/worker';
import { logger } from '../logger';
import { settleCancelledRun } from '../interaction/run_failure';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import type { ParkedScopeState } from './serialize';
import { runHasPendingJoins, clearJoins } from './join_pending';
import { resumeMovementFiring } from '../translation_graph/movement/execute';
import { loadTriggerById } from '../translation_graph/storage/tg_table';
import { triggerEventSchema, type TriggerEvent } from '../translation_graph/triggers/types';
import type { TriggerRunTriggerType } from '../translation_graph/runs/trigger_run';

const SCAN_INTERVAL = 30 * SECOND;

interface TimerParkedRunRow {
  runId: TriggerRunId;
  teamId: TeamId;
}

/**
 * One scan: every run that holds at least one DUE timer-parked leaf
 * (`wake_at <= now`) is resumed once (its due leaves drained). Contained per-run.
 */
export async function resumeTimerParkedRuns(): Promise<void> {
  // Cancel-vs-park-resume race closure (runs-cancel task 3): settle any
  // timer-parked run that was stamped `cancel_requested_at` — by an operator's
  // abortRun, or by the park sink's own tail check having crashed before it
  // could settle — BEFORE loading the resumable set, which itself excludes
  // stamped runs. Best-effort per run; a settle failure must not block
  // draining the rest of the scan.
  await settleStampedTimerParkedRuns();
  const now = new Date();
  const runs = await loadResumableTimerParkedRuns(now);
  for (const run of runs) {
    try {
      await resumeTimerParkedRun(run, now);
    } catch (err) {
      logger.error('[TimerResume] run resume failed', {
        runId: run.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * The resumable set: a `trigger_run` with at least one `parked_run` whose
 * `park_reason='timer'`, `status='parked'`, and `wake_at <= now` (the wake
 * instant has passed). Distinct by run.
 */
async function loadResumableTimerParkedRuns(now: Date): Promise<TimerParkedRunRow[]> {
  const rows = await getAutomationsQb(['trigger_run', 'parked_run'])
    .selectFrom('trigger_run')
    .innerJoin('parked_run', 'parked_run.run_id', 'trigger_run.id')
    .where('parked_run.park_reason', '=', 'timer')
    .where('parked_run.status', '=', 'parked')
    .where('parked_run.wake_at', '<=', now)
    .where('trigger_run.cancel_requested_at', 'is', null)
    .select(['trigger_run.id as run_id', 'trigger_run.team_id as team_id'])
    .distinct()
    .execute();
  // `trigger_run.team_id` is an opaque tenant uuid (D3 dropped the FK, and
  // with it the brand); naming it as core's team id is the boundary conversion.
  return rows.map((r) => ({ runId: r.run_id, teamId: r.team_id as TeamId }));
}

/**
 * The stamped-but-still-parked set: every distinct run holding a live timer
 * park that also carries a `cancel_requested_at` stamp — runs
 * `loadResumableTimerParkedRuns` would otherwise have selected (once due), had
 * the stamp not excluded them. Settling here (rather than silently skipping)
 * is the race closure: without it a cancelled-but-still-parked run would sit
 * forever, since nothing else drains timer parks.
 */
async function settleStampedTimerParkedRuns(): Promise<void> {
  const rows = await getAutomationsQb(['trigger_run', 'parked_run'])
    .selectFrom('trigger_run')
    .innerJoin('parked_run', 'parked_run.run_id', 'trigger_run.id')
    .where('parked_run.park_reason', '=', 'timer')
    .where('parked_run.status', '=', 'parked')
    .where('trigger_run.cancel_requested_at', 'is not', null)
    .select('trigger_run.id as run_id')
    .distinct()
    .execute();
  for (const row of rows) {
    try {
      await settleCancelledRun(row.run_id);
    } catch (err) {
      logger.error('[TimerResume] settle-cancelled failed', {
        runId: row.run_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Resume one timer-parked run, draining every DUE timer leaf (a fan-out sleep
 * parks N leaves; each steps PAST its own sleep and runs that branch forward).
 * The pinned version + inbound event are loaded once. After a branch completes
 * (no re-park, no error) the leaf's enclosing join decrements; the run finalises
 * `success` only when the last branch closes (linear = no join = finalise on
 * complete). A not-yet-due sibling leaf is left parked (its `wake_at` window
 * bounds the query), holding the join until its own scan.
 */
async function resumeTimerParkedRun(run: TimerParkedRunRow, now: Date): Promise<void> {
  const { runId, teamId } = run;
  const triggerRun = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select(['trigger_id', 'trigger_type', 'trigger_payload', 'movement_version_id'])
    .executeTakeFirst();
  if (!triggerRun || !triggerRun.trigger_payload) {
    logger.error('[TimerResume] trigger_run missing or has no payload', { runId });
    return;
  }

  const trigger = await loadTriggerById(triggerRun.trigger_id);
  if (!trigger || !trigger.movementId) {
    logger.error('[TimerResume] trigger gone or not movement-derived', {
      runId,
      triggerId: triggerRun.trigger_id,
    });
    return;
  }

  const pinnedSource = triggerRun.movement_version_id
    ? await loadVersionSource(triggerRun.movement_version_id)
    : null;
  if (!pinnedSource) {
    logger.error('[TimerResume] no pinned movement_version source — cannot resume (P11)', {
      runId,
      movementVersionId: triggerRun.movement_version_id,
    });
    return;
  }

  const event = triggerEventSchema.parse(triggerRun.trigger_payload) as TriggerEvent;

  // Each DUE timer leaf, drained in turn (serialised under the single-instance
  // scanner — the atomic join decrement is the only shared state).
  const leaves = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('park_reason', '=', 'timer')
    .where('status', '=', 'parked')
    .where('wake_at', '<=', now)
    .select(['address', 'state'])
    .execute();

  for (const leaf of leaves) {
    if (!leaf.state) {
      await deleteLeaf(runId, leaf.address);
      continue;
    }
    const state = leaf.state as ParkedScopeState;
    // An `await until(…)` park (chunk D, F12) RE-ENTERS to re-evaluate its
    // condition rather than stepping past like a `sleep`. Unmet ⇒ it re-parks at
    // the SAME address with a fresh (future) `wake_at`; met ⇒ it binds + continues.
    const isUntil = state.until === true;

    const outcome = await resumeMovementFiring({
      teamId,
      triggerId: triggerRun.trigger_id,
      triggerName: trigger.name,
      ...(trigger.firedMovementName !== null
        ? { firedMovementName: trigger.firedMovementName }
        : {}),
      pinnedSource,
      movementVersionId: triggerRun.movement_version_id,
      runId,
      movementId: trigger.movementId,
      event,
      recordingTriggerType: triggerRun.trigger_type as TriggerRunTriggerType,
      state,
      // A `sleep` already happened — step PAST it (`reenter` omitted ⇒ false),
      // binding nothing. An `until` must RE-ENTER at the statement to re-check its
      // condition live (a plain sleep re-entering would re-park forever — the
      // reason the default is step-past).
      ...(isUntil ? { reenter: true } : {}),
      settleBranchComplete: () => settleBranchComplete(runId, leaf.address),
    });

    if (outcome.error) {
      // An engine ERROR in any branch fails the whole run (P14): drop the timer
      // rows + pending joins; prior writes (incl. this branch's, before the
      // error) stay committed. No ask requests to cancel (timer parks never
      // created any).
      await settleFailure(runId);
      return;
    }


    if (outcome.result?.parked) {
      if (isUntil && (await untilReArmed(runId, leaf.address, now))) {
        // The `until` condition was still unmet: it re-parked at this same
        // address with a FRESH future `wake_at`. Leave that row ALONE — it's the
        // next tick's park; deleting it would silently kill the recurring wait.
        continue;
      }
      // Re-parked deeper (a met `until`'s continuation hit a later await/sleep, a
      // slept branch parked again, or a cost gate). The new park rows were written
      // by the resumed interpreter; drop THIS leaf's superseded timer row. No join
      // decrement (the branch did not complete). The run stays parked.
      await deleteLeaf(runId, leaf.address);
      continue;
    }

    // The branch completed — `settleBranchComplete` already decremented the join.
    await deleteLeaf(runId, leaf.address);
  }

  // Fully settled (no pending join, no parked leaf left) ⇒ sweep residual live
  // state. The last completer's firing finalised `success`. A not-yet-due timer
  // leaf still counts as parked here, so the sweep correctly holds off.
  if (!(await runHasPendingJoins(runId))) {
    const remaining = await getAutomationsQb(['parked_run'])
      .selectFrom('parked_run')
      .where('run_id', '=', runId)
      .where('status', '=', 'parked')
      .select('id')
      .executeTakeFirst();
    if (remaining === undefined) {
      await getAutomationsQb(['parked_run']).deleteFrom('parked_run').where('run_id', '=', runId).execute();
      await clearJoins(runId);
    }
  }
}

/**
 * The branch-complete settle (§6.3): a pure run-wide quiescence query. The engine
 * already decremented this leaf's enclosing join during the resume unwind
 * (run.ts), so this only asks whether anything is still waiting — no join with
 * `pending > 0`, and no OTHER parked leaf (a not-yet-due timer sibling, or a
 * sibling under a different join). This branch's own row is deleted by the driver
 * AFTER the firing, so exclude it here.
 */
async function settleBranchComplete(
  runId: TriggerRunId,
  leafAddress: string,
): Promise<{ runComplete: boolean }> {
  if (await runHasPendingJoins(runId)) return { runComplete: false };
  const otherParked = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('address', '!=', leafAddress)
    .where('status', '=', 'parked')
    .select('id')
    .executeTakeFirst();
  return { runComplete: otherParked === undefined };
}

/** The pinned version's immutable source (P11). */
async function loadVersionSource(versionId: string): Promise<string | null> {
  const row = await getAutomationsQb(['movement_version'])
    .selectFrom('movement_version')
    .where('id', '=', versionId as never)
    .select('source')
    .executeTakeFirst();
  return row?.source ?? null;
}

/**
 * After re-entering an `await until(…)` leaf, did its condition stay UNMET so it
 * re-parked in place? The re-park upserts the same (run_id, address) row with a
 * FRESH `wake_at = now + every` (always in the future relative to this scan's
 * `now`, since the cadence floor is 1m). A future `wake_at` at the same address
 * therefore means "re-armed" — leave it; a past/unchanged one means the until
 * was met and moved on (delete it). Single-instance scanner, so no torn read.
 */
async function untilReArmed(
  runId: TriggerRunId,
  address: string,
  scanNow: Date,
): Promise<boolean> {
  const row = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('run_id', '=', runId)
    .where('address', '=', address)
    .where('status', '=', 'parked')
    .where('park_reason', '=', 'timer')
    .where('wake_at', '>', scanNow)
    .select('id')
    .executeTakeFirst();
  return row !== undefined;
}

async function deleteLeaf(runId: TriggerRunId, address: string): Promise<void> {
  await getAutomationsQb(['parked_run'])
    .deleteFrom('parked_run')
    .where('run_id', '=', runId)
    .where('address', '=', address)
    .execute();
}

async function settleFailure(runId: TriggerRunId): Promise<void> {
  // An ERROR in any branch fails the whole run (P14): drop the timer-parked rows +
  // pending joins (prior writes stand). No ask requests to cancel (timer parks
  // never created any).
  await getAutomationsQb(['parked_run']).deleteFrom('parked_run').where('run_id', '=', runId).execute();
  await clearJoins(runId);
}

export function startTimerResumeWorker(): void {
  worker(resumeTimerParkedRuns, SCAN_INTERVAL);
}
