import { formatDate } from 'date-fns';

import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import { InvestingEntityKey } from '../inventory/types';
import { MessageCollector } from '../messages';
import { getExchangeRate, getLatestPrices } from './data';
import { ValueInTargetCurrency } from './types';
import { handleError } from '../../errors';
import { Holdings } from '../inventory/holdings';

/**
 * Values held (non-cash) positions and splits them by whether the asset still
 * tracks the underlying value of the company we invested in:
 *
 *   - `unrealised` — assets that still track the investee (equity in it, an SPV
 *     over it, …). Direct retained value.
 *   - `nonTracking` — assets that no longer track the investee (an acquirer's
 *     shares taken in a share-for-share deal, say). Still ours and still
 *     floating, so still retained — the two together are the full retained
 *     value. The split is what tells "in the company itself" from "in whatever
 *     it became".
 *
 * Both legs are live: latest price on or before the analysis date, at the FX
 * date's rate.
 */
async function getUnrealisedValue({
  holdings,
  trackedEntities,
  targetCurrency,
  fxDate,
  asOfDate,
  messageCollector,
}: {
  holdings: Holdings;
  /** Which entities each held asset still tracks (issuer, SPV underlying, …). */
  trackedEntities: Map<string, Set<string>>;
  targetCurrency: CurrencyIsoCode;
  fxDate: Date;
  asOfDate: Date;
  messageCollector?: MessageCollector;
}): Promise<{
  unrealised: Record<InvestingEntityKey, ValueInTargetCurrency>;
  nonTracking: Record<InvestingEntityKey, ValueInTargetCurrency>;
  holdsTrackingAssets: boolean;
  holdsRetainedAssets: boolean;
}> {
  const collector = messageCollector?.subCollector();
  // Get all unique asset IDs
  const assetIds = new Set<string>();
  const assetIdNameMap = new Map<string, string>();
  for (const investeeHoldings of holdings.values()) {
    for (const assetKey of investeeHoldings.keys()) {
      const [assetId, assetName, assetType] = assetKey.split(':');
      if (assetType === 'CURRENCY') {
        continue;
      }
      assetIds.add(assetId);
      assetIdNameMap.set(assetId, assetName);
    }
  }

  // Get latest prices for all assets
  const prices = await getLatestPrices({
    assetIds: Array.from(assetIds),
    date: asOfDate,
  });

  collector?.header('Prices');
  collector?.table(
    ['Asset', 'Date', 'Price', 'Currency'],
    Object.entries(prices).map(([assetId, price]) => [
      assetIdNameMap.get(assetId) ?? assetId,
      formatDate(price.date, 'yyyy-MM-dd'),
      price.price.toFixed(6),
      price.currency,
    ]),
  );

  // Calculate unrealized value by entity
  const result: Record<InvestingEntityKey, ValueInTargetCurrency> = {};
  const nonTracking: Record<InvestingEntityKey, ValueInTargetCurrency> = {};
  const totalRecord: [string, string, string][] = [];

  // Do we still hold anything at all, and anything that tracks the investee?
  // Both count only held, positive-balance, non-cash (and non-commitment)
  // assets, and both are independent of the marked value computed below — an
  // unpriced holding is still a holding.
  let holdsTrackingAssets = false;
  let holdsRetainedAssets = false;

  for (const [entityKey, investeeKey, entityHoldings] of holdings.entries()) {
    result[entityKey] = result[entityKey] || {
      transactionDateValue: 0,
      valuationDateValue: 0,
    };
    nonTracking[entityKey] = nonTracking[entityKey] || {
      transactionDateValue: 0,
      valuationDateValue: 0,
    };
    const investeeId = investeeKey.split(':')[0];
    const fxHeader = [
      'Date',
      'Asset',
      'Number of Assets',
      'Price',
      'Tracks Investee',
      'FX Rate @ Date',
      'FX Rate "Now"',
      'Value (FX applied @ Date)',
      'Value (FX applied "Now")',
    ];
    const fxRecord = [];

    let transactionDateValue = 0;
    let valuationDateValue = 0;
    let nonTrackingTransactionDateValue = 0;
    let nonTrackingValuationDateValue = 0;

    for (const [assetKey, holding] of entityHoldings.entries()) {
      const assetType = assetKey.split(':')[2];
      const price = prices[assetKey.split(':')[0]];
      if (!price) {
        if (assetType !== 'CURRENCY') {
          handleError(`No price found for asset ${assetKey}`);
        }

        continue;
      }

      // FUND_OUTSTANDING_COMMITMENT is a special case
      // where it's a liability (negative) that counts positively towards the unrealised value
      const modifier = assetType === 'FUND_OUTSTANDING_COMMITMENT' ? -1 : 1;

      // Does this held asset still track the company we invested in? If not it
      // is a claim on something else — retained all the same, but on the far
      // side of the split.
      const tracksInvestee = trackedEntities.get(assetKey.split(':')[0])?.has(investeeId) ?? false;

      // A held asset counts as a holding only if it's a real one: not cash, not
      // the quasi-cash commitment liability, and net positive.
      const isHeldNonCash =
        assetType !== 'CURRENCY' && assetType !== 'FUND_OUTSTANDING_COMMITMENT';
      const netBalance = holding.data.fromInvestment.reduce(
        (acc, flow) => acc + flow.numAssets,
        0,
      );
      if (isHeldNonCash && netBalance > 0) {
        holdsRetainedAssets = true;
        if (tracksInvestee) holdsTrackingAssets = true;
      }

      // Calculate value for investment flows
      for (const flow of holding.data.fromInvestment) {
        const value = flow.numAssets * price.price * modifier;

        // Convert using transaction date FX
        const transactionFx = await getExchangeRate({
          fromCurrency: price.currency,
          toCurrency: targetCurrency,
          date: flow.date,
        });
        // Convert using valuation date FX
        const valuationFx = await getExchangeRate({
          fromCurrency: price.currency,
          toCurrency: targetCurrency,
          date: fxDate,
        });

        if (tracksInvestee) {
          transactionDateValue += value * transactionFx;
          valuationDateValue += value * valuationFx;
        } else {
          nonTrackingTransactionDateValue += value * transactionFx;
          nonTrackingValuationDateValue += value * valuationFx;
        }

        fxRecord.push([
          formatDate(flow.date, 'yyyy-MM-dd'),
          assetKey.split(':')[1],
          flow.numAssets,
          `${price.price.toFixed(6)} ${price.currency}`,
          tracksInvestee ? 'yes' : 'no',
          transactionFx.toFixed(6),
          valuationFx.toFixed(6),
          (value * transactionFx).toFixed(2),
          (value * valuationFx).toFixed(2),
        ]);
      }
    }

    if (transactionDateValue !== 0 || valuationDateValue !== 0) {
      result[entityKey].transactionDateValue += transactionDateValue;
      result[entityKey].valuationDateValue += valuationDateValue;
    }
    if (nonTrackingTransactionDateValue !== 0 || nonTrackingValuationDateValue !== 0) {
      nonTracking[entityKey].transactionDateValue += nonTrackingTransactionDateValue;
      nonTracking[entityKey].valuationDateValue += nonTrackingValuationDateValue;
    }

    collector?.header(`Value Calculations for ${entityKey.split(':')[1]} (to ${targetCurrency})`);
    collector?.text(
      'Σ(unrealized values of each asset), converted to target currency on the transaction date and valuation date',
    );
    collector?.table(fxHeader, fxRecord);

    totalRecord.push([
      entityKey.split(':')[1],
      transactionDateValue.toFixed(2),
      valuationDateValue.toFixed(2),
    ]);
  }

  collector?.header(`Unrealized Value`);
  collector?.text('Σ(unrealized values for each entity)');
  collector?.table(
    ['Entity', 'Value (FX applied @ Date)', 'Value (FX applied "Now")'],
    totalRecord,
  );

  collector?.commit();

  return { unrealised: result, nonTracking, holdsTrackingAssets, holdsRetainedAssets };
}

export { getUnrealisedValue };
