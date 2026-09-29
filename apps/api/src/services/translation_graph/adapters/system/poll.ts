// System PollSource — the platform's own events, read from what it already
// records.
//
// WHY A POLL, NOT A PUSH. A run is marked failed by several independent writers
// (the run recorder, Run now's settle, the interaction failure path, a cancel),
// none of which goes through a shared queue. Hooking each one would be a seam
// per writer and a silent gap the day a fifth appears. The run table is where
// every one of them lands, so a poll over it since a checkpoint catches all of
// them uniformly — at the price of a minute or two of latency, which a failure
// notice can afford.
//
// An automation is never told about its own failures: a handler that fails
// while reporting a failure would otherwise report itself, forever. The worker
// hands the listening automation's id in, and its own runs are skipped (the
// checkpoint still passes them, so they are never reconsidered).

import type { TeamId } from '../../../../generated/kysely/core/Team';
import type { MovementId } from '../../../../generated/kysely/automations/Movement';
import type { TriggerId } from '../../../../generated/kysely/automations/Trigger';
import type { TriggerRunId } from '../../../../generated/kysely/automations/TriggerRun';
import { getAutomationsQb } from '../../../../lib/kysely';
import { getEnvVar } from '../../../../lib/utils/environment';
import type { DiscriminableEvent } from '../../adapter';
import type { PollSource } from '../../poll_source';
import { eventConfigList } from '../../triggers/listen_config';
import { RUN_FAILED, type SystemEventPayload } from './types';

/** The platform's own table is cheap to read; a failure notice should not wait
 *  five minutes. Overridable per listen with `pollIntervalSeconds`. */
const DEFAULT_POLL_INTERVAL_SECONDS = 60;

/** A run's `failed_at` is stamped before its row commits, so a row can appear
 *  with a time already behind the mark. Reading only rows older than this
 *  keeps the mark behind every write still in flight. */
const SETTLE_MS = 10_000;

/** Rows per poll. More than this waits for the next poll rather than
 *  delivering a flood in one tick. */
const PAGE_SIZE = 100;

/** The lowest run id, for a mark that has no run at its instant yet. */
const NIL_RUN_ID = '00000000-0000-0000-0000-000000000000';

/** Where the last poll stopped: the (failed at, run id) of the last run it
 *  passed. Ordered on both so runs failing in the same millisecond are neither
 *  skipped nor delivered twice. */
export interface RunFailedMark {
  failedAt: string;
  runId: string;
}

export interface SystemCheckpoint {
  runFailed?: RunFailedMark;
}

/** One failed run, joined to the automation it belongs to — null for a run
 *  no automation owns (a legacy or simulated run), which the mark still passes
 *  but nothing delivers, since there is nothing to name or link. */
export interface FailedRun {
  runId: string;
  automation: { id: string; name: string } | null;
  reason: string;
  failedAt: Date;
}

/** A failed run that belongs to an automation — the only kind delivered. */
type OwnedFailedRun = FailedRun & { automation: { id: string; name: string } };

/** Reads the team's failed runs strictly after `after`, no later than
 *  `until`, oldest first. The seam tests replace. */
export type FailedRunReader = (input: {
  teamId: TeamId;
  after: RunFailedMark;
  until: Date;
  limit: number;
}) => Promise<FailedRun[]>;

function runFailedMark(checkpoint: unknown): RunFailedMark | undefined {
  const mark = (checkpoint as SystemCheckpoint | null | undefined)?.runFailed;
  return typeof mark?.failedAt === 'string' && typeof mark.runId === 'string' ? mark : undefined;
}

/** Whether a listen selected `Run Failed` — explicitly, or by selecting
 *  nothing (the manifest's default). */
function wantsRunFailed(config: unknown): boolean {
  const selected = eventConfigList((config as { events?: unknown } | null | undefined)?.events);
  return selected.length === 0 || selected.includes(RUN_FAILED.displayName);
}

function webBaseUrl(): string {
  return getEnvVar('WEB_BASE_URL', { devDefault: 'http://localhost:3003' }).replace(/\/$/, '');
}

/** The automation's run history, filtered to its failures — the page a person
 *  opens to see this run beside the others. */
export function failedRunsUrl(automationId: string): string {
  return `${webBaseUrl()}/movements/${encodeURIComponent(automationId)}?view=activity&status=failed`;
}

export function runFailedEvent(run: OwnedFailedRun): DiscriminableEvent {
  const at = run.failedAt.toISOString();
  const payload: SystemEventPayload = {
    automation: run.automation.name,
    automationId: run.automation.id,
    runId: run.runId,
    // Language versions do not exist yet; the field is part of the record so a
    // handler written today reads the same once they do.
    version: '',
    reason: run.reason,
    url: failedRunsUrl(run.automation.id),
    at,
  };
  return {
    payload,
    externalId: run.runId,
    // Per-trigger receipt dedupe: a run is reported to a listener once, even if
    // a crash between dispatch and checkpoint replays the poll.
    idempotencyKey: `${RUN_FAILED.tag}:${run.runId}`,
    tag: RUN_FAILED.tag,
    occurredAt: at,
  };
}

