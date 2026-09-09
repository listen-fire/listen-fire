import { rollUpHoldings } from '../inventory';
import { toLots } from '../inventory/lots';
import { InvestingEntityKey } from '../inventory/types';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import { MessageCollector } from '../messages';
import { getAssetTrackedEntities } from '../trackedEntities';
import { InvestmentValuation } from './types';
import { getUnrealisedValue } from './unrealised';
import { getRealisedValue } from './realised';
import { logValuationInput, logValuationOutput } from './messages';
import { getCachedInvestmentsValuation, sumValuations } from '../cache';

async function getInvestmentsValuation({
  investments,
  asOfDate,
  fxDate,
  strategy = 'FIFO',
  targetCurrency,
  messageCollector,
  useHoldingsCache = false,
}: {
  investments: { id: string; date: Date | null }[];
  asOfDate: Date;
  fxDate: Date;
  strategy?: 'LIFO' | 'FIFO';
  targetCurrency: CurrencyIsoCode;
  messageCollector?: MessageCollector;
  useHoldingsCache?: boolean;
}): Promise<InvestmentValuation> {
  if (useHoldingsCache) {
    return getInvestmentsValuationViaCache({
      investments,
      asOfDate,
      fxDate,
      strategy,
      targetCurrency,
      messageCollector,
    });
  }

  logValuationInput({
    investments,
    asOfDate,
    strategy,
    targetCurrency,
    messageCollector,
  });

  // Get current holdings from inventory
  const { holdings, classifiedTransactionFlows } = await rollUpHoldings({
    investmentIds: investments.map((investment) => investment.id),
    asOfDate,
    strategy,
    messageCollector,
  });

  const includesNonCashInvestment = classifiedTransactionFlows.some(
    (flow) => flow.classification === 'NON_CASH_INVESTMENT',
  );

  // One resolution of what each held asset tracks, shared by the retained split
  // and the lots' causal degrees — the two are the same graph fact asked twice.
  const assetIds = new Set<string>();
  for (const investeeHoldings of holdings.values()) {
    for (const assetKey of investeeHoldings.keys()) assetIds.add(assetKey.split(':')[0]);
  }
  const trackedEntities = await getAssetTrackedEntities(Array.from(assetIds));
  const lots = toLots({ holdings, trackedEntities });

  // Calculate retained and realised values
  const [
    { unrealised: unrealizedValues, nonTracking, holdsTrackingAssets, holdsRetainedAssets },
    realizedValues,
  ] = await Promise.all([
      getUnrealisedValue({
        holdings,
        trackedEntities,
        targetCurrency,
        fxDate,
        asOfDate,
        messageCollector,
      }),
      getRealisedValue({
        lots,
        fxDate,
        asOfDate,
        targetCurrency,
        messageCollector,
      }),
    ]);

  // Calculate totals
  const entityKeys = new Set([
    ...(Object.keys(unrealizedValues) as InvestingEntityKey[]),
    ...(Object.keys(realizedValues) as InvestingEntityKey[]),
    ...(Object.keys(nonTracking) as InvestingEntityKey[]),
  ]);

  const zero = { transactionDateValue: 0, valuationDateValue: 0 };

  const investmentValuesByEntity = Array.from(entityKeys).map((investingEntityKey) => {
    // Direct retained: what we still hold in the company itself.
    const unrealized = unrealizedValues[investingEntityKey] || zero;
    // The rest of what we still hold — an acquirer's stock, say. Still ours,
    // still floating, so retained alongside the direct leg rather than frozen
    // into realised.
    const nonTrackingRetained = nonTracking[investingEntityKey] || zero;
    const retainedValue = unrealized.valuationDateValue + nonTrackingRetained.valuationDateValue;

    // Realised is cash and nothing else, each flow at the rate it arrived at.
    const cashRealized = realizedValues[investingEntityKey]?.amountRealised || zero;
    const cashRealizedDirect = realizedValues[investingEntityKey]?.amountRealisedDirect || zero;

    // The two legacy single-basis views: cash and the still-held roll-up on one
    // FX basis each, for FX-movement attribution only.
    const realized = {
      transactionDateValue:
        cashRealized.transactionDateValue + nonTrackingRetained.transactionDateValue,
      valuationDateValue: cashRealized.valuationDateValue + nonTrackingRetained.valuationDateValue,
    };
    const invested = realizedValues[investingEntityKey]?.amountInvested || zero;

    return {
      investingEntityKey,
      unrealizedTransactionDateValue: unrealized.transactionDateValue,
      unrealizedValuationDateValue: unrealized.valuationDateValue,
      retainedValue,
      retainedNonTrackingValue: nonTrackingRetained.valuationDateValue,
      realizedTransactionDateValue: realized.transactionDateValue,
      realizedValuationDateValue: realized.valuationDateValue,
      realizedCashTransactionDateValue: cashRealized.transactionDateValue,
      realisedDirectValue: cashRealizedDirect.transactionDateValue,
      totalTransactionDateValue: unrealized.transactionDateValue + realized.transactionDateValue,
      totalValuationDateValue: retainedValue + cashRealized.transactionDateValue,
      investedTransactionDateValue: includesNonCashInvestment
        ? null
        : invested.transactionDateValue,
      investedValuationDateValue: includesNonCashInvestment ? null : invested.valuationDateValue,
    };
  });

  logValuationOutput({
    messageCollector,
    investmentValuesByEntity,
  });

  const unrealizedTransactionDateValue = investmentValuesByEntity.reduce(
    (sum, val) => sum + val.unrealizedTransactionDateValue,
    0,
  );
  const realizedTransactionDateValue = investmentValuesByEntity.reduce(
    (sum, val) => sum + val.realizedTransactionDateValue,
    0,
  );
  const realizedCashTransactionDateValue = investmentValuesByEntity.reduce(
    (sum, val) => sum + val.realizedCashTransactionDateValue,
    0,
  );
  const totalTransactionDateValue = unrealizedTransactionDateValue + realizedTransactionDateValue;
  const unrealizedValuationDateValue = investmentValuesByEntity.reduce(
    (sum, val) => sum + val.unrealizedValuationDateValue,
    0,
  );

  const realizedValuationDateValue = investmentValuesByEntity.reduce(
    (sum, val) => sum + val.realizedValuationDateValue,
    0,
  );
  const retainedValue = investmentValuesByEntity.reduce((sum, val) => sum + val.retainedValue, 0);
  const realisedDirectValue = investmentValuesByEntity.reduce(
    (sum, val) => sum + val.realisedDirectValue,
    0,
  );
  const totalValuationDateValue = retainedValue + realizedCashTransactionDateValue;

  const investedTransactionDateValue = investmentValuesByEntity.reduce<number | null>(
    (sum, val) =>
      val.investedTransactionDateValue === null || sum === null
        ? null
        : sum + val.investedTransactionDateValue,
    0,
  );
  const investedValuationDateValue = investmentValuesByEntity.reduce<number | null>(
    (sum, val) =>
      val.investedValuationDateValue === null || sum === null
        ? null
        : sum + val.investedValuationDateValue,
    0,
  );

  return {
    targetCurrency,
    unrealizedTransactionDateValue,
    unrealizedValuationDateValue,
    retainedValue,
    realizedCashTransactionDateValue,
    realisedDirectValue,
    realizedTransactionDateValue,
    realizedValuationDateValue,
    totalTransactionDateValue,
    totalValuationDateValue,
    investedTransactionDateValue,
    investedValuationDateValue,
    holdsTrackingAssets,
    holdsRetainedAssets,
  };
}

