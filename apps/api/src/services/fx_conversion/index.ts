import * as db from '@prisma/client';
import { LRUCache } from 'lru-cache';
import { format, startOfToday, startOfYesterday } from 'date-fns';

import { fetchLatestExchangeRateAsOf } from '../../lib/datasources/exchange_rate';
import { FxContext } from './money';
import { MINUTE } from '../../constants';

interface FxQuery {
  fromCurrency: db.CurrencyIsoCode;
  toCurrency: db.CurrencyIsoCode;
  date: Date;
}

interface FxRate {
  from: db.CurrencyIsoCode;
  to: db.CurrencyIsoCode;
  date: Date;
  rate: number;
  isInverted: boolean;
}

interface CachedFxRate {
  date: Date;
  rate: number;
}

const currencyRateCache = new LRUCache<string, CachedFxRate>({
  max: 500,
  ttl: MINUTE * 60 * 24, // Day in milliseconds
});

function getCacheKey(from: db.CurrencyIsoCode, to: db.CurrencyIsoCode, date: Date) {
  return [from.toString(), to.toString(), format(date, 'yyyy-MM-dd')].join(':');
}

async function fxConvert(
  {
    fromAmount,
    fromCurrency,
    toCurrency,
    date,
  }: {
    fromAmount: number;
    fromCurrency: db.CurrencyIsoCode;
    toCurrency: db.CurrencyIsoCode;
    date: Date;
  },
  ctx: FxContext,
): Promise<{ convertedAmount: number; conversionRate: FxRate }> {
  const conversionRate = await getFxRate({ fromCurrency, toCurrency, date }, ctx);
  return { convertedAmount: fromAmount * conversionRate.rate, conversionRate };
}

async function getFxRate(
  { fromCurrency, toCurrency, date }: FxQuery,
  ctx: FxContext,
): Promise<FxRate> {
  /*
  Gets the exchange rate for a currency pair and a date, e.g. EUR/GBP for 2020-01-28

  If the queried pair is e.g. EUR/GBP it tries to match in the following order:
    1. cache - exact currency pair - exact date
    2. cache - inverse currency pair (GBP/EUR) - exact date
    3. database - exact currency pair - exact date
    4. database - inverse currency pair (GBP/EUR) - exact date
    5. inefficient database - exact currency pair - as of date
    6. inefficient database - inverse currency pair (GBP/EUR) - as of date
    7. throws if nothing is found

  When the match happens on the inverse currency pair we:
    - track the **queried** pair
    - take the inverse of the rate, i.e. 1/rate
    - set `isInverted=true` to indicate that the rate is derived

  We always store the date of the retrieved rate. So, the match will NOT show the queried date
  when the latest available rate was BEFORE the queried date.

  Cross pairs are not supported, i.e. if we store GBP/USD and USD/EUR, we won't retrieve
  GBP/EUR although possible to derive.
  */

  if (fromCurrency === toCurrency) {
    return { from: fromCurrency, to: toCurrency, date, rate: 1, isInverted: false };
  }
  // We don't have real-time exchange rates but only as of the previous day
  const queryDate = date >= startOfToday() ? startOfYesterday() : date;

  const cachedRate = getRateFromCache({ fromCurrency, toCurrency, date: queryDate });
  if (cachedRate) {
    return cachedRate;
  }

  const rateFromDb = await getRateFromDb({ fromCurrency, toCurrency, date: queryDate }, ctx);
  if (rateFromDb) {
    // Note that the rate has been already inverted if it matched the inverse pair in the database
    const fromToKey = getCacheKey(fromCurrency, toCurrency, queryDate);
    currencyRateCache.set(fromToKey, { date: rateFromDb.date, rate: rateFromDb.rate });
    return rateFromDb;
  }

  throw new Error(
    `Could not find exchange rate for pair ${fromCurrency}/${toCurrency} on date ${date}`,
  );
}

async function getRateFromDb(
  { fromCurrency, toCurrency, date }: FxQuery,
  ctx: FxContext,
): Promise<FxRate | null> {
  const directRate = await ctx.dataloaders.exchangeRateByFromToDate.load({
    fromCurrency,
    toCurrency,
    date,
  });
  if (directRate) {
    return {
      from: directRate.fromCurrency,
      to: directRate.toCurrency,
      date: directRate.date,
      rate: directRate.rate,
      isInverted: false,
    };
  }

  const inverseRate = await ctx.dataloaders.exchangeRateByFromToDate.load({
    fromCurrency: toCurrency,
    toCurrency: fromCurrency,
    date,
  });
  if (inverseRate) {
    return {
      from: inverseRate.toCurrency,
      to: inverseRate.fromCurrency,
      date: inverseRate.date,
      rate: 1 / inverseRate.rate,
      isInverted: true,
    };
  }
  return getRateFromDbInefficient({ fromCurrency, toCurrency, date }, ctx);
}

async function getRateFromDbInefficient(
  { fromCurrency, toCurrency, date }: FxQuery,
  ctx: FxContext,
): Promise<FxRate | null> {
  const directRate = await fetchLatestExchangeRateAsOf({ fromCurrency, toCurrency, date }, ctx);
  if (directRate) {
    return {
      from: directRate.fromCurrency,
      to: directRate.toCurrency,
      date: directRate.date,
      rate: directRate.rate,
      isInverted: false,
    };
  }

  const inverseRate = await fetchLatestExchangeRateAsOf(
    { fromCurrency: toCurrency, toCurrency: fromCurrency, date },
    ctx,
  );
  if (inverseRate) {
    return {
      from: inverseRate.toCurrency,
      to: inverseRate.fromCurrency,
      date: inverseRate.date,
      rate: 1 / inverseRate.rate,
      isInverted: true,
    };
  }

  return null;
}

function getRateFromCache({ fromCurrency, toCurrency, date }: FxQuery) {
  const fromToCurrencyKey = getCacheKey(fromCurrency, toCurrency, date);
  const directRate = currencyRateCache.get(fromToCurrencyKey);
  if (directRate) {
    return {
      from: fromCurrency,
      to: toCurrency,
      date: directRate.date,
      rate: directRate.rate,
      isInverted: false,
    };
  }

  const toFromCurrencyKey = getCacheKey(toCurrency, fromCurrency, date);
  const inverseRate = currencyRateCache.get(toFromCurrencyKey);
  if (inverseRate) {
    return {
      from: fromCurrency,
      to: toCurrency,
      date: inverseRate.date,
      rate: 1 / inverseRate.rate,
      isInverted: true,
    };
  }
  return undefined;
}

export { FxRate, fxConvert,  };
