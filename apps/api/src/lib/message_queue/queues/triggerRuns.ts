import { MQ } from '../native';

/**
 * A trigger_run row was just recorded — the real-time signal behind the
 * automation detail page's "Recent activity". Published from the
 * `TriggerRunRecorder` after the row is written; consumed by the
 * `triggers.onRecentActivity` subscription, keyed by `triggerId` so a page only
 * hears about its own automation's firings.
 *
 * Carries the fields the `getAutomationDetail.recentEvents` query reads, so a
 * live event and an initially-loaded one merge cleanly on the client. (Dates are
 * ISO strings — there's no tRPC transformer, so this is what the query hands the
 * client too.)
 */
export interface TriggerRunEvent {
  id: string;
  teamId: string;
  /** The `automations.trigger` (automation) id this firing belongs to. */
  triggerId: string;
  status: 'success' | 'partial' | 'failed';
  startedAt: string;
  completedAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  nodesWritten: number;
  dryRun: boolean;
}

const triggerRunsExchange = new MQ<TriggerRunEvent>().setPresets({
  recorded: {
    name: 'triggerRun.recorded',
    type: 'fanout',
  },
  recordedByTriggerId: {
    name: 'triggerRun.recorded.triggerId',
    type: 'direct',
    key: 'triggerId',
    keyPrefix: 'triggerRun.recorded.triggerId.',
  },
});

const { recorded, recordedByTriggerId } = triggerRunsExchange;

recordedByTriggerId.attachTo(recorded);

export { triggerRunsExchange };
