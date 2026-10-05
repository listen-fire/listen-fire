// The optional per-run cost cap: what it reads, what a run is charged, and
// when the next priced call is refused.

jest.mock('../../services/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const insertInto = jest.fn();
jest.mock('../kysely', () => ({ getQb: () => ({ insertInto }) }));

import { LlmUsageContext, recordLlmUsage } from '../llm_usage';
import {
  assertRunCostCapConfigured,
  assertRunSpendWithinCap,
  chargeRunSpend,
  currentRunSpendMicrodollars,
  isRunCostCapExceeded,
  parseRunCostCap,
  RUN_COST_CAP_ENV_VAR,
  RunCostCapExceeded,
  withRunSpendLedger,
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
        assertRunSpendWithinCap();
        chargeRunSpend(DOLLAR);
      }
      expect(currentRunSpendMicrodollars()).toBe(100 * DOLLAR);
    });
  });
});

describe('with a cap set', () => {
  beforeEach(() => {
    process.env[ENV_VAR] = '2.5';
  });

  it('the call that crosses the cap goes through; the NEXT priced call is refused', async () => {
    await withRunSpendLedger(async () => {
      assertRunSpendWithinCap();
      chargeRunSpend(2 * DOLLAR);
      assertRunSpendWithinCap();
      chargeRunSpend(1 * DOLLAR); // over now
      const err = caught(assertRunSpendWithinCap);
      expect(isRunCostCapExceeded(err)).toBe(true);
      expect(err).toBeInstanceOf(RunCostCapExceeded);
      expect((err as RunCostCapExceeded).capMicrodollars).toBe(2.5 * DOLLAR);
      expect((err as RunCostCapExceeded).spentMicrodollars).toBe(3 * DOLLAR);
    });
  });

  it("its message is the author's whole failure surface: the cap, the spend, the knob, how to raise it", async () => {
    await withRunSpendLedger(async () => {
      chargeRunSpend(3 * DOLLAR);
      expect(() => assertRunSpendWithinCap()).toThrow(
        'Run cost cap reached: this run has spent $3.00 on model calls, ' +
          'and the limit set by MOVEMENT_MAX_RUN_COST_USD is $2.50. ' +
          'The run was stopped before its next model call in case something was looping. ' +
          "If this run legitimately needs more, raise MOVEMENT_MAX_RUN_COST_USD in the server's environment " +
          '(or unset it to remove the cap).',
      );
    });
  });

  it('each run segment has its own account', async () => {
    await withRunSpendLedger(async () => chargeRunSpend(3 * DOLLAR));
    await withRunSpendLedger(async () => {
      expect(currentRunSpendMicrodollars()).toBe(0);
      expect(() => assertRunSpendWithinCap()).not.toThrow();
    });
  });

  it('outside a run nothing is charged and nothing is refused', () => {
    chargeRunSpend(100 * DOLLAR);
    expect(currentRunSpendMicrodollars()).toBe(0);
    expect(() => assertRunSpendWithinCap()).not.toThrow();
  });

  it('concurrent members charge the one account, and none of it is lost', async () => {
    await withRunSpendLedger(async () => {
      await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          await new Promise((resolve) => setTimeout(resolve, (i * 7) % 5));
          chargeRunSpend(100_000);
        }),
      );
      expect(currentRunSpendMicrodollars()).toBe(2 * DOLLAR);
      expect(() => assertRunSpendWithinCap()).not.toThrow();
      chargeRunSpend(500_000);
      expect(() => assertRunSpendWithinCap()).toThrow(RunCostCapExceeded);
    });
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
      // $2/M in + $10/M out.
      expect(currentRunSpendMicrodollars()).toBe(3 * DOLLAR);
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
      expect(currentRunSpendMicrodollars()).toBe(2 * DOLLAR);
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
      expect(currentRunSpendMicrodollars()).toBe(DOLLAR);
    });
    expect(insertInto).not.toHaveBeenCalled();
  });
});
