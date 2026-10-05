// The optional per-run cost cap: what it reads, what a run is charged, and
// when the next priced call is refused.

jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const insertInto = jest.fn();
jest.mock('../kysely', () => ({ getQb: () => ({ insertInto }) }));

import { LlmUsageContext, recordLlmUsage } from '../llm_usage';
import {
  assertRunBudget,
  assertRunCostCapConfigured,
  costEnvelopeMicrodollars,
  currentRunSpend,
  isRunCostCapExceeded,
  parseRunCostCap,
  reportRunCost,
  RUN_COST_CAP_ENV_VAR,
  RunCostCapExceeded,
  withRunSpendLedger,
  type CostSource,
} from '../run_spend';

const ENV_VAR = 'MOVEMENT_MAX_RUN_COST_USD';
const DOLLAR = 1_000_000;

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
  insertInto.mockReset();
  insertInto.mockReturnValue({ values: () => ({ execute: async () => undefined }) });
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = saved;
});

const SCRAPE: CostSource = { kind: 'service', name: 'brightdata.web_unlocker' };

/** A priced call's charge, as any reporter makes it. */
function charge(microdollars: number, source: CostSource = SCRAPE): void {
  reportRunCost({ source, microdollars });
}

const segmentSpend = () => currentRunSpend().segmentMicrodollars;

function caught(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('the env var', () => {
  it('is named MOVEMENT_MAX_RUN_COST_USD', () => {
    expect(RUN_COST_CAP_ENV_VAR).toBe(ENV_VAR);
  });

  it('unset or blank means no cap', () => {
    expect(parseRunCostCap(undefined)).toBeUndefined();
    expect(parseRunCostCap('  ')).toBeUndefined();
    expect(() => assertRunCostCapConfigured({})).not.toThrow();
  });

  it('a positive number of dollars is the cap, in microdollars', () => {
    expect(parseRunCostCap('5')).toBe(5 * DOLLAR);
    expect(parseRunCostCap('0.25')).toBe(250_000);
  });

  it.each(['0', '-1', 'five', '5usd', 'Infinity', 'NaN'])('boot refuses %p, naming the variable', (raw) => {
    expect(() => assertRunCostCapConfigured({ [ENV_VAR]: raw })).toThrow(
      new RegExp(`^${ENV_VAR}="${raw}" is not a positive number of US dollars`),
    );
  });
});

describe('with no cap set', () => {
  it('a run spends without limit, and still knows what it spent', async () => {
    await withRunSpendLedger(async () => {
      for (let i = 0; i < 100; i++) {
        assertRunBudget();
        charge(DOLLAR);
      }
      expect(segmentSpend()).toBe(100 * DOLLAR);
    });
  });
});

describe('with a cap set', () => {
  beforeEach(() => {
    process.env[ENV_VAR] = '2.5';
  });

  it('the call that crosses the cap goes through; the NEXT priced call is refused', async () => {
    await withRunSpendLedger(async () => {
      assertRunBudget();
      charge(2 * DOLLAR);
      assertRunBudget();
      charge(1 * DOLLAR); // over now
      const err = caught(assertRunBudget);
      expect(isRunCostCapExceeded(err)).toBe(true);
      expect(err).toBeInstanceOf(RunCostCapExceeded);
      expect((err as RunCostCapExceeded).capMicrodollars).toBe(2.5 * DOLLAR);
      expect((err as RunCostCapExceeded).spentMicrodollars).toBe(3 * DOLLAR);
    });
  });

  it("its message is the author's whole failure surface: the cap, the spend, the knob, how to raise it", async () => {
    await withRunSpendLedger(async () => {
      charge(3 * DOLLAR);
      expect(() => assertRunBudget()).toThrow(
        'Run cost cap reached: this run has spent $3.00 on model calls and paid services, ' +
          'and the limit set by MOVEMENT_MAX_RUN_COST_USD is $2.50. ' +
          'The run was stopped before its next priced call in case something was looping. ' +
          "If this run legitimately needs more, raise MOVEMENT_MAX_RUN_COST_USD in the server's environment " +
          '(or unset it to remove the cap).',
      );
    });
  });

  it('a different run has its own account', async () => {
    await withRunSpendLedger(async () => charge(3 * DOLLAR));
    await withRunSpendLedger(async () => {
      expect(segmentSpend()).toBe(0);
      expect(() => assertRunBudget()).not.toThrow();
    });
  });

  it('a resumed segment is seeded with what the run spent before it parked: the cap holds across parks', async () => {
    // Segment one spends $2 — under the cap — and parks.
    const first = await withRunSpendLedger(async () => {
      assertRunBudget();
      charge(2 * DOLLAR);
      return currentRunSpend();
    });
    // Segment two resumes with the run's $2 behind it: one more dollar takes
    // the RUN over, and its next priced call is refused.
    await withRunSpendLedger(
      async () => {
        assertRunBudget();
        charge(DOLLAR);
        expect(currentRunSpend()).toEqual({
          segmentMicrodollars: DOLLAR,
          runMicrodollars: 3 * DOLLAR,
          bySource: { 'service:brightdata.web_unlocker': DOLLAR },
        });
        const err = caught(assertRunBudget);
        expect(err).toBeInstanceOf(RunCostCapExceeded);
        expect((err as RunCostCapExceeded).spentMicrodollars).toBe(3 * DOLLAR);
      },
      { priorMicrodollars: first.runMicrodollars },
    );
  });

  it('a segment seeded at or over the cap refuses its first priced call', async () => {
    await withRunSpendLedger(async () => expect(() => assertRunBudget()).toThrow(RunCostCapExceeded), {
      priorMicrodollars: 2.5 * DOLLAR,
    });
  });

  it('a run dispatched inline by another run keeps its own account', async () => {
    await withRunSpendLedger(async () => {
      charge(3 * DOLLAR);
      await withRunSpendLedger(async () => {
        expect(currentRunSpend().runMicrodollars).toBe(0);
        expect(() => assertRunBudget()).not.toThrow();
        charge(DOLLAR);
      });
      expect(currentRunSpend().runMicrodollars).toBe(3 * DOLLAR);
    });
  });

  it('outside a run nothing is charged and nothing is refused', () => {
    charge(100 * DOLLAR);
    expect(segmentSpend()).toBe(0);
    expect(() => assertRunBudget()).not.toThrow();
  });

  it('concurrent members charge the one account, and none of it is lost', async () => {
    await withRunSpendLedger(async () => {
      await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          await new Promise((resolve) => setTimeout(resolve, (i * 7) % 5));
          charge(100_000);
        }),
      );
      expect(segmentSpend()).toBe(2 * DOLLAR);
      expect(() => assertRunBudget()).not.toThrow();
      charge(500_000);
      expect(() => assertRunBudget()).toThrow(RunCostCapExceeded);
    });
  });
});

