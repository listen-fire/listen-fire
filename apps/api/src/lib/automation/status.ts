/**
 * Plain-English status derivation for an automation (automations.trigger +
 * its bound TGs). Shared between the home dashboard (U3) and the
 * automation list/detail (U4) so both surfaces agree on the badge
 * colour and label.
 *
 * Status pill is the user-facing summary of "is this thing working?"
 * per principle 3 of the 2026-05-29 redesign. The set is fixed:
 *
 *   - **live**         — at least one bound TG body has roots AND the
 *                        last run wasn't an error (or there have been
 *                        no errors in the lookback window).
 *   - **setting_up**   — at least one bound TG body is empty/placeholder
 *                        OR no runs ever AND the trigger was created
 *                        recently. The Setup or Translation agent owes
 *                        the user a next step.
 *   - **error**        — the most recent run errored. The user needs to
 *                        know.
 *   - **paused**       — explicit pause flag. Reserved for when we add
 *                        one; today nothing returns this.
 *
 * The thresholds below are intentionally generous; this is a triage
 * heuristic, not a SLA. Edge cases (a trigger that was live yesterday
 * but had a transient error this morning) fall into `error` — the
 * user surfaces the recent error and can investigate.
 *
 */

export type AutomationStatus = 'live' | 'setting_up' | 'paused' | 'error';

/**
 * Minimum information needed to derive a status. Sourced from rows the
 * caller already has on hand (the dashboard query joins trigger,
 * trigger_entry, translation_graph, tg_run); we don't reach back into
 * the DB from this helper so it stays trivially unit-testable.
 */
export type StatusInput = {
  /** True if any bound TG's body has a non-empty `roots` array. */
  hasNonEmptyTgBody: boolean;
  /** Status of the most recent run, if any. `null` means no runs ever. */
  lastRunStatus: 'success' | 'partial' | 'failed' | null;
  /** When was that last run (any status). `null` if none. */
  lastRunAt: Date | null;
  /** Trigger creation time. Retained on the input for callers; no longer
   *  affects the status (an authored automation is live regardless of age). */
  triggerCreatedAt: Date;
  /** Optional explicit pause flag. */
  paused?: boolean;
};

export function deriveAutomationStatus(input: StatusInput): AutomationStatus {
  if (input.paused) return 'paused';

  if (input.lastRunStatus === 'failed') return 'error';

  // `setting_up` means genuinely not done — no actions defined yet. An
  // automation that IS authored is **live**, even if it has never
  // received an event: it's wired and listening, just untested. (The
  // "hasn't run yet" nuance is surfaced as a calm status *detail*, not
  // by downgrading the pill — an untested-but-ready automation reading
  // "Setting up" is misleading.)
  if (!input.hasNonEmptyTgBody) return 'setting_up';

  return 'live';
}

/**
 * User-facing label for a status. Pinned here so U3 and U4 render the
 * exact same wording — drift between the dashboard pill and the
 * automation list pill is exactly the inconsistency this helper
 * exists to prevent.
 */
export function statusLabel(status: AutomationStatus): string {
  switch (status) {
    case 'live':
      return 'Live';
    case 'setting_up':
      return 'Setting up';
    case 'paused':
      return 'Paused';
    case 'error':
      return 'Error';
  }
}
