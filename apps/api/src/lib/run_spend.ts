// What one movement run SEGMENT has spent on priced calls, and the optional
// cap on it.
//
// The failure this catches is a run that is working, not stuck: a loop, or a
// recursion that keeps finding more to do, each step of it an honest model call.
// Nothing else notices — the run is making progress, and it is spending real
// money to do it. The cap stops it and says so.
//
// The account is kept where the money is counted: `recordLlmUsage` prices
// every model call (`calculateCostMicrodollars`, keyed on who served it), and
// the same number is charged here. So "what this run spent" and the run's
// `llm_usage` rows can never disagree about a price.
//
// This lives in `lib/` rather than beside the engine's call ceiling
// (`run_scope.ts`) because the model clients sit below the engine and must not
// depend on it. The engine opens the account (`withRunCallLedger`); the model
// clients only charge it and check it.
//
// One segment, one account — the same rule as the call ceiling. A run that
// parks on an `ask` and resumes hours later starts afresh: a spiral happens
// inside one segment, and a human answering an ask is not one.
//
// OPTIONAL, unlike the call ceiling: unset means no cap. When set, it must be
// a positive number of US dollars, and boot refuses anything else.

import { AsyncLocalStorage } from 'node:async_hooks';

export const RUN_COST_CAP_ENV_VAR = 'MOVEMENT_MAX_RUN_COST_USD';

/** The cap in microdollars, or undefined for no cap. Throws on a value that is
 *  set but is not a positive number — a typo here must not read as "no cap". */
export function parseRunCostCap(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const dollars = Number(raw.trim());
  if (!Number.isFinite(dollars) || dollars <= 0) {
    throw new Error(
      `${RUN_COST_CAP_ENV_VAR}="${raw}" is not a positive number of US dollars. ` +
        `Set it to the most one movement run may spend on model calls (e.g. ${RUN_COST_CAP_ENV_VAR}=5), ` +
        'or leave it unset for no cap.',
    );
  }
  return Math.round(dollars * 1_000_000);
}

/** Boot: refuse a cap that is set to nonsense, rather than letting the first
 *  run's first model call find out. */
export function assertRunCostCapConfigured(env: NodeJS.ProcessEnv = process.env): void {
  parseRunCostCap(env[RUN_COST_CAP_ENV_VAR]);
}

/** Read per check so ops (and tests) can move the cap without a restart. */
function capMicrodollars(): number | undefined {
  return parseRunCostCap(process.env[RUN_COST_CAP_ENV_VAR]);
}

function usd(microdollars: number): string {
  const dollars = microdollars / 1_000_000;
  return `$${dollars.toFixed(dollars < 1 ? 4 : 2)}`;
}

/** Thrown at the priced call AFTER the one that took the run to its cap. Its
 *  message is the whole failure surface an author sees (it lands verbatim in
 *  the run's failure reason), so it says the cap, the spend, and the knob. */
export class RunCostCapExceeded extends Error {
  constructor(
    readonly capMicrodollars: number,
    readonly spentMicrodollars: number,
  ) {
    super(
      `Run cost cap reached: this run has spent ${usd(spentMicrodollars)} on model calls, ` +
        `and the limit set by ${RUN_COST_CAP_ENV_VAR} is ${usd(capMicrodollars)}. ` +
        'The run was stopped before its next model call in case something was looping. ' +
        `If this run legitimately needs more, raise ${RUN_COST_CAP_ENV_VAR} in the server's environment ` +
        '(or unset it to remove the cap).',
    );
    this.name = 'RunCostCapExceeded';
  }
}

export function isRunCostCapExceeded(err: unknown): err is RunCostCapExceeded {
  return err instanceof RunCostCapExceeded;
}

class RunSpendLedger {
  // Every member of a MAP, every parallel branch, charges this one object.
  // JavaScript runs each charge to completion, so no two can interleave.
  private spent = 0;

  charge(microdollars: number): void {
    this.spent += microdollars;
  }

  check(): void {
    const cap = capMicrodollars();
    if (cap !== undefined && this.spent >= cap) throw new RunCostCapExceeded(cap, this.spent);
  }

  get spentMicrodollars(): number {
    return this.spent;
  }
}

const asyncLocalStorage = new AsyncLocalStorage<RunSpendLedger>();

/** Run one interpreter segment under its own fresh account. */
export function withRunSpendLedger<T>(fn: () => Promise<T>): Promise<T> {
  return asyncLocalStorage.run(new RunSpendLedger(), fn);
}

/** Charge a priced call to the current run. No-op outside a run. */
export function chargeRunSpend(microdollars: number): void {
  asyncLocalStorage.getStore()?.charge(microdollars);
}

/** Refuse the next priced call once the run has spent its cap. No-op outside a
 *  run, and when no cap is set. */
export function assertRunSpendWithinCap(): void {
  asyncLocalStorage.getStore()?.check();
}

/** Whether a priced call made here is made on a run's behalf. */
export function isInsideRunSpendAccount(): boolean {
  return asyncLocalStorage.getStore() !== undefined;
}

/** What the current run has spent so far — the run's record, and tests. */
export function currentRunSpendMicrodollars(): number {
  return asyncLocalStorage.getStore()?.spentMicrodollars ?? 0;
}
