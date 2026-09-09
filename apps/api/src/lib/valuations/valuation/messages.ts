import { formatDate } from 'date-fns';

import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import { MessageCollector } from '../messages';
import { InvestingEntityKey } from '../inventory/types';

function logValuationInput({
  investments,
  asOfDate,
  strategy = 'FIFO',
  targetCurrency,
  messageCollector,
}: {
  investments: { id: string; date: Date | null }[];
  asOfDate: Date;
  strategy?: 'LIFO' | 'FIFO';
  targetCurrency: CurrencyIsoCode;
  messageCollector?: MessageCollector;
}) {
  messageCollector?.header('Valuation for investments');
  messageCollector?.text('These are the set of investments to be valued');
  messageCollector?.table(
    ['Investment ID', 'Date'],
    investments.map((investment) => [
      investment.id,
      investment.date ? formatDate(investment.date, 'yyyy-MM-dd') : '-',
    ]),
  );
  messageCollector?.header('Parameters');
  messageCollector?.text('These are the parameters used for the valuation');
  messageCollector?.table(
    ['Parameter', 'Value'],
    [
      ['As of Date', asOfDate.toISOString()],
      ['Inventory Strategy', strategy],
      ['Target Currency', targetCurrency],
    ],
  );
}

function logValuationOutput({
  messageCollector,
  investmentValuesByEntity,
}: {
  messageCollector?: MessageCollector;
  investmentValuesByEntity: {
    investingEntityKey: InvestingEntityKey;
    unrealizedTransactionDateValue: number;
    unrealizedValuationDateValue: number;
    realizedTransactionDateValue: number;
    realizedValuationDateValue: number;
    realizedCashTransactionDateValue: number;
    realisedDirectValue: number;
    retainedValue: number;
    retainedNonTrackingValue: number;
    totalTransactionDateValue: number;
    totalValuationDateValue: number;
  }[];
}) {
  // Every column here puts BOTH legs on one FX basis, so each pair adds up.
  // Neither total is the headline — that's the next table.
  messageCollector?.header(`Valuation of current holdings`);
  messageCollector?.text(
    'Pinned = FX at each flow\'s own date; Now = FX at the valuation date. Both legs on the same basis.',
  );
  messageCollector?.table(
    [
      'Entity',
      'Unrealized Value (Pinned)',
      'Unrealized Value (Now)',
      'Realized Value (Pinned)',
      'Realized Value (Now)',
      'Total Value (Pinned)',
      'Total Value (Now)',
    ],
    investmentValuesByEntity.map((val) => [
      val.investingEntityKey.split(':')[1],
      val.unrealizedTransactionDateValue.toFixed(2),
      val.unrealizedValuationDateValue.toFixed(2),
      val.realizedTransactionDateValue.toFixed(2),
      val.realizedValuationDateValue.toFixed(2),
      val.totalTransactionDateValue.toFixed(2),
      (val.unrealizedValuationDateValue + val.realizedValuationDateValue).toFixed(2),
    ]),
  );

  messageCollector?.header('Headline value');
  messageCollector?.text(
    'Realized is cash and only cash, each payment kept at the rate it arrived at — it may ' +
      'already have been distributed, so what we got is what we got. Retained is everything ' +
      'we still hold, whether in the company itself or in what it turned into, marked live at ' +
      'the latest price and the valuation date\'s rate. Total Value is the two added together, ' +
      'and the MOIC numerator.',
  );
  messageCollector?.table(
    [
      'Entity',
      'Realized (All)',
      'Realized (From Company)',
      'Retained (In Company)',
      'Retained (In What It Became)',
      'Total Value',
    ],
    investmentValuesByEntity.map((val) => [
      val.investingEntityKey.split(':')[1],
      val.realizedCashTransactionDateValue.toFixed(2),
      val.realisedDirectValue.toFixed(2),
      val.unrealizedValuationDateValue.toFixed(2),
      val.retainedNonTrackingValue.toFixed(2),
      val.totalValuationDateValue.toFixed(2),
    ]),
  );
}

export { logValuationInput, logValuationOutput };
