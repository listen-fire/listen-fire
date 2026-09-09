// The movement scheduler — the platform half of the cron adapter.
//
// `listen to timer { schedule: "0 9 * * 1" } fire digest` derives an
// ordinary `automations.trigger` row (kind 'cron', the schedule in config).
// This worker is the event source for those rows: a plain interval poll
// (the repo's `lib/worker.ts` loop — the same shape as the scheduled-input
// poller; there is no other job/cron infrastructure in the platform) that
// scans the cron-derived triggers, computes which schedules came due, and
// dispatches one tick per due listener through `dispatchTriggerByIdEvent`
// — uniform dispatch, uniform run_mode gating, uniform trigger_run
// recording, exactly like an inbound webhook.
//
// Checkpointing mirrors the scheduled-input poller's convention:
// `trigger.cron_last_fired_at` is the scheduler-owned mark (reconciliation
// never touches it). First sight establishes the checkpoint without
// firing (a freshly saved listener fires at its NEXT occurrence, not
// retroactively); after that, any occurrence due since the mark fires
// ONCE (missed occurrences collapse into one tick — a scheduler that was
// down for three Mondays does not fire three digests) and the mark
// advances. Schedules are five-field cron, UTC, validated at check time
// by the SAME parser (@listen-fire/shared/cron).
//
// Process safety: startup.ts runs every background worker under the
// application advisory lock, so exactly one scheduler scans at a time.

import { CronParseError, nextCronOccurrence, parseCron } from '#shared/cron';
import { SECOND } from '../../constants';
import { getAutomationsQb } from '../../lib/kysely';
import { worker } from '../../lib/worker';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import { logger } from '../logger';
import {
  CRON_ADAPTER_TYPE,
  type CronTickPayload,
} from '../translation_graph/adapters/cron';
import { dispatchTriggerByIdEvent } from '../translation_graph/triggers/router';
import type { TriggerEvent } from '../translation_graph/triggers/types';

const SCAN_INTERVAL = 30 * SECOND;

interface CronTriggerRow {
  id: string;
  teamId: string;
  name: string;
  schedule: string | null;
  timezone: string | null;
  lastFiredAt: Date | null;
}

async function loadDueCandidates(): Promise<CronTriggerRow[]> {
  const rows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('kind', '=', CRON_ADAPTER_TYPE)
    .where('movement_id', 'is not', null)
    .where('run_mode', '!=', 'off')
    .select(['id', 'team_id', 'name', 'config', 'cron_last_fired_at'])
    .execute();
  return rows.map((r) => {
    const config = (r.config ?? {}) as { schedule?: unknown; timezone?: unknown };
    return {
      id: r.id as unknown as string,
      teamId: r.team_id as unknown as string,
      name: r.name,
      schedule: typeof config.schedule === 'string' ? config.schedule : null,
      timezone: typeof config.timezone === 'string' ? config.timezone : null,
      lastFiredAt: r.cron_last_fired_at,
    };
  });
}

async function advanceCheckpoint(triggerId: string, to: Date): Promise<void> {
  await getAutomationsQb(['trigger'])
    .updateTable('trigger')
    .set({ cron_last_fired_at: to })
    .where('id', '=', triggerId as TriggerId)
    .execute();
}

/** One scan: fire every cron listener whose schedule came due since its
 *  checkpoint. Failures are contained per trigger — one broken listener
 *  never starves the rest. */
export async function fireDueCronListeners(now = new Date()): Promise<void> {
  const candidates = await loadDueCandidates();
  for (const candidate of candidates) {
    try {
      if (candidate.schedule === null) {
        // A cron trigger without a schedule can never fire — the checker
        // requires the key, so this is drift worth logging, not crashing.
        logger.warn('[MovementScheduler] cron trigger has no schedule in config', {
          triggerId: candidate.id,
        });
        continue;
      }
      const schedule = parseCron(candidate.schedule, {
        ...(candidate.timezone !== null ? { timezone: candidate.timezone } : {}),
      });

      if (candidate.lastFiredAt === null) {
        // First sight: establish the checkpoint, fire at the NEXT
        // occurrence (mirrors the scheduled-input poller's first run).
        await advanceCheckpoint(candidate.id, now);
        continue;
      }

      const due = nextCronOccurrence(schedule, candidate.lastFiredAt);
      if (due === null || due.getTime() > now.getTime()) continue;

      // Advance the mark BEFORE dispatching so a slow/crashing dispatch
      // can't double-fire on the next scan; missed occurrences collapse
      // into this one tick.
      await advanceCheckpoint(candidate.id, now);

      const payload: CronTickPayload = {
        firedAt: due.toISOString(),
        schedule: candidate.schedule,
      };
      const event: TriggerEvent = {
        pipelineInputId: `trigger:${candidate.id}`,
        adapterType: CRON_ADAPTER_TYPE,
        triggerType: 'webhook',
        payload,
        occurredAt: due.toISOString(),
      };
      const outcome = await dispatchTriggerByIdEvent({
        triggerId: candidate.id,
        event,
        teamId: candidate.teamId as TeamId,
      });
      if (outcome.errors !== undefined && outcome.errors.length > 0) {
        logger.error('[MovementScheduler] cron firing reported errors', {
          triggerId: candidate.id,
          name: candidate.name,
          errors: outcome.errors.map((e) => e.message),
        });
      } else {
        logger.info('[MovementScheduler] cron listener fired', {
          triggerId: candidate.id,
          name: candidate.name,
          due: due.toISOString(),
        });
      }
    } catch (err) {
      if (err instanceof CronParseError) {
        logger.warn('[MovementScheduler] invalid schedule on cron trigger', {
          triggerId: candidate.id,
          schedule: candidate.schedule,
          error: err.message,
        });
        continue;
      }
      logger.error('[MovementScheduler] cron scan failed for trigger', {
        triggerId: candidate.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function startMovementCronScheduler(): void {
  worker(fireDueCronListeners, SCAN_INTERVAL);
}
