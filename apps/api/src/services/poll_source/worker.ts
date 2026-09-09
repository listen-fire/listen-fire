// Poll-source worker — the platform half of the PollSource seam
// (plans/2026-06-19-granola-adapter). A `lib/worker` interval loop, sibling of
// `movement_scheduler/worker.ts` (cron) and `exposed_file/worker.ts`.
//
// One scan: find every movement-derived trigger whose `kind` resolves to a
// registered PollSource and that is due (its `poll_last_at` is older than the
// effective interval — `config.pollIntervalSeconds ?? source default`, P4), pull
// its new events, and INJECT each into the same dispatch path a webhook uses
// (`dispatchTriggerByIdEvent` — the one event pipeline). The opaque
// `poll_checkpoint` advances only after a successful pull; failures are contained
// per-trigger so one broken source never starves the rest.
//
// Process safety: startup.ts runs every background worker under the application
// advisory lock, so exactly one scanner runs at a time.

import { sql } from 'kysely';

import { SECOND } from '../../constants';
import { getAutomationsQb } from '../../lib/kysely';
import { worker } from '../../lib/worker';
import { logger } from '../logger';
import type { TeamId } from '../../generated/kysely/core/Team';
import type { TriggerId } from '../../generated/kysely/automations/Trigger';
import type { DiscriminableEvent, EventType } from '../translation_graph/adapter';
import {
  getAdapter,
  getPollSource,
  hasAdapter,
  isPollSource,
  resolveAdapterSlug,
} from '../translation_graph/adapters/registry';
import { dispatchDiscriminableEvent } from '../translation_graph/triggers/dispatch_event';

const SCAN_INTERVAL = 30 * SECOND;

function jsonb(value: unknown): unknown {
  return sql`${JSON.stringify(value)}::jsonb` as unknown;
}

interface PollTriggerRow {
  id: string;
  teamId: string;
  kind: string;
  config: unknown;
  credentialsId: string | undefined;
  movementId: string | null;
  checkpoint: unknown;
  lastPolledAt: Date | null;
}

async function loadCandidates(): Promise<PollTriggerRow[]> {
  const rows = await getAutomationsQb(['trigger'])
    .selectFrom('trigger')
    .where('movement_id', 'is not', null)
    .where('run_mode', '!=', 'off')
    .select([
      'id',
      'team_id',
      'kind',
      'config',
      'credentials_id',
      'movement_id',
      'poll_checkpoint',
      'poll_last_at',
    ])
    .execute();
  return rows
    .filter((r) => isPollSource(r.kind))
    .map((r) => ({
      id: r.id as unknown as string,
      teamId: r.team_id as unknown as string,
      kind: r.kind,
      config: r.config,
      credentialsId: (r.credentials_id as unknown as string | null) ?? undefined,
      movementId: (r.movement_id as unknown as string | null) ?? null,
      checkpoint: r.poll_checkpoint ?? undefined,
      lastPolledAt: r.poll_last_at,
    }));
}

/** The cadence to gate on: a `listen` option override (P4) or the source default. */
function effectiveIntervalMs(config: unknown, sourceDefaultSeconds: number): number {
  const override = (config as { pollIntervalSeconds?: unknown } | null | undefined)
    ?.pollIntervalSeconds;
  const seconds = typeof override === 'number' && override > 0 ? override : sourceDefaultSeconds;
  return seconds * SECOND;
}

/** One scan: poll every due source, contained per-trigger. */
export async function pollDueSources(now: Date = new Date()): Promise<void> {
  const candidates = await loadCandidates();
  for (const row of candidates) {
    try {
      await pollOne(row, now);
    } catch (err) {
      logger.error('[PollSource] scan failed for trigger', {
        triggerId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function pollOne(
  row: PollTriggerRow,
  now: Date,
  opts: { force?: boolean; surfaceErrors?: boolean } = {},
): Promise<{ eventCount: number }> {
  const source = getPollSource({
    adapterType: row.kind,
    teamId: row.teamId as TeamId,
    credentialsId: row.credentialsId,
  });
  if (!source) return { eventCount: 0 }; // de-registered between load and here

  if (
    !opts.force &&
    row.lastPolledAt &&
    now.getTime() - row.lastPolledAt.getTime() < effectiveIntervalMs(row.config, source.pollIntervalSeconds)
  ) {
    return { eventCount: 0 }; // not due
  }

  const result = await source.getEvents({ config: row.config, checkpoint: row.checkpoint });

  // The Adapter (same slug) supplies the event-type union for discrimination.
  const adapter = hasAdapter(row.kind)
    ? getAdapter({
        adapterType: row.kind,
        teamId: row.teamId as TeamId,
        credentialsId: row.credentialsId,
      })
    : null;
  const eventTypes = adapter?.listEventTypes ? await adapter.listEventTypes() : [];

  for (const event of result.events) {
    await dispatchPolledEvent({ row, event, eventTypes, now, surfaceErrors: opts.surfaceErrors });
  }

  // Advance the checkpoint + interval mark ONLY after a successful pull.
  await getAutomationsQb(['trigger'])
    .updateTable('trigger')
    .set({ poll_checkpoint: jsonb(result.checkpoint ?? null) as never, poll_last_at: now })
    .where('id', '=', row.id as TriggerId)
    .execute();

  return { eventCount: result.events.length };
}

async function dispatchPolledEvent(input: {
  row: PollTriggerRow;
  event: DiscriminableEvent;
  eventTypes: readonly EventType[];
  now: Date;
  surfaceErrors?: boolean;
}): Promise<void> {
  const { row, event, eventTypes, now } = input;
  await dispatchDiscriminableEvent({
    triggerId: row.id as TriggerId,
    movementId: row.movementId,
    event,
    adapterType: resolveAdapterSlug(row.kind),
    triggerType: 'poll',
    eventTypes,
    teamId: row.teamId as TeamId,
    now,
    ...(input.surfaceErrors ? { surfaceErrors: true } : {}),
  });
}

/**
 * Force ONE poll trigger to pull + dispatch NOW, bypassing the interval gate —
 * the in-process entry `dev:inject granola` rides (mirrors how `dev:inject cron`
 * fires a cron trigger off-schedule). Same `pollOne` path the worker runs, so it
 * exercises the real getEvents → discriminate → dispatch → run pipeline. Surfaces
 * the engine error inline (like the test-harness webhook injects) instead of just
 * logging it, so a failing movement run reports its smoking-gun message.
 */
export async function pollTriggerNow(input: {
  triggerId: string;
  now?: Date;
}): Promise<{ found: boolean; eventCount: number }> {
  const now = input.now ?? new Date();
  const row = (await loadCandidates()).find((r) => r.id === input.triggerId);
  if (!row) return { found: false, eventCount: 0 };
  const { eventCount } = await pollOne(row, now, { force: true, surfaceErrors: true });
  return { found: true, eventCount };
}

export function startPollSourcePoller(): void {
  worker(pollDueSources, SCAN_INTERVAL);
}
