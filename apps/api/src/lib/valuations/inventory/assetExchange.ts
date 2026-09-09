import { handleError } from '../../errors';
import { AssetHolding, InvesteeHoldings } from './holdings';
import { TransactionFlow } from './transactionFlows';
import { AssetKey, getAssetKey } from './types';
import { round } from './utils';

// When outflows contain multiple asset types, some may carry zero value
// (e.g. EQUITY_UNKNOWN_SHARES) and can be excluded to resolve the ambiguity
function getZeroValueAssetTypes(outflows: TransactionFlow['outflows']): Set<string> {
  const nonCurrencyTypes = [
    ...new Set(outflows.filter((f) => f.assetType !== 'CURRENCY').map((f) => f.assetType)),
  ];

  if (nonCurrencyTypes.length <= 1) return new Set();

  const zeroValueTypes = nonCurrencyTypes.filter((t) => t === 'EQUITY_UNKNOWN_SHARES');
  const remainingTypes = nonCurrencyTypes.filter((t) => t !== 'EQUITY_UNKNOWN_SHARES');

  if (zeroValueTypes.length > 0 && remainingTypes.length <= 1) {
    return new Set(zeroValueTypes);
  }

  return new Set();
}

// Given a new transaction flow where existing assets are exchanged, calculate
// the proportion of the transaction that is due to the investments we're valuing
function getAssetExchangeProportion({
  transactionFlow,
  assetHoldings,
  strategy = 'FIFO', // LIFO is not permitted by IFRS, so use FIFO by default
  excludeAssetTypes = new Set<string>(),
}: {
  transactionFlow: TransactionFlow;
  assetHoldings: InvesteeHoldings;
  strategy: 'LIFO' | 'FIFO';
  excludeAssetTypes?: Set<string>;
}) {
  // This can be partial: need to use the outflow proportions to split the inflow

  // Calculate proportions for any exchanges
  const outflowProportions = new Map<AssetKey, { fromInvestment: number; fromOther: number }>();

  // Process outflows first to get accurate proportions
  for (const { assetId, assetName, assetType, numAssets } of transactionFlow.outflows) {
    const assetKey = getAssetKey({
      assetId,
      assetName,
      assetType,
    });
    // We don't want to keep track of our cash holdings - just the total expended and realised
    if (assetType === 'CURRENCY') {
      continue;
    }

    const assetHolding = assetHoldings.get(assetKey);

    // Process the outflow - THIS ADDS THE OUTFLOWS TO holdings
    const { fromInvestment: investmentRemoved, fromOtherTransactions: otherRemoved } =
      processOutflow(assetHolding, numAssets, strategy);

    // Calculate how much was actually taken from each source
    const totalRemoved = investmentRemoved + otherRemoved;

    if (!totalRemoved) {
      handleError(new Error(`Outflow for asset with no existing holding: ${assetId}`));
    }

    outflowProportions.set(assetKey, {
      fromInvestment: investmentRemoved / totalRemoved,
      fromOther: otherRemoved / totalRemoved,
    });
  }

  // Currency outflows are not weighted against other assets here: they're treated
  // as accompanying the exchange (e.g. cash paid in on a convertible-to-equity
  // exchange, or a nominal paid on acquisition). The computed proportion is
  // still applied to them in proportionallyAdd, so they land as additional
  // invested amount on the cash holding.
  const includedOutflows = transactionFlow.outflows.filter(
    (outflow) =>
      !excludeAssetTypes.has(outflow.assetType) && outflow.assetType !== 'CURRENCY',
  );

  const totalOutflowValues = includedOutflows.reduce(
    (sum, outflow) => {
      const proportion = outflowProportions.get(getAssetKey(outflow));

      if (!sum[getAssetKey(outflow)]) {
        sum[getAssetKey(outflow)] = 0;
      }

      return proportion
        ? { ...sum, [getAssetKey(outflow)]: sum[getAssetKey(outflow)] + outflow.numAssets }
        : sum;
    },
    {} as Record<AssetKey, number>,
  );

  // TODO: this proportion should really be normalised by value rather than number of assets
  // then we'll be able to handle multiple asset types in outflow (e.g. equity and SPV)
  let investmentProportion = 0;
  if (totalOutflowValues) {
    const assetTypes = [...new Set(Object.keys(totalOutflowValues).map((key) => key.split(':')[2]))];

    if (assetTypes.length > 1) {
      handleError(new Error(`Multiple asset types in outflow: ${Object.keys(totalOutflowValues)}`));
    }

    const totalOutflow = Object.values(totalOutflowValues).reduce((sum, value) => sum + value, 0);
    investmentProportion = totalOutflow
      ? includedOutflows.reduce((sum, outflow) => {
          const proportion = outflowProportions.get(getAssetKey(outflow));
          return proportion
            ? sum + (outflow.numAssets / totalOutflow) * proportion.fromInvestment
            : sum;
        }, 0)
      : 0;
  }

  return investmentProportion;
}

// Uses the specified strategy (LIFO or FIFO) to determine which assets to remove first
// It records the removal as new records of negative asset flow
function processOutflow(
  holding: AssetHolding,
  numAssetsToRemove: number,
  strategy: 'LIFO' | 'FIFO',
): { fromInvestment: number; fromOtherTransactions: number } {
  // Combine all inflow records but track their source
  const allFlows = holding.toFlat();

  if (allFlows.length === 0) {
    return { fromInvestment: 0, fromOtherTransactions: 0 };
  }

  // Sort all flows based on strategy
  allFlows.sort((a, b) => {
    const dateComparison = a.date.getTime() - b.date.getTime();
    return strategy === 'LIFO' ? -dateComparison : dateComparison;
  });

  let remainingToRemove = numAssetsToRemove;

  const output = {
    fromInvestment: 0,
    fromOtherTransactions: 0,
  };

  // Process flows in order and create outflow records
  for (let i = 0; i < allFlows.length && remainingToRemove > 0; i++) {
    const flow = allFlows[i];
    const assetsToRemove = round(Math.min(flow.numAssets, remainingToRemove));
    remainingToRemove = round(remainingToRemove - assetsToRemove);

    output[flow.source === 'investment' ? 'fromInvestment' : 'fromOtherTransactions'] +=
      assetsToRemove;
  }

  return output;
}

export { getAssetExchangeProportion, getZeroValueAssetTypes };
