import * as db from '@prisma/client';
import Dataloader, { Options } from 'dataloader';
import sortBy from 'lodash/sortBy';
import groupBy from 'lodash/groupBy';

import { hash } from '../utils/hash';
import { actingTeamFilter } from './dataloaders';

interface LatestPriceDataloaderKey {
  issuedByLegalEntityId: string;
  assetType: db.AssetType;
  asOfDate: Date;
  preferredAssetId: string | undefined;
}

type KeyByIssuerAndAssetType = {
  issuedByLegalEntityId: string | null;
  assetType: db.AssetType;
};

type LatestPricesDataloader = Dataloader<LatestPriceDataloaderKey, db.Price | null>;

function getLatestPricesByIssuerAssetTypeAndDateDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<LatestPriceDataloaderKey, db.Price | null, string>,
): LatestPricesDataloader {
  return new Dataloader(async (keys) => {
    // Over select cross-product of issuer ID X asset type as Prisma does not support
    // where IN with a list of tuples (see https://github.com/prisma/prisma/issues/10241)
    const legalEntityIds = new Set(keys.map(({ issuedByLegalEntityId }) => issuedByLegalEntityId));
    const assetTypes = new Set(keys.map(({ assetType }) => assetType));
    const prices = await prisma.price.findMany({
      where: {
        teamId: actingTeamFilter(),
        OR: [
          { asset: { issuedByLegalEntityId: { in: [...legalEntityIds] } } },
          { asset: { type: { in: [...assetTypes] } } },
        ],
      },
      distinct: ['assetId', 'date'],
      include: { asset: true },
    });

    // Group prices by issuer and type
    const groupedPrices = prices.reduce((acc, price) => {
      const key = hash<KeyByIssuerAndAssetType>({
        issuedByLegalEntityId: price.asset!.issuedByLegalEntityId,
        assetType: price.asset!.type,
      });
      acc.set(key, [...(acc.get(key) ?? []), price]);
      return acc;
    }, new Map<string, (db.Price & { asset: db.Asset | null })[]>());

    // Fetch the last price <= key.asOfDate
    // NOTE: this is problematic if there are multiple prices on the same day
    // for different assets of the same type and issuer. In most cases we would
    // not expect different prices for different assets of the same type and issuer.
    return keys.map((key) => {
      const pricesByIssuerAndType = groupedPrices.get(
        hash<KeyByIssuerAndAssetType>({
          issuedByLegalEntityId: key.issuedByLegalEntityId,
          assetType: key.assetType,
        }),
      );
      if (pricesByIssuerAndType === undefined) {
        return null;
      }
      const sortedPrices = sortBy(
        pricesByIssuerAndType.filter((price) => price.date <= key.asOfDate),
        'date',
      ).reverse();
      if (sortedPrices.length < 1) {
        return null;
      }

      const preferred =
        key.preferredAssetId &&
        sortedPrices.find(
          (price) =>
            price.assetId === key.preferredAssetId &&
            sortedPrices[0].date.getTime() === price.date.getTime(),
        );

      if (preferred) {
        return preferred;
      }

      if (
        sortedPrices.length > 1 &&
        sortedPrices[0].date.getTime() === sortedPrices[1].date.getTime() &&
        sortedPrices[0].price !== sortedPrices[1].price
      ) {
        console.warn('Multiple prices on the same day for the same asset type');
      }
      return sortedPrices[0] ?? null;
    });
  }, dataloaderOptions);
}

interface LatestPriceByAssetIdDataloaderKey {
  assetId: string;
  asOfDate: Date;
}
type LatestPriceByAssetIdDataloader = Dataloader<
  LatestPriceByAssetIdDataloaderKey,
  db.Price | null
>;

function getLatestPriceByAssetIdAndDateDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<LatestPriceByAssetIdDataloaderKey, db.Price | null, string>,
): LatestPriceByAssetIdDataloader {
  return new Dataloader(async (keys) => {
    // Over select as Prisma does not support where IN with a list of tuples
    // see https://github.com/prisma/prisma/issues/10241
    const assetIds = keys.map(({ assetId }) => assetId);
    const prices = await prisma.price.findMany({
      where: { teamId: actingTeamFilter(), assetId: { in: assetIds } },
      orderBy: { date: 'desc' },
      include: {
        asset: {
          select: {
            issuedByLegalEntityId: true,
          },
        },
      },
    });

    // Group prices by id
    const groupedPrices = groupBy(prices, 'assetId');
    // Fetch the last price <= key.date
    return keys.map((key) => {
      const pricesByAsset = groupedPrices[key.assetId];
      if (pricesByAsset === undefined) {
        return null;
      }
      const sortedPrices = sortBy(
        pricesByAsset.filter((price) => price.date <= key.asOfDate),
        'date',
      );
      if (sortedPrices.length < 1) {
        return null;
      }
      return sortedPrices.pop() ?? null;
    });
  }, dataloaderOptions);
}

type PricesDataloader = Dataloader<string, db.Price[]>;
function getPricesByIssuerIdDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<string, db.Price[]>,
): PricesDataloader {
  return new Dataloader(async (issuedByLegalEntityIds) => {
    const prices = await prisma.price.findMany({
      where: {
        teamId: actingTeamFilter(),
        asset: { issuedByLegalEntityId: { in: [...issuedByLegalEntityIds] } },
      },
      orderBy: { date: 'desc' },
      include: { asset: { select: { issuedByLegalEntityId: true } } },
    });

    const groupedPrices = groupBy(prices, (price) => price.asset?.issuedByLegalEntityId);

    return issuedByLegalEntityIds.map((issuedByLegalEntityId) => {
      const pricesByIssuer = groupedPrices[issuedByLegalEntityId];
      if (pricesByIssuer === undefined) {
        return [];
      }
      return pricesByIssuer;
    });
  }, dataloaderOptions);
}

export {
  getLatestPricesByIssuerAssetTypeAndDateDataloader,
  getLatestPriceByAssetIdAndDateDataloader,
  getPricesByIssuerIdDataloader,
};
