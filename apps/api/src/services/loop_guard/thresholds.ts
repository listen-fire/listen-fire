// Loop guard — tunables and the observe/enforce mode flag.
//
// Phase 1 (the floor): strong code defaults so the guard is useful WITHOUT any
// per-team config UI (that UI is an explicit follow-up). Each default is
// env-overridable for ops calibration. Per-team overrides are a follow-up — see
// plans/2026-06-14-loop-guard/6_phasing.md ("user-configurable limits UI").
//
// the floor

// These tunables are ZERO-CONFIG by design (§3.1): the guard boots with the
// code defaults below and runs observe-only — env vars are OPTIONAL ops
// overrides, never required. We read `process.env` directly (NOT the
// prod-required `getEnvVar`) so an unset var falls back to its default in
// production too, rather than hard-crashing boot.

/**
 * Enforcement mode. Default is OBSERVE — the guard logs "would-throttle /
 * would-pause" but never actually blocks a run, so the guard being on can't
 * surprise-break a live automation. Opt into blocking with a single env var
 * (`LOOP_GUARD_MODE=enforce`) once a calibration window has built confidence.
 *
 * "run observe-only first"
 */
export type GuardMode = 'observe' | 'enforce';

export function guardMode(): GuardMode {
  // Default observe (never blocks). Only the explicit string 'enforce' arms it.
  return process.env.LOOP_GUARD_MODE === 'enforce' ? 'enforce' : 'observe';
}

/**
 * Whether the guard runs at all. A separate kill-switch from the mode so the
 * whole subsystem can be disabled (e.g. if Redis is degraded fleet-wide)
 * without code changes. Default on — but "on" means observe (non-blocking)
 * unless `LOOP_GUARD_MODE=enforce` is also set.
 */
export function guardEnabled(): boolean {
  return process.env.LOOP_GUARD_ENABLED !== 'false';
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Per-trigger minute-level rate limit and the per-team rolling-window usage
 * budgets. The trigger rate is the tight loop catcher (a thrashing automation
 * fires far above this in a minute); the team budgets are the coarse
 * cause-agnostic cost cap across ALL the team's automations.
 *
 * Numbers chosen as strong-but-generous defaults: a legitimate high-throughput
 * automation rarely fires a single trigger more than a few times a second
 * sustained, and a team rarely makes thousands of external writes a minute by
 * design — but a loop blows straight through both.
 */
export interface GuardThresholds {
  /** Per-trigger firings allowed within the rate window. */
  triggerRatePerWindow: number;
  /** Rate window length in seconds (the rolling window for the per-minute cap). */
  rateWindowSeconds: number;

  /** Per-team movement runs allowed within the team budget window. */
  teamRunsPerWindow: number;
  /** Per-team external writes allowed within the team budget window. */
  teamExternalWritesPerWindow: number;
  /** Per-team LLM tokens allowed within the team budget window. */
  teamLlmTokensPerWindow: number;
  /** Team budget window length in seconds (the rolling cost window). */
  teamWindowSeconds: number;
}

/**
 * Resolve the active thresholds. Code constants, env-overridable. (A per-team
 * row would slot in here later without touching any caller.)
 */
export function resolveThresholds(): GuardThresholds {
  return {
    triggerRatePerWindow: envInt('LOOP_GUARD_TRIGGER_RATE', 60),
    rateWindowSeconds: envInt('LOOP_GUARD_RATE_WINDOW_SECONDS', 60),

    teamRunsPerWindow: envInt('LOOP_GUARD_TEAM_RUNS', 600),
    teamExternalWritesPerWindow: envInt('LOOP_GUARD_TEAM_EXTERNAL_WRITES', 2000),
    teamLlmTokensPerWindow: envInt('LOOP_GUARD_TEAM_LLM_TOKENS', 5_000_000),
    teamWindowSeconds: envInt('LOOP_GUARD_TEAM_WINDOW_SECONDS', 600),
  };
}