export class SystemPollSource implements PollSource {
  readonly pollIntervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS;

  constructor(
    private readonly teamId: TeamId,
    /** Injectable for tests; production reads the run table. */
    private readonly readFailedRuns: FailedRunReader = readFailedRunsFromDb,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getEvents(input: {
    config: unknown;
    checkpoint?: unknown;
    movementId?: string;
  }): Promise<{ events: DiscriminableEvent[]; checkpoint?: unknown }> {
    const previous = (input.checkpoint ?? {}) as SystemCheckpoint;
    // The other three kinds are declared for the deploy check the next release
    // adds; until then a listen on them has nothing to read.
    if (!wantsRunFailed(input.config)) return { events: [], checkpoint: previous };

    const until = new Date(this.now().getTime() - SETTLE_MS);
    const mark = runFailedMark(input.checkpoint);
    // First poll: set the mark and emit nothing. Going live never replays the
    // failures that happened before anyone was listening.
    if (mark === undefined) {
      return {
        events: [],
        checkpoint: { ...previous, runFailed: { failedAt: until.toISOString(), runId: NIL_RUN_ID } },
      };
    }

    const runs = await this.readFailedRuns({
      teamId: this.teamId,
      after: mark,
      until,
      limit: PAGE_SIZE,
    });
    const last = runs[runs.length - 1];
    const next: RunFailedMark =
      last === undefined ? mark : { failedAt: last.failedAt.toISOString(), runId: last.runId };

    return {
      events: runs
        .filter((run): run is OwnedFailedRun => run.automation !== null)
        .filter((run) => run.automation.id !== input.movementId)
        .map(runFailedEvent),
      checkpoint: { ...previous, runFailed: next },
    };
  }
}

/** A run's aggregate errors, as the first message among them. */
function firstErrorMessage(errors: unknown): string | undefined {
  if (!Array.isArray(errors)) return undefined;
  for (const error of errors) {
    const message = (error as { message?: unknown } | null)?.message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return undefined;
}

/** A run row's trigger id is engine-side text; only a uuid can name a trigger
 *  row, so anything else (a legacy or simulated run) has no automation. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const readFailedRunsFromDb: FailedRunReader = async ({ teamId, after, until, limit }) => {
  const afterAt = new Date(after.failedAt);
  const runs = await getAutomationsQb(['trigger_run'])
    .selectFrom('trigger_run')
    .where('team_id', '=', teamId)
    .where('status', '=', 'failed')
    // A rehearsal failing is the author trying something, not an incident.
    .where('dry_run', '=', false)
    .where('failed_at', 'is not', null)
    .where('failed_at', '<=', until)
    .where((eb) =>
      eb.or([
        eb('failed_at', '>', afterAt),
        eb.and([eb('failed_at', '=', afterAt), eb('id', '>', after.runId as TriggerRunId)]),
      ]),
    )
    .select(['id', 'trigger_id', 'failed_at', 'failure_reason', 'errors'])
    .orderBy('failed_at', 'asc')
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
  if (runs.length === 0) return [];

  const triggerIds = [...new Set(runs.map((r) => r.trigger_id).filter((id) => UUID.test(id)))];
  const triggers =
    triggerIds.length === 0
      ? []
      : await getAutomationsQb(['trigger'])
          .selectFrom('trigger')
          .where('team_id', '=', teamId)
          .where('id', 'in', triggerIds as TriggerId[])
          .where('movement_id', 'is not', null)
          .select(['id', 'movement_id'])
          .execute();
  const movementByTrigger = new Map(
    triggers.map((t) => [t.id as string, t.movement_id as string]),
  );

  const movementIds = [...new Set(movementByTrigger.values())];
  const movements =
    movementIds.length === 0
      ? []
      : await getAutomationsQb(['movement'])
          .selectFrom('movement')
          .where('team_id', '=', teamId)
          .where('id', 'in', movementIds as MovementId[])
          .select(['id', 'name'])
          .execute();
  const nameByMovement = new Map(movements.map((m) => [m.id as string, m.name]));

  return runs.flatMap((run) => {
    // Unreachable (the query requires it), but the column type cannot say so.
    if (run.failed_at === null) return [];
    const automationId = movementByTrigger.get(run.trigger_id);
    const name = automationId === undefined ? undefined : nameByMovement.get(automationId);
    return [
      {
        runId: run.id as string,
        automation:
          automationId !== undefined && name !== undefined ? { id: automationId, name } : null,
        reason:
          run.failure_reason ?? firstErrorMessage(run.errors) ?? 'The run failed without a recorded reason.',
        failedAt: run.failed_at,
      },
    ];
  });
};

/** Factory matching the registry's PollSourceFactory signature. */
export function createSystemPollSource(input: { teamId: TeamId }): SystemPollSource {
  return new SystemPollSource(input.teamId);
}
