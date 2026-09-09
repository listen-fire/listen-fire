import { formatDate } from 'date-fns';

import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import { MessageCollector } from '../messages';
import { InvestingEntityKey } from '../inventory/types';
import { Lot } from '../inventory/lots';
import { ValueInTargetCurrency } from './types';
import { getCurrencyAsset, getExchangeRate, getLatestPrices } from './data';
import { handleError } from '../../errors';

interface RealisedForEntity {
  amountRealised: ValueInTargetCurrency;
  /** The share of `amountRealised` paid by the company we invested into rather
   *  than by something it turned into. */
  amountRealisedDirect: ValueInTargetCurrency;
  amountInvested: ValueInTargetCurrency;
}

async function getRealisedValue({
  lots,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  asOfDate, // this should be effectively applied through the holdings
  fxDate,
  targetCurrency,
  messageCollector,
}: {
  lots: Lot[];
  asOfDate: Date;
  fxDate: Date;
  targetCurrency: CurrencyIsoCode;
  messageCollector?: MessageCollector;
}): Promise<Record<InvestingEntityKey, RealisedForEntity>> {
  // Cash and the quasi-cash commitment liability, read off the roll-up's leaves.
  // A lot is one attributed flow — the same flows this used to walk holdings
  // for, split where the walk attributed one payment across predecessors of
  // different causal degrees, which is what makes "paid by the company itself"
  // separable from "paid by its acquirer".
  const currencyFlows = lots.flatMap((lot) => {
    if (lot.source !== 'INVESTMENT') return [];
    const [assetId, assetName, assetType] = lot.assetKey.split(':');
    if (assetType !== 'CURRENCY' && assetType !== 'FUND_OUTSTANDING_COMMITMENT') return [];
    return [
      {
        assetId,
        assetName,
        assetType,
        numAssets: lot.numAssets,
        date: lot.date,
        degree: lot.degree,
        investingEntityKey: lot.investingEntityKey,
      },
    ];
  });

  const collector = messageCollector?.subCollector();
  collector?.header('Cashflows');
  collector?.table(
    ['Date', 'Asset', 'Number of Assets', 'Type'],
    currencyFlows.map((flow) => [
      formatDate(flow.date, 'yyyy-MM-dd'),
      flow.assetName,
      flow.numAssets,
      flow.numAssets > 0 ? 'DISTRIBUTION' : 'INVESTMENT',
    ]),
  );

  const result: Record<InvestingEntityKey, RealisedForEntity> = {};

  // Process each transfer and convert to target currency
  for (const flow of currencyFlows) {
    let transactionDateValue = 0;
    let valuationDateValue = 0;
    if (flow.assetType === 'FUND_OUTSTANDING_COMMITMENT') {
      // Get latest prices for all assets
      const prices = await getLatestPrices({
        assetIds: [flow.assetId],
        date: asOfDate,
      });

      const price = prices[flow.assetId];
      if (!price) {
        handleError(`No price found for asset ${flow.assetId}`);
        continue;
      }

      const value = flow.numAssets * price.price;

      // Convert using transaction date FX
      const transactionFx = await getExchangeRate({
        fromCurrency: price.currency,
        toCurrency: targetCurrency,
        date: flow.date,
      });
      transactionDateValue = value * transactionFx;

      // Convert using valuation date FX
      const valuationFx = await getExchangeRate({
        fromCurrency: price.currency,
        toCurrency: targetCurrency,
        date: fxDate,
      });
      valuationDateValue = value * valuationFx;
    } else {
      const currencyISOCode = (await getCurrencyAsset(flow.assetId))?.isoCode;
      if (!currencyISOCode) {
        handleError(new Error(`Currency asset ${flow.assetId} not found`));
        continue;
      }

      const fromCurrency = currencyISOCode;
      const value = flow.numAssets;

      // Get both transaction date and valuation date FX rates
      const [transactionFx, valuationFx] = await Promise.all([
        getExchangeRate({
          fromCurrency,
          toCurrency: targetCurrency,
          date: flow.date,
        }),
        getExchangeRate({
          fromCurrency,
          toCurrency: targetCurrency,
          date: fxDate,
        }),
      ]);

      transactionDateValue = value * transactionFx;
      valuationDateValue = value * valuationFx;
    }

    // Initialize entity values if not exists
    const investingEntityKey = flow.investingEntityKey;
    if (!result[investingEntityKey]) {
      result[investingEntityKey] = {
        amountRealised: {
          transactionDateValue: 0,
          valuationDateValue: 0,
        },
        amountRealisedDirect: {
          transactionDateValue: 0,
          valuationDateValue: 0,
        },
        amountInvested: {
          transactionDateValue: 0,
          valuationDateValue: 0,
        },
      };
    }

    // Add values using respective FX rates
    if (transactionDateValue > 0) {
      result[investingEntityKey].amountRealised.transactionDateValue += transactionDateValue;
      result[investingEntityKey].amountRealised.valuationDateValue += valuationDateValue;
      // Degree 1 is one causal step from the investee: the company itself paid
      // it. Degree 2 and beyond came out of whatever the investment turned into.
      if (flow.degree === 1) {
        result[investingEntityKey].amountRealisedDirect.transactionDateValue +=
          transactionDateValue;
        result[investingEntityKey].amountRealisedDirect.valuationDateValue += valuationDateValue;
      }
    } else {
      result[investingEntityKey].amountInvested.transactionDateValue -= transactionDateValue;
      result[investingEntityKey].amountInvested.valuationDateValue -= valuationDateValue;
    }
  }

  collector?.header('Realized Value Calculations');
  collector?.text(
    'Σ(cash amount * exchange rate), where exchange rate is calculated for each transfer date and valuation date',
  );
  collector?.table(
    [
      'Entity',
      'Value (FX @ Date)',
      'Value (FX @ "Now")',
      'Invested (FX @ Date)',
      'Invested (FX @ "Now")',
    ],
    Object.entries(result).map(([entityKey, value]) => [
      entityKey.split(':')[1],
      value.amountRealised.transactionDateValue.toFixed(2),
      value.amountRealised.valuationDateValue.toFixed(2),
      value.amountInvested.transactionDateValue.toFixed(2),
      value.amountInvested.valuationDateValue.toFixed(2),
    ]),
  );
  collector?.commit();

  return result;
}

export { getRealisedValue };
