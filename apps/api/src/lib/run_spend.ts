// What one movement RUN has spent on priced work, where it went, and the
// optional cap on it.
//
// The failure this catches is a run that is working, not stuck: a loop, or a
// recursion that keeps finding more to do, each step of it an honest model call
// or paid scrape. Nothing else notices — the run is making progress, and it is
// spending real money to do it. The cap stops it and says so.
//
// ── One entry point for every price ─────────────────────────────────────────
//
// Anything that costs money reports it through `reportRunCost`, with where the
// money went (`CostSource`), and asks `assertRunBudget` before it starts. Model
// calls do it from `recordLlmUsage`, which prices every call from the same
// table its `llm_usage` row is priced from, so "what this run spent on models"
// and the run's usage rows never disagree about a price. A pay-as-you-go
// service reports from its own client (Bright Data's Web Unlocker, in
// `services/scraper.ts`). A plugin or a future external function returns a
// `CostEnvelope` on its result and the engine reports it on its behalf.
//
// This lives in `lib/` rather than beside the engine's call ceiling
// (`run_scope.ts`) because the model and service clients sit below the engine
// and must not depend on it. The engine opens the account (`withRunCallLedger`);
// the clients only report to it and check it.
//
// ── The account belongs to the RUN ──────────────────────────────────────────
//
// Unlike the call ceiling, the account spans the run's segments. A run that
// parks (an `ask`, a timer, an await) and resumes opens a new segment, and the
// segment is seeded with what the run spent before it (`priorMicrodollars`,
// read back off the run's record) — otherwise a run that parks and resumes in a
// loop would never meet the cap. A run dispatched inline by another run is a
// different run: it opens its own account, seeded with its own history (none).
//
// ── Hitting the cap PAUSES the run ──────────────────────────────────────────
//
// The check throws `RunCostCapExceeded`, but inside a movement run the engine
// catches it at the statement that was about to spend and SUSPENDS the run
// there (movement_engine/run.ts, `suspendAtLimit`) rather than failing it: a run
// that met its cap may hold a lot of valuable state. Resuming it (an explicit
// operator action) RESETS its usage — the cap applies afresh from that point,
// which is what `capBaselineMicrodollars` carries: what the run had spent when
// it was last resumed from a limit. Only work done with nowhere durable to
// suspend (a rehearsal with no park sink) still fails on the error.
//
// OPTIONAL, unlike the call ceiling: unset means no cap. When set, it must be
// a positive number of US dollars, and boot refuses anything else.

import { AsyncLocalStorage } from 'node:async_hooks';

import { z } from 'zod';

export const RUN_COST_CAP_ENV_VAR = 'MOVEMENT_MAX_RUN_COST_USD';

/** The cap in microdollars, or undefined for no cap. Throws on a value that is
 *  set but is not a positive number — a typo here must not read as "no cap". */
export function parseRunCostCap(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const dollars = Number(raw.trim());
  if (!Number.isFinite(dollars) || dollars <= 0) {
    throw new Error(
      `${RUN_COST_CAP_ENV_VAR}="${raw}" is not a positive number of US dollars. ` +
        `Set it to the most one movement run may spend on model calls and paid services (e.g. ${RUN_COST_CAP_ENV_VAR}=5), ` +
        'or leave it unset for no cap.',
    );
  }
  return Math.round(dollars * 1_000_000);
}

/** Boot: refuse a cap that is set to nonsense, rather than letting the first
 *  run's first priced call find out. */
export function assertRunCostCapConfigured(env: NodeJS.ProcessEnv = process.env): void {
  parseRunCostCap(env[RUN_COST_CAP_ENV_VAR]);
}

/** Read per check so ops (and tests) can move the cap without a restart. */
function capMicrodollars(): number | undefined {
  return parseRunCostCap(process.env[RUN_COST_CAP_ENV_VAR]);
}

/**
 * Dollars as an author reads them about the cap: cents always, and up to four
 * decimals where the amount has them — a $0.016 cap must not read as $0.02, nor
 * a spend just past it as the same figure as the cap.
 */
