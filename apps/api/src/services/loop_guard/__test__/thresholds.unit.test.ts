import { guardMode, guardEnabled, resolveThresholds } from '../thresholds';

// The loop-guard tunables are ZERO-CONFIG by design: unset env vars must fall
// back to code defaults (in production too — they are NOT required), and the
// guard must default to OBSERVE so it never blocks a run unless explicitly
// armed. Regression guard for the prod-boot crash where every LOOP_GUARD_* var
// was required.

const GUARD_VARS = [
  'LOOP_GUARD_MODE',
  'LOOP_GUARD_ENABLED',
  'LOOP_GUARD_TRIGGER_RATE',
  'LOOP_GUARD_RATE_WINDOW_SECONDS',
  'LOOP_GUARD_TEAM_RUNS',
  'LOOP_GUARD_TEAM_EXTERNAL_WRITES',
  'LOOP_GUARD_TEAM_LLM_TOKENS',
  'LOOP_GUARD_TEAM_WINDOW_SECONDS',
] as const;

describe('loop-guard thresholds — zero-config', () => {
  // NODE_ENV is a typed literal in this repo; reach it through a mutable view.
  const env = process.env as Record<string, string | undefined>;
  let saved: Record<string, string | undefined>;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    saved = Object.fromEntries(GUARD_VARS.map((n) => [n, process.env[n]]));
    savedNodeEnv = env.NODE_ENV;
    for (const n of GUARD_VARS) delete process.env[n];
  });

  afterEach(() => {
    for (const n of GUARD_VARS) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
    env.NODE_ENV = savedNodeEnv;
  });

  it('all vars unset: resolves the code defaults WITHOUT throwing (even in production)', () => {
    env.NODE_ENV = 'production';
    expect(() => resolveThresholds()).not.toThrow();
    expect(resolveThresholds()).toEqual({
      triggerRatePerWindow: 60,
      rateWindowSeconds: 60,
      teamRunsPerWindow: 600,
      teamExternalWritesPerWindow: 2000,
      teamLlmTokensPerWindow: 5_000_000,
      teamWindowSeconds: 600,
    });
  });

  it('defaults to OBSERVE (never blocks) and only arms on explicit enforce', () => {
    env.NODE_ENV = "production";
    expect(guardMode()).toBe('observe');
    process.env.LOOP_GUARD_MODE = 'enforce';
    expect(guardMode()).toBe('enforce');
    process.env.LOOP_GUARD_MODE = 'anything-else';
    expect(guardMode()).toBe('observe');
  });

  it('defaults to enabled (observe-active), off only on the explicit "false"', () => {
    expect(guardEnabled()).toBe(true);
    process.env.LOOP_GUARD_ENABLED = 'false';
    expect(guardEnabled()).toBe(false);
  });

  it('an env override is honoured; a junk value falls back to the default', () => {
    process.env.LOOP_GUARD_TRIGGER_RATE = '5';
    expect(resolveThresholds().triggerRatePerWindow).toBe(5);
    process.env.LOOP_GUARD_TRIGGER_RATE = 'not-a-number';
    expect(resolveThresholds().triggerRatePerWindow).toBe(60);
    process.env.LOOP_GUARD_TRIGGER_RATE = '0';
    expect(resolveThresholds().triggerRatePerWindow).toBe(60);
  });
});
