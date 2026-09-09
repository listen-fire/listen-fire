import { MQ } from '../native';

/**
 * Run lifecycle ticks — `started` when a firing begins, `finished` when
 * it ends — so the UI can show how many automations are running RIGHT
 * NOW. Distinct from `triggerRuns.recorded` (which fires only at the
 * end, carrying the recorded row): a live count needs both edges.
 *
 * Published from the `TriggerRunRecorder` (construct → started, finish →
 * finished); consumed by `triggers.onRunActivity`, keyed by `teamId`.
 * There is no persisted "in-flight" row to seed from — a run exists as a
 * `trigger_run` row only once finished — so the client counter is purely
 * event-driven and self-heals by expiring stale `started` entries.
 */
export interface TriggerRunActivityEvent {
  teamId: string;
  runId: string;
  triggerId: string;
  phase: 'started' | 'finished';
}

const triggerRunActivityExchange = new MQ<TriggerRunActivityEvent>().setPresets({
  activity: {
    name: 'triggerRunActivity',
    type: 'fanout',
  },
  activityByTeamId: {
    name: 'triggerRunActivity.teamId',
    type: 'direct',
    key: 'teamId',
    keyPrefix: 'triggerRunActivity.teamId.',
  },
});

const { activity, activityByTeamId } = triggerRunActivityExchange;
activityByTeamId.attachTo(activity);

export { triggerRunActivityExchange };
