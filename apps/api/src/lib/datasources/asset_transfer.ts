import * as db from '@prisma/client';

import { Context } from '../../services/context';

interface AssetTransferWithCurrencyAsset extends db.AssetTransfer {
  asset: db.Asset & {
    currencyAsset: {
      isoCode: db.CurrencyIsoCode;
    } | null;
  };
}

async function upsertAssetTransfer(
  {
    fromLegalEntityId,
    toLegalEntityId,
    assetId,
    numAssets,
    transactionId,
    date,
  }: {
    fromLegalEntityId: string;
    toLegalEntityId: string;
    assetId: string;
    numAssets: number;
    date: Date;
    transactionId: string;
  },
  ctx: Context,
): Promise<db.AssetTransfer> {
  const assetTransfers = await ctx.prisma.assetTransfer.findMany({
    where: {
      teamId: ctx.user.teamId,
      fromLegalEntityId,
      toLegalEntityId,
      transactionId,
      assetId,
    },
  });
  switch (assetTransfers.length) {
    case 1:
      return ctx.prisma.assetTransfer.update({
        where: {
          id: assetTransfers[0].id,
        },
        data: { numAssets },
      });
    case 0:
      return ctx.prisma.assetTransfer.create({
        data: {
          fromLegalEntityId,
          toLegalEntityId,
          transactionId,
          assetId,
          numAssets,
          date,
          teamId: ctx.user.teamId,
        },
      });
    default:
      throw new Error(
        `Too many asset transfers for transaction ID ${transactionId} and asset ID ${assetId}`,
      );
  }
}

function getTransfersByAssetType<T extends { asset: { type: db.AssetType } }>({
  transfers,
  assetType,
}: {
  transfers: T[];
  assetType: db.AssetType;
}): T[] {
  return transfers.filter(({ asset: { type } }) => type === assetType);
}

function extractCurrencyCodeOrThrow(assetTransfer: {
  asset: { currencyAsset: { isoCode: db.CurrencyIsoCode } | null };
}): db.CurrencyIsoCode {
  const currency = assetTransfer.asset.currencyAsset?.isoCode;
  if (currency === undefined) {
    throw new Error('Transfer does not have a currency asset');
  }
  return currency;
}

export {
  AssetTransferWithCurrencyAsset,
  upsertAssetTransfer,
  getTransfersByAssetType,
  extractCurrencyCodeOrThrow,
};
