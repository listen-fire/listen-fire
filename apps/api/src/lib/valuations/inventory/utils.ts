import { Holdings } from './holdings';

interface HoldingRow {
  fundId: string;
  fundName: string;
  assetId: string;
  assetName: string;
  assetType: string;
  numAssets: number;
}

/**
 * Every asset sitting against these investments, netting the investment and
 * non-investment buckets together. This is the complete inventory view — the
 * acquisition command walks it to find every asset it has to sweep across, so
 * it must not hide anything.
 */
function transformHoldings(holdings: Holdings): HoldingRow[] {
  return collectHoldings(holdings, ({ sum }) => sum.fromInvestment + sum.fromOtherTransactions);
}

/**
 * The holdings surface a reader sees. Currency that reaches an investment only
 * through the non-investment bucket is dropped — acquisition proceeds stapled
 * onto the acquirer's investment, say. We never put that cash in against this
 * company and it isn't a position we hold on its behalf; listing it reads as a
 * cash balance that doesn't exist. Currency we genuinely invested through still
 * shows, at its investment-side balance only.
 */
function transformHoldingsForDisplay(holdings: Holdings): HoldingRow[] {
  return collectHoldings(holdings, ({ assetType, sum, count }) => {
    if (assetType !== 'CURRENCY') return sum.fromInvestment + sum.fromOtherTransactions;
    return count.fromInvestment === 0 ? null : sum.fromInvestment;
  });
}

/** Returning null from `numAssetsFor` drops the row. */
function collectHoldings(
  holdings: Holdings,
  numAssetsFor: (asset: {
    assetType: string;
    sum: { fromInvestment: number; fromOtherTransactions: number };
    count: { fromInvestment: number; fromOtherTransactions: number };
  }) => number | null,
): HoldingRow[] {
  const result: HoldingRow[] = [];

  holdings.entries().forEach(([investingEntityKey, _, fundData]) => {
    const [fundId, fundName] = investingEntityKey.split(':');

    fundData.entries().forEach(([assetKey, assetData]) => {
      const [assetId, assetName, assetType] = assetKey.split(':');

      const numAssets = numAssetsFor({
        assetType,
        sum: assetData.sum(),
        count: assetData.count(),
      });
      if (numAssets === null) return;

      result.push({ fundId, fundName, assetId, assetName, assetType, numAssets });
    });
  });

  return result;
}

// Helper to round numbers to avoid floating point issues
function round(num: number): number {
  return Math.round(num * 1e6) / 1e6;
}

export { transformHoldings, transformHoldingsForDisplay, round };
export type { HoldingRow };
