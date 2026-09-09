import * as db from '@prisma/client';
import Dataloader, { Options } from 'dataloader';
import { format } from 'date-fns';

import { FxContext } from '../../services/fx_conversion/money';
import { hash } from '../utils/hash';

type ExchangeRateDataloaderKey = {
  fromCurrency: db.CurrencyIsoCode;
  toCurrency: db.CurrencyIsoCode;
  date: Date;
};

type ExchangeRateByFromToDateDataloader = Dataloader<
  ExchangeRateDataloaderKey,
  db.ExchangeRate | null
>;

function getExchangeRateByFromToDateDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<ExchangeRateDataloaderKey, db.ExchangeRate | null, string>,
): ExchangeRateByFromToDateDataloader {
  return new Dataloader(async (keys) => {
    const fromToDateTuples = keys
      .map(
        (key) => `('${key.fromCurrency}','${key.toCurrency}','${format(key.date, 'yyyy-MM-dd')}')`,
      )
      .join();

    // Prisma does not support filtering by a list of tuples
    // see https://github.com/prisma/prisma/issues/10241
    // `exchange_rate` lives in the `valuations` schema (moved there by the
    // carve's Phase 2D schema migration) — the Prisma-mapped calls below
    // resolve it via the client's own schema mapping, but this raw query
    // needs the schema spelled out; the default search_path doesn't include
    // it.
    const rates = await prisma.$queryRawUnsafe<db.ExchangeRate[]>(`
      SELECT *
      FROM valuations.exchange_rate
      WHERE (from_currency, to_currency, date) IN (${fromToDateTuples})`);

    const ratesByStringKey = new Map(
      rates.map((item) => [
        hash<ExchangeRateDataloaderKey>({
          fromCurrency: item.fromCurrency,
          toCurrency: item.toCurrency,
          date: item.date,
        }),
        item,
      ]),
    );

    return keys.map((key) => ratesByStringKey.get(hash<ExchangeRateDataloaderKey>(key)) ?? null);
  }, dataloaderOptions);
}

async function fetchLatestExchangeRateAsOf(
  {
    fromCurrency,
    toCurrency,
    date,
  }: { fromCurrency: db.CurrencyIsoCode; toCurrency: db.CurrencyIsoCode; date: Date },
  ctx: FxContext,
) {
  return ctx.prisma.exchangeRate.findFirst({
    where: {
      date: { lte: date },
      fromCurrency,
      toCurrency,
    },
    orderBy: {
      date: 'desc',
    },
  });
}

async function upsertExchangeRate(
  ctx: FxContext,
  {
    fromCurrency,
    toCurrency,
    date,
    rate,
  }: { fromCurrency: db.CurrencyIsoCode; toCurrency: db.CurrencyIsoCode; date: Date; rate: number },
) {
  const item = { fromCurrency, toCurrency, date, rate };

  const exchangeRate = await ctx.prisma.exchangeRate.findUnique({
    where: {
      date_fromCurrency_toCurrency: {
        date,
        fromCurrency,
        toCurrency,
      },
    },
  });
  if (exchangeRate) {
    return ctx.prisma.exchangeRate.update({
      where: {
        date_fromCurrency_toCurrency: {
          date,
          fromCurrency,
          toCurrency,
        },
      },
      data: item,
    });
  }
  return ctx.prisma.exchangeRate.create({
    data: item,
  });
}

export { getExchangeRateByFromToDateDataloader, fetchLatestExchangeRateAsOf, upsertExchangeRate };