export function formatUsd(microdollars: number): string {
  const fixed = (microdollars / 1_000_000).toFixed(4);
  return `$${fixed.replace(/0{1,2}$/, '')}`;
}

/** Thrown at the priced call AFTER the one that took the run to its cap. A
 *  movement run suspends on it (see the header); where the run cannot suspend,
 *  its message is the whole failure surface an author sees, so it says the cap,
 *  the spend, and the knob. */
export class RunCostCapExceeded extends Error {
  constructor(
    readonly capMicrodollars: number,
    /** What the run has spent against the cap: every segment since it was
     *  last resumed from a limit pause (its whole spend if it never was). */
    readonly spentMicrodollars: number,
  ) {
    super(
      `Run cost cap reached: this run has spent ${formatUsd(spentMicrodollars)} on model calls and paid services, ` +
        `and the limit set by ${RUN_COST_CAP_ENV_VAR} is ${formatUsd(capMicrodollars)}. ` +
        'The run was stopped before its next priced call in case something was looping. ' +
        `If this run legitimately needs more, raise ${RUN_COST_CAP_ENV_VAR} in the server's environment ` +
        '(or unset it to remove the cap).',
    );
    this.name = 'RunCostCapExceeded';
  }
}

export function isRunCostCapExceeded(err: unknown): err is RunCostCapExceeded {
  return err instanceof RunCostCapExceeded;
}

// ── Where the money went ────────────────────────────────────────────────────

/**
 * What a charge was for, so an author can see what cost what.
 *
 * - `model`    — a model call; `name` is the model the provider served.
 * - `service`  — a pay-as-you-go third-party API called from inside our own
 *                code (a plugin or an adapter); `name` is `<vendor>.<product>`,
 *                e.g. `brightdata.web_unlocker`.
 * - `plugin`   — a plugin that priced its own invocation (a `CostEnvelope` on
 *                its result); `name` is the plugin.
 * - `function` — an external function (defined by a manifest, run remotely)
 *                that priced its own invocation; `name` is the function.
 * - `adapter`  — an adapter call into a system that bills per call.
 */
export type CostSourceKind = 'model' | 'service' | 'plugin' | 'function' | 'adapter';

export interface CostSource {
  kind: CostSourceKind;
  name: string;
}

export interface RunCostReport {
  source: CostSource;
  /** What it cost, in microdollars (a millionth of a US dollar). */
  microdollars: number;
}

/** The key a source's spend is summed under in a run's breakdown. */
export function costSourceKey(source: CostSource): string {
  return `${source.kind}:${source.name}`;
}

/** What a run has spent, as its record carries it. */
export interface RunSpend {
  /** This segment only — since the run last resumed (or started). */
  segmentMicrodollars: number;
  /** The whole run: every earlier segment plus this one. What the cap reads. */
  runMicrodollars: number;
  /** This segment's spend by `costSourceKey`. Segments add up, so the run's
   *  breakdown is the sum of its segments'. */
  bySource: Record<string, number>;
}

const NOTHING_SPENT: RunSpend = { segmentMicrodollars: 0, runMicrodollars: 0, bySource: {} };

// ── The cost envelope ───────────────────────────────────────────────────────

/**
 * THE shape anything outside the engine uses to say what an invocation cost —
 * a bundled plugin's `TransformOutput.cost` today, and the result an external
 * function returns over its protocol tomorrow. One shape, so the engine prices
 * both the same way. Either:
 *
 *   { "microdollars": 1500 }
 *       — the price, already worked out, in millionths of a US dollar.
 *
 *   { "quantity": 3, "unit": "request", "unitPriceMicrodollars": 1500 }
 *       — usage and the unit price; the engine multiplies. `unit` is for the
 *         reader, never parsed.
 *
 * Both are non-negative and finite; anything else is refused at the boundary
 * (`costEnvelopeMicrodollars`) rather than charged as garbage. A function that
 * spends nothing leaves the envelope off. A function that WILL spend should
 * also declare itself priced (`TransformImpl.priced`, or the same flag on an
 * external function's manifest), so the engine checks the run's budget before
 * invoking it rather than finding out afterwards.
 */
