// Loop guard — shared types for the Phase-1 floor.

/** Which floor signal tripped. Branches on this use `neverAsAny` for exhaustiveness. */
export type GuardSignal = 'trigger_rate' | 'team_budget';

/**
 * The guard's verdict for one dispatch.
 *
 *  - `allow`   — under all limits; run normally.
 *  - `throttle`— over the per-trigger rate but not a budget breach. The run is
 *                deferred (queue-don't-drop): held and released later, never
 *                lost. Transient; does NOT set the guard-paused state.
 *  - `pause`   — a team budget breach (the coarse cost cap). Set the persistent
 *                guard-paused state, notify, and skip the run until a human
 *                resumes. The inbound receipt stays replayable.
 *
 * In OBSERVE mode the decision is computed and logged but the caller is told to
 * allow regardless (`enforced: false`).
 */
export type GuardDecision =
  | { kind: 'allow' }
  | {
      kind: 'throttle';
      signal: 'trigger_rate';
      reason: string;
      /** Suggested delay before the held event is released, in ms. */
      retryAfterMs: number;
      /** Whether enforcement actually applies (false in observe mode). */
      enforced: boolean;
    }
  | {
      kind: 'pause';
      signal: GuardSignal;
      reason: string;
      enforced: boolean;
    };
