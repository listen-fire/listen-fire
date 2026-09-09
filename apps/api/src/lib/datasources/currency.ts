import { TeamlessDataContext } from '.';

import * as db from '@prisma/client';

import { Dataloaders as CurrencyDataloaders } from './dataloaders/currency';

class CurrencyAsset {
  // Taken from https://www1.oanda.com/currency/iso-currency-codes/NOK
  // Note: Don't change the pairOrder unless you know what you're doing
  static currencies = {
    [db.CurrencyIsoCode.CHF]: {
      assetId: '81048f5b-9687-46db-84b4-af342fe55faf',
      isoCode: db.CurrencyIsoCode.CHF,
      name: 'Swiss Franc',
      symbol: 'CHF',
      pairOrder: 3,
    },
    [db.CurrencyIsoCode.EUR]: {
      assetId: '731fd6ca-b9aa-452f-8d29-142c694b173b',
      isoCode: db.CurrencyIsoCode.EUR,
      name: 'Euro',
      symbol: '€',
      pairOrder: 1,
    },
    [db.CurrencyIsoCode.GBP]: {
      assetId: '7d6ab9ea-3d18-4bef-a439-367d3a0c41b1',
      isoCode: db.CurrencyIsoCode.GBP,
      name: 'Pound',
      symbol: '£',
      pairOrder: 2,
    },
    [db.CurrencyIsoCode.NOK]: {
      assetId: 'bc8537e4-3c01-48f4-a5b2-011a29f43888',
      isoCode: db.CurrencyIsoCode.NOK,
      name: 'Norwegian Kroner',
      symbol: 'kr',
      pairOrder: 5,
    },
    [db.CurrencyIsoCode.SEK]: {
      assetId: '1ade323b-f601-4600-a357-fc52e7d59750',
      isoCode: db.CurrencyIsoCode.SEK,
      name: 'Swedish Krona',
      symbol: 'kr',
      pairOrder: 4,
    },
    [db.CurrencyIsoCode.USD]: {
      assetId: 'ec26668a-fabe-413c-af99-c580757b1cb5',
      isoCode: db.CurrencyIsoCode.USD,
      name: 'Dollar',
      symbol: '$',
      pairOrder: 0,
    },
    [db.CurrencyIsoCode.DKK]: {
      assetIt: 'd63ec13e-b128-44c4-bb8f-99684f53ad84',
      isoCode: db.CurrencyIsoCode.DKK,
      name: 'Danish Kroner', // singular is Krone, like NOK
      symbol: 'kr',
      pairOrder: 6,
    },
  };
  constructor(private readonly ctx: TeamlessDataContext<CurrencyDataloaders>) {}

  public async create({
    isoCode,
    name,
    symbol,
    pairOrder,
    assetId,
  }: {
    isoCode: db.CurrencyIsoCode;
    name: string;
    symbol: string;
    pairOrder: number;
    assetId?: string;
  }): Promise<db.CurrencyAsset> {
    // Deliberately team-less, hence `TeamlessDataContext`: a currency asset is
    // global reference data, not a tenant's holding. It is minted only by the
    // `sync-fx-rates` CLI, and `AssetType.CURRENCY` is the one asset shape the
    // ability never scoped to a team either.
    const asset = await this.ctx.prisma.asset.create({
      data: {
        id: assetId,
        name,
        type: db.AssetType.CURRENCY,
        properties: db.Prisma.JsonNull,
      },
    });

    return this.ctx.prisma.currencyAsset.create({
      data: {
        name,
        symbol,
        isoCode,
        pairOrder,
        assetId: asset.id,
      },
    });
  }

  public async getOrCreate({
    isoCode,
  }: {
    isoCode: db.CurrencyIsoCode;
  }): Promise<db.CurrencyAsset> {
    const currency = CurrencyAsset.currencies[isoCode];
    try {
      return await this.ctx.prisma.currencyAsset.findFirstOrThrow({
        where: { isoCode },
      });
    } catch (_e) {
      return this.create(currency);
    }
  }

  public async ensureAllCurrencies(): Promise<void> {
    await Promise.all(
      Object.values(CurrencyAsset.currencies).map(async ({ isoCode }) =>
        this.getOrCreate({ isoCode }),
      ),
    );
  }

  public async findAll(): Promise<db.CurrencyAsset[]> {
    return this.ctx.prisma.currencyAsset.findMany();
  }

  public async getByIsoCode(isoCode: db.CurrencyIsoCode): Promise<db.CurrencyAsset> {
    const currencyAsset = await this.ctx.dataloaders.currencyAssetByIsoCode.load(isoCode);
    if (currencyAsset === null) {
      throw new Error(`Could not find currency with ISO code ${isoCode}`);
    }
    return currencyAsset;
  }
}

export { CurrencyAsset };
