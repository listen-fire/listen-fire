import { fxConvert, FxRate } from '.';

import * as db from '@prisma/client';

import { Dataloaders, getDataloaders } from '../../lib/datasources/dataloaders';
import { prismaClient } from '../../prisma';

interface FxContext {
  prisma: db.Prisma.TransactionClient;
  dataloaders: Dataloaders;
}

/**
 * Money converts currencies from a module-level client, outside any request: an
 * amount is turned into another currency wherever one is constructed, and there
 * is no Context to borrow.
 *
 * It reads only global reference data — exchange rates, currency assets and the
 * CURRENCY asset rows — which has no team to belong to. Which tables it may
 * touch is said by the three loaders below, the only ones it uses.
 */
function createFxConversionContext(): FxContext {
  return { prisma: prismaClient, dataloaders: getDataloaders(prismaClient) };
}

const fxContext = createFxConversionContext();

type ConversionInfo =
  | { isConverted: false; original: null; fxRate: null; conversionDate: null }
  | { isConverted: true; original: Money; fxRate: FxRate; conversionDate: Date };

class Money {
  readonly amount: number;

  readonly currency: db.CurrencyIsoCode;

  readonly conversionInfo: ConversionInfo;

  private static ctx: FxContext = fxContext;

  constructor({
    amount,
    currency,
    isConverted = false,
    original,
    fxRate,
    conversionDate,
  }: {
    amount: number;
    currency: db.CurrencyIsoCode;
    isConverted?: boolean;
    original?: Money;
    fxRate?: FxRate;
    conversionDate?: Date;
  }) {
    this.amount = amount;
    this.currency = currency;
    if (isConverted) {
      if (original === undefined || fxRate === undefined || conversionDate === undefined) {
        throw new Error('Converted Money is missing conversion information');
      }
      this.conversionInfo = { isConverted, original, fxRate, conversionDate };
    } else {
      this.conversionInfo = { isConverted, original: null, fxRate: null, conversionDate: null };
    }
  }

  async fxConvert({ toCurrency, date }: { toCurrency: db.CurrencyIsoCode; date: Date }) {
    const converted = await fxConvert(
      {
        fromCurrency: this.currency,
        fromAmount: this.amount,
        toCurrency,
        date,
      },
      Money.ctx,
    );

    return new Money({
      amount: converted.convertedAmount,
      currency: toCurrency,
      isConverted: true,
      original: this,
      fxRate: converted.conversionRate,
      conversionDate: date,
    });
  }
}

export { FxContext, Money };