async function getInvestmentsValuationViaCache({
  investments,
  asOfDate,
  fxDate,
  strategy,
  targetCurrency,
  messageCollector,
}: {
  investments: { id: string; date: Date | null }[];
  asOfDate: Date;
  fxDate: Date;
  strategy: 'LIFO' | 'FIFO';
  targetCurrency: CurrencyIsoCode;
  messageCollector?: MessageCollector;
}): Promise<InvestmentValuation> {
  const investmentIds = investments.map((i) => i.id);
  const cache = await getCachedInvestmentsValuation({
    investmentIds,
    asOfDate,
    fxDate,
    targetCurrency,
  });

  const needsFallback = new Set<string>([
    ...cache.investmentsMissingFx,
    ...cache.investmentsWithoutCache,
  ]);

  const cachedTotals = sumValuations(
    investmentIds
      .filter((id) => !needsFallback.has(id))
      .map((id) => cache.perInvestment[id])
      .filter((v): v is InvestmentValuation => v !== undefined),
    targetCurrency,
  );

  if (needsFallback.size === 0) return cachedTotals;

  const fallbackInvestments = investments.filter((inv) => needsFallback.has(inv.id));
  const fallbackTotals = await getInvestmentsValuation({
    investments: fallbackInvestments,
    asOfDate,
    fxDate,
    strategy,
    targetCurrency,
    messageCollector,
  });

  return sumValuations([cachedTotals, fallbackTotals], targetCurrency);
}

export { getInvestmentsValuation };
