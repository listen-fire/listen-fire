// Loop-guard evaluate() — the floor's decision logic.
//
// Covers the budget decision (pause), the rate decision (throttle), allow,
// observe-vs-enforce wiring, the enabled kill-switch, and fail-open when the
// store throws. The store is mocked so each test drives exact windowed totals.

const totals = { rate: 0, teamRuns: 0 };
let storeThrows = false;

jest.mock('../store', () => ({
  guardKeys: {
    triggerRate: () => 'rate-key',
    teamRuns: () => 'runs-key',
    teamExternalWrites: () => 'writes-key',
    teamLlmTokens: () => 'tokens-key',
  },
  incrementAndSum: jest.fn(async ({ key }: { key: string }) => {
    if (storeThrows) throw new Error('redis exploded');
    if (key === 'rate-key') return { total: totals.rate, failOpen: false };
    if (key === 'runs-key') return { total: totals.teamRuns, failOpen: false };
    return { total: 0, failOpen: false };
  }),
}));

import { evaluate } from '../index';

const ENV_KEYS = [
  'LOOP_GUARD_MODE',
  'LOOP_GUARD_ENABLED',
  'LOOP_GUARD_TRIGGER_RATE',
  'LOOP_GUARD_TEAM_RUNS',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  totals.rate = 0;
  totals.teamRuns = 0;
  storeThrows = false;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Small, deterministic limits for the tests.
  process.env.LOOP_GUARD_TRIGGER_RATE = '5';
  process.env.LOOP_GUARD_TEAM_RUNS = '10';
  process.env.LOOP_GUARD_ENABLED = 'true';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

const base = {
  teamId: 'team1',
  triggerId: 'trig1',
  movementId: 'mov1',
  triggerName: 'My Automation',
};

describe('evaluate — enforce mode', () => {
  beforeEach(() => {
    process.env.LOOP_GUARD_MODE = 'enforce';
  });

  it('allows when under all limits', async () => {
    totals.rate = 3;
    totals.teamRuns = 4;
    const d = await evaluate(base);
    expect(d.kind).toBe('allow');
  });

  it('PAUSES on a team-budget breach (and budget wins over rate)', async () => {
    totals.rate = 100; // also over rate, but budget is the harder stop
    totals.teamRuns = 11; // over the budget of 10
    const d = await evaluate(base);
    expect(d.kind).toBe('pause');
    if (d.kind === 'pause') {
      expect(d.signal).toBe('team_budget');
      expect(d.enforced).toBe(true);
    }
  });

  it('THROTTLES on a per-trigger rate breach (budget still ok)', async () => {
    totals.rate = 6; // over rate of 5
    totals.teamRuns = 4; // under budget
    const d = await evaluate(base);
    expect(d.kind).toBe('throttle');
    if (d.kind === 'throttle') {
      expect(d.signal).toBe('trigger_rate');
      expect(d.enforced).toBe(true);
      expect(d.retryAfterMs).toBeGreaterThan(0);
    }
  });
});

describe('evaluate — observe mode (default)', () => {
  beforeEach(() => {
    process.env.LOOP_GUARD_MODE = 'observe';
  });

  it('computes a pause decision but marks it NOT enforced', async () => {
    totals.teamRuns = 11;
    const d = await evaluate(base);
    expect(d.kind).toBe('pause');
    if (d.kind === 'pause') expect(d.enforced).toBe(false);
  });

  it('computes a throttle decision but marks it NOT enforced', async () => {
    totals.rate = 6;
    const d = await evaluate(base);
    expect(d.kind).toBe('throttle');
    if (d.kind === 'throttle') expect(d.enforced).toBe(false);
  });

  it('defaults to observe when LOOP_GUARD_MODE is unset', async () => {
    delete process.env.LOOP_GUARD_MODE;
    totals.rate = 6;
    const d = await evaluate(base);
    if (d.kind === 'throttle') expect(d.enforced).toBe(false);
    else throw new Error('expected throttle');
  });
});

describe('evaluate — safety properties', () => {
  it('FAILS OPEN (allow) when the store throws', async () => {
    process.env.LOOP_GUARD_MODE = 'enforce';
    storeThrows = true;
    const d = await evaluate(base);
    expect(d.kind).toBe('allow');
  });

  it('the enabled kill-switch short-circuits to allow', async () => {
    process.env.LOOP_GUARD_MODE = 'enforce';
    process.env.LOOP_GUARD_ENABLED = 'false';
    totals.teamRuns = 9999;
    const d = await evaluate(base);
    expect(d.kind).toBe('allow');
  });
});
