// Operator actions for the control tower — run-level cancel / resume (§5.7 P9,
// runs-cancel tasks 3/6). An operator looking at what's parked or running can:
//
//   • abortRun          → failRunAndCancelRequests (trigger_run → failed, parked
//                         rows cleared, await correlations dropped). The §5.7
//                         must-have: an indefinitely-parked run stays visible AND
//                         manually abortable.
//
// (Ask answering / re-delivery are NOT operator run-actions any more — an ask is
// an adapter record answered through the ONE answer door; see ask_records.ts.)
//
// Each verifies the target run belongs to the acting team (a cross-team id reads
// as not-found).

import { sql } from 'kysely';
import { getAutomationsQb } from '../../lib/kysely';
import { MovementEngineError } from '../movement_engine/errors';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerRunId } from '../../generated/kysely/automations/TriggerRun';
import { failRunAndCancelRequests } from './run_failure';

/**
 * Abort a parked/running run — cancel it and all its open asks. Team-scopes the
 * run, then branches on its current status (runs-cancel task 3):
 *
 *   • `parked` → the original immediate path: `failRunAndCancelRequests`
 *     (trigger_run → failed, open requests → cancelled with their tokens dead,
 *     parked_run + join_pending cleared; prior external writes stand, P14).
 *     Safe to tear down synchronously — nothing is mid-flight.
 *   • `running` → a write COULD be mid-flight, so we don't touch the run
 *     directly. Instead we STAMP `cancel_requested_at`/`cancel_reason` via a
 *     guarded update (`WHERE status = 'running' AND cancel_requested_at IS
 *     NULL`) and let the engine's cooperative cancel gate
 *     (movement_engine/cancel_gate.ts) settle it at its next check-in — or, if
 *     the run parks before that check, the park sink's own tail check
 *     (park_sink.ts) settles it instead.
 *   • the guarded update can lose the race (the run parked or finished between
 *     our status read and the stamp attempt) — when it does, we re-read status
 *     and fall back: now-`parked` → the immediate path; terminal → no-op, the
 *     run already settled on its own.
 *
 * Reuses the cancel path rather than a dedicated `aborted` outcome: the run
 * status machine (§5.3) terminates at `failed`, and the failure_reason records
 * that the abort was operator-initiated.
 */
export async function abortRun(input: {
  runId: string;
  teamId: TeamId;
  abortedBy?: string;
}): Promise<{ runId: string }> {
  const runId = await assertOwnedRun(input.runId, input.teamId);
  const reason = input.abortedBy
    ? `Cancelled by ${input.abortedBy}`
    : 'Cancelled by an operator';

  const status = await readRunStatus(runId);

  if (status === 'running') {
    const stamped = await stampCancelRequested(runId, reason);
    if (stamped) {
      return { runId: runId as unknown as string };
    }
    // Raced — the run moved before our guarded update landed. Re-read and
    // fall back rather than blindly failing an already-settled run.
    const racedStatus = await readRunStatus(runId);
    if (racedStatus === 'parked') {
      await failRunAndCancelRequests({ runId, message: reason });
    }
    // else: terminal — the run already finished on its own; no-op.
    return { runId: runId as unknown as string };
  }

  if (status === 'parked') {
    await failRunAndCancelRequests({ runId, message: reason });
  }
  // else: terminal (or the row vanished between the ownership check and this
  // read) — no-op, nothing left to cancel.

  return { runId: runId as unknown as string };
}

/** Read the run's current status (a separate read from `assertOwnedRun` — that
 *  check only needs the id). */
async function readRunStatus(runId: TriggerRunId): Promise<string | undefined> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId)
    .select('status')
    .executeTakeFirst();
  return row?.status;
}

/** The guarded stamp: only lands on a run that is STILL `running` with no
 *  cancel already in flight. Returns whether it won the race. */
async function stampCancelRequested(runId: TriggerRunId, reason: string): Promise<boolean> {
  const row = await getAutomationsQb(['trigger_run'])
    .updateTable('trigger_run')
    .set({ cancel_requested_at: sql`now()`, cancel_reason: reason })
    .where('id', '=', runId)
    .where('status', '=', 'running')
    .where('cancel_requested_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  return row !== undefined;
}

/** Verify the run belongs to the team; return its branded id. */
async function assertOwnedRun(runId: string, teamId: TeamId): Promise<TriggerRunId> {
  const row = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('id', '=', runId as TriggerRunId)
    .where('team_id', '=', teamId)
    .select('id')
    .executeTakeFirst();
  if (!row) {
    throw new MovementEngineError('MOVENG_RUNTIME', `run ${runId} not found`);
  }
  return row.id;
}