export const CostEnvelopeSchema = z.union([
  // zod 4's number already refuses Infinity and NaN.
  z.strictObject({ microdollars: z.number().nonnegative() }),
  z.strictObject({
    quantity: z.number().nonnegative(),
    unit: z.string().min(1),
    unitPriceMicrodollars: z.number().nonnegative(),
  }),
]);

export type CostEnvelope = z.infer<typeof CostEnvelopeSchema>;

/** What an envelope says it cost, in whole microdollars. Throws on an envelope
 *  that is not one — a function that misreports its price is a broken function,
 *  and charging it nothing would be the silent version of that. */
export function costEnvelopeMicrodollars(envelope: unknown): number {
  const parsed = CostEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new Error(
      `a cost report must be { microdollars } or { quantity, unit, unitPriceMicrodollars }, ` +
        `non-negative and finite; got ${JSON.stringify(envelope)}`,
    );
  }
  const cost = parsed.data;
  return Math.round(
    'microdollars' in cost ? cost.microdollars : cost.quantity * cost.unitPriceMicrodollars,
  );
}

// ── The account ─────────────────────────────────────────────────────────────

class RunSpendLedger {
  // Every member of a MAP, every parallel branch, charges this one object.
  // JavaScript runs each charge to completion, so no two can interleave.
  private segment = 0;
  private readonly bySource = new Map<string, number>();

  constructor(
    private readonly prior: number,
    /** The run's spend when it was last resumed from a limit pause; the cap
     *  counts only what was spent after it. */
    private readonly capBaseline: number,
  ) {}

  charge(report: RunCostReport): void {
    const key = costSourceKey(report.source);
    this.segment += report.microdollars;
    this.bySource.set(key, (this.bySource.get(key) ?? 0) + report.microdollars);
  }

  check(): void {
    const cap = capMicrodollars();
    const sinceReset = this.prior + this.segment - this.capBaseline;
    if (cap !== undefined && sinceReset >= cap) throw new RunCostCapExceeded(cap, sinceReset);
  }

  get spend(): RunSpend {
    return {
      segmentMicrodollars: this.segment,
      runMicrodollars: this.prior + this.segment,
      bySource: Object.fromEntries(this.bySource),
    };
  }
}

const asyncLocalStorage = new AsyncLocalStorage<RunSpendLedger>();

/** Run one interpreter segment under the run's account, seeded with what the
 *  run spent in its earlier segments, and with what it had spent when it was
 *  last resumed from a limit pause (the cap counts from there). */
export function withRunSpendLedger<T>(
  fn: () => Promise<T>,
  options?: { priorMicrodollars?: number; capBaselineMicrodollars?: number },
): Promise<T> {
  return asyncLocalStorage.run(
    new RunSpendLedger(options?.priorMicrodollars ?? 0, options?.capBaselineMicrodollars ?? 0),
    fn,
  );
}

/** Charge priced work to the current run. No-op outside a run. */
export function reportRunCost(report: RunCostReport): void {
  if (!Number.isFinite(report.microdollars) || report.microdollars < 0) {
    throw new Error(
      `${costSourceKey(report.source)} reported a cost of ${report.microdollars} microdollars; a cost is a non-negative number`,
    );
  }
  asyncLocalStorage.getStore()?.charge({ ...report, microdollars: Math.round(report.microdollars) });
}

/** Refuse priced work once the run has spent its cap. Call it BEFORE starting
 *  the work. No-op outside a run, and when no cap is set. */
export function assertRunBudget(): void {
  asyncLocalStorage.getStore()?.check();
}

/** Whether priced work done here is done on a run's behalf. */
export function isInsideRunSpendAccount(): boolean {
  return asyncLocalStorage.getStore() !== undefined;
}

/** What the current run has spent — the run's record, and tests. All zeros
 *  outside a run. */
export function currentRunSpend(): RunSpend {
  return asyncLocalStorage.getStore()?.spend ?? NOTHING_SPENT;
}
