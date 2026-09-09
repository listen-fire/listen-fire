// A trigger's run_mode — the per-automation liveness gate. It sits ON TOP of
// the content-derived `onlyAuthored` gate: an authored automation still won't
// write to live systems unless its run_mode is `live`.
//
//   dry_run — run the orchestration, but capture writes instead of
//             committing them (engine `dryRun: true`). The tg_run row is
//             still recorded, so the user sees what *would* have happened.
//   live    — commit writes.
//
// The dry_run⇄live axis is DERIVED FROM THE MOVEMENT TEXT and reconciled on
// every save (see movement/provision.ts) — nothing outside that reconciliation
// writes it.
//
//   off     — never dispatch. Drop at the dispatcher with a clear reason.
//
// `off` is a TOLERATED DEAD STATE: it was the operator pause (a toggle in the
// app), and that pause was retired so the movement text is the only pause
// authority — pausing comments the `listen` line out. No writer remains; the
// rows that still carry `off` predate the removal and are deliberately NOT
// auto-resumed, so the gate below keeps honouring them until they are
// hand-converted (`pnpm listeners:paused` lists them) and the value retired by
// a migration.

export type TriggerRunMode = 'off' | 'dry_run' | 'live';

const RUN_MODES: readonly TriggerRunMode[] = ['off', 'dry_run', 'live'];

/**
 * Coerce a raw DB / input string to a TriggerRunMode, defaulting to `live`
 * for null / unknown values (matches the column default — an automation
 * with a corrupt run_mode is treated as live rather than silently muted).
 */
export function parseRunMode(value: unknown): TriggerRunMode {
  return typeof value === 'string' && (RUN_MODES as readonly string[]).includes(value)
    ? (value as TriggerRunMode)
    : 'live';
}

export type RunModeGate =
  | { dispatch: false; droppedReason: 'run_mode_off' }
  | { dispatch: true; dryRun: boolean };

/**
 * The dispatch decision for a run_mode. `off` drops; `dry_run` dispatches
 * with the engine in dry-run mode; `live` dispatches normally. The single
 * source of truth both dispatch paths (inbound + KG-mutation) consult so
 * the off/dry_run/live semantics can't drift between them.
 *
 * `off` still drops even though nothing can set it any more — an existing
 * paused listener must stay paused, not silently resume.
 */
export function runModeGate(runMode: TriggerRunMode): RunModeGate {
  switch (runMode) {
    case 'off':
      return { dispatch: false, droppedReason: 'run_mode_off' };
    case 'dry_run':
      return { dispatch: true, dryRun: true };
    case 'live':
      return { dispatch: true, dryRun: false };
  }
}
