import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';

interface AssetPrice {
  price: number;
  currency: CurrencyIsoCode;
  date: Date;
}

/**
 * The tense rule, fixed and never configurable: cash is a fact, converted at the
 * rate on the day it moved and never moved again; a position we still hold is
 * live, marked at the latest price on or before the analysis date and that
 * date's rate. No figure below mixes the two except the two legacy single-basis
 * views, which exist only for FX attribution and say so.
 */
interface InvestmentValuation {
  targetCurrency: string;
  // Held positions that still track the company we invested into — DIRECT
  // retained. The `unrealized*` naming is what the cache and the REST v1
  // resource have always called it.
  unrealizedTransactionDateValue: number;
  unrealizedValuationDateValue: number;
  // Every position we still hold that traces back to this investment, tracking
  // the investee or not — FULL retained, live. Direct retained plus the
  // acquirer roll-up (shares taken in a swap are still ours and still move, so
  // they float here rather than being frozen into realised).
  retainedValue: number;
  // All cash returned to us, each flow at the rate it arrived at — FULL
  // realised, and the realised figure every surface reports.
  realizedCashTransactionDateValue: number;
  // Cash that came straight out of the company we invested into rather than out
  // of something it turned into — DIRECT realised, pinned the same way. Both
  // paths carry a causal degree now (the cache stores degree-bucketed lots), so
  // this is never unknown.
  realisedDirectValue: number;
  // Single-FX-basis views of cash proceeds and the still-held roll-up together:
  // both legs at each flow's own rate, and both legs at the valuation date's
  // rate respectively. Mixed-tense by construction — they exist for FX-movement
  // attribution and the debug trace, and are nobody's headline.
  realizedTransactionDateValue: number;
  realizedValuationDateValue: number;
  totalTransactionDateValue: number;
  // Full retained + full realised. The headline total and the MOIC numerator.
  totalValuationDateValue: number;
  investedTransactionDateValue: number | null;
  investedValuationDateValue: number | null;
  // True iff we currently hold at least one non-cash asset (excluding the
  // quasi-cash FUND_OUTSTANDING_COMMITMENT liability) with a positive balance
  // that still tracks the investee — "is anything still in the company itself?".
  // Independent of marked value; kept for the trace and the cache column.
  holdsTrackingAssets: boolean;
  // The same question widened to everything the investment turned into: do we
  // hold ANY positive-balance non-cash asset, tracking or not? "Is anything
  // left to come?" — the predicate the Status column is derived from.
  holdsRetainedAssets: boolean;
}

interface ValueInTargetCurrency {
  transactionDateValue: number;
  valuationDateValue: number;
}

export { AssetPrice, InvestmentValuation, ValueInTargetCurrency };