describe('one entry point for every price', () => {
  it('every charge is summed by where it went', async () => {
    await withRunSpendLedger(async () => {
      charge(1_500);
      charge(1_500);
      charge(2 * DOLLAR, { kind: 'model', name: 'claude-sonnet-5' });
      charge(700, { kind: 'plugin', name: 'fetch_url' });
      expect(currentRunSpend()).toEqual({
        segmentMicrodollars: 2 * DOLLAR + 3_700,
        runMicrodollars: 2 * DOLLAR + 3_700,
        bySource: {
          'service:brightdata.web_unlocker': 3_000,
          'model:claude-sonnet-5': 2 * DOLLAR,
          'plugin:fetch_url': 700,
        },
      });
    });
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('a cost of %p is refused, naming its source', (bad) => {
    expect(() => charge(bad)).toThrow(/service:brightdata\.web_unlocker reported a cost of/);
  });
});

describe('the cost envelope', () => {
  it('a price already worked out is charged as given', () => {
    expect(costEnvelopeMicrodollars({ microdollars: 1_500 })).toBe(1_500);
  });

  it('usage and a unit price are multiplied, to whole microdollars', () => {
    expect(costEnvelopeMicrodollars({ quantity: 3, unit: 'page', unitPriceMicrodollars: 1_500.4 })).toBe(4_501);
  });

  it.each([
    { microdollars: -1 },
    { microdollars: '5' },
    { quantity: 2, unit: 'page' },
    { quantity: 2, unit: '', unitPriceMicrodollars: 5 },
    { microdollars: 5, extra: true },
    null,
  ])('refuses %p rather than charging garbage', (bad) => {
    expect(() => costEnvelopeMicrodollars(bad)).toThrow(/a cost report must be/);
  });
});

describe('what a model call charges', () => {
  it('recordLlmUsage charges the run what it priced the call at — the same number as the usage row', async () => {
    const values = jest.fn().mockReturnValue({ execute: async () => undefined });
    insertInto.mockReturnValue({ values });
    await withRunSpendLedger(async () => {
      await new LlmUsageContext({ teamId: 'team-1' }).runAsync(async () => {
        await recordLlmUsage({
          resolved: { preferred: 'claude-sonnet-5', provider: 'anthropic', wireModel: 'claude-sonnet-5' },
          callType: 'chat',
          inputTokens: 1_000_000,
          outputTokens: 100_000,
        });
      });
      // $2/M in + $10/M out, under the model's own name.
      expect(segmentSpend()).toBe(3 * DOLLAR);
      expect(currentRunSpend().bySource).toEqual({ 'model:claude-sonnet-5': 3 * DOLLAR });
      expect(values.mock.calls[0]?.[0].cost_microdollars).toBe(3 * DOLLAR);
    });
  });

  it('charges before its first await, so an unawaited record is already counted', async () => {
    await withRunSpendLedger(async () => {
      void recordLlmUsage({
        resolved: { preferred: 'claude-sonnet-5', provider: 'anthropic', wireModel: 'claude-sonnet-5' },
        callType: 'chat',
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
      expect(segmentSpend()).toBe(2 * DOLLAR);
    });
  });

  it('a run with no team context is still charged; nothing is written', async () => {
    await withRunSpendLedger(async () => {
      await recordLlmUsage({
        resolved: { provider: 'jev', wireModel: 'jev-latest' },
        callType: 'structured',
        inputTokens: 10,
        outputTokens: 10,
      });
      await recordLlmUsage({
        resolved: { preferred: 'claude-sonnet-5', provider: 'anthropic', wireModel: 'claude-sonnet-5' },
        callType: 'chat',
        inputTokens: 500_000,
        outputTokens: 0,
      });
      expect(segmentSpend()).toBe(DOLLAR);
    });
    expect(insertInto).not.toHaveBeenCalled();
  });
});
