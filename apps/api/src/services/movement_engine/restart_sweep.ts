import { sql } from 'kysely';

import { getAutomationsQb } from '../../lib/kysely';
import { logger } from '../logger';
import { settleUnresumableRun } from '../interaction/run_failure';

const RESTART_ORPHAN_REASON = 'the server restarted while this run was executing';

/** When THIS process started. Not when this module loaded, and not when the
 *  sweep ran — the sweep waits on a lock that can be held for as long as the
 *  previous deployment takes to let go. */
function processBootedAt(): Date {
  return new Date(Date.now() - process.uptime() * 1000);
}

/**
 * Settle the runs a process death left behind.
 *
 * A `trigger_run` row is written `running` when the firing starts and is only
 * ever moved off that status by the firing itself — settling it, or parking it.
 * Kill the process in between and nothing is left to do either: the row stays
 * `running` forever, holding open every ask the run had asked, and reading on
 * the runs page as work still in progress. A server restart mid-run is the way
 * this happens in practice, and `cancelRun` is no help — cancelling asks the
 * firing to stop, and there is no firing left to ask.
 *
 * ── What this will not touch ────────────────────────────────────────────────
 *
 * **Parked runs.** A suspended run moves to `parked` and stays there — `running`
 * is written in exactly one place, the initial insert, and nothing writes it
 * back on resume. So a legitimately long-lived run waiting on a person, a timer
 * or an await is already outside this query on status alone. The `parked_run`
 * check below is a second guard for the window between the engine deciding to
 * park and `markParked()` landing, where the row is briefly still `running`.
 *
 * **Anything started since this process booted.** The sweep does not run at
 * startup; it runs once the automations background lock is IN HAND, and that
 * wait is unbounded — meanwhile this process's own HTTP paths are already
 * serving, and a firing on one of them writes a `running` row. So the bound is
 * the process's own start time, not the sweep's.
 *
 * ── The proof, stated ───────────────────────────────────────────────────────
 *
 * There is no instance or process marker on a run — no lease, no heartbeat, no
 * owner column — so the argument is made of the two facts above.
 *
 * The sweep runs holding the automations background lock, which means whichever
 * process held it before has released it: it exited, or it never existed. A row
 * older than this process's boot was therefore written by a process that is
 * gone. There is nothing left to settle it and nothing that could still be
 * executing it.
 *
 * That is a single-instance argument, and this deployment runs one instance.
 * The lock is per deployment, so with several API instances a `running` row
 * belonging to a live sibling would satisfy both facts and be settled out from
 * under it. A multi-instance future needs an owner column on the run — the
 * honest version of the proof — rather than a longer age bound, which only ever
 * traded a false settle for a run left hanging for hours.
 *
 * The age bound this replaced (six hours) was that trade: it delayed every
 * settle past any plausible synchronous firing, so an in-place restart or a
 * deploy left runs reading as in-progress for the rest of the day.
 */
export async function sweepRestartOrphanedRuns(): Promise<void> {
  const bootedAt = processBootedAt();

  // `parked_run` holds only LIVE leaves (a settled one is deleted), so this is
  // bounded live state — cheap to read whole, and this runs once per boot.
  const parked = await getAutomationsQb(['parked_run'])
    .selectFrom('parked_run')
    .where('status', '=', 'parked')
    .select('run_id')
    .execute();
  const parkedRunIds = new Set(parked.map((p) => p.run_id));

  const stale = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('status', '=', 'running')
    .where('started_at', '<', sql<Date>`${bootedAt}`)
    .select(['id', 'started_at'])
    .execute();

  const orphaned = stale.filter((run) => !parkedRunIds.has(run.id));
  if (orphaned.length === 0) return;

  logger.warn('[automations] settling runs orphaned by a restart', {
    count: orphaned.length,
    startedBefore: bootedAt.toISOString(),
  });

  for (const run of orphaned) {
    // One bad row must not cost the rest their settlement.
    try {
      // The same settle path listener retirement uses, so the run's asks close
      // with it rather than outliving it as live forms.
      await settleUnresumableRun({ runId: run.id, reason: RESTART_ORPHAN_REASON });
    } catch (error) {
      logger.error('[automations] could not settle a restart-orphaned run', {
        runId: run.id,
        error,
      });
    }
  }
}

/** Fire the sweep without making startup wait on it or die with it. */
export function wireRestartOrphanSweep(): void {
  void sweepRestartOrphanedRuns().catch((error) => {
    logger.error('[automations] restart-orphan sweep failed', { error });
  });
}

export { RESTART_ORPHAN_REASON, processBootedAt };
