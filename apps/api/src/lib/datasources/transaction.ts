import * as db from '@prisma/client';
import Dataloader, { Options } from 'dataloader';

import { AssetTransferWithCurrencyAsset } from './asset_transfer';
import { actingTeamFilter } from './dataloaders';

interface TransactionWithAssetTransfersAndCurrencyAsset extends db.Transaction {
  assetTransfers: AssetTransferWithCurrencyAsset[];
}

type TransactionByIdDataLoader = Dataloader<
  string,
  TransactionWithAssetTransfersAndCurrencyAsset | null
>;

function getTransactionByIdDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<string, TransactionWithAssetTransfersAndCurrencyAsset | null>,
): TransactionByIdDataLoader {
  return new Dataloader(async (ids) => {
    const transactions = await prisma.transaction.findMany({
      where: {
        teamId: actingTeamFilter(),
        id: {
          in: [...ids], // turn ids into non-readonly
        },
      },
      include: {
        assetTransfers: {
          include: { asset: { include: { currencyAsset: { select: { isoCode: true } } } } },
        },
      },
    });

    const groupedTransactions = new Map(
      transactions.map((transaction) => [transaction.id, transaction]),
    );
    return ids.map((id) => groupedTransactions.get(id) ?? null);
  }, dataloaderOptions);
}

export { getTransactionByIdDataloader };
