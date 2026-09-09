import { defaultOptions } from '.';

import * as db from '@prisma/client';
import Dataloader, { Options } from 'dataloader';

interface Dataloaders {
  currencyAssetByIsoCode: CurrencyAssetByIsoCodeDataLoader;
}

function getDataloaders(prisma: db.Prisma.TransactionClient): Dataloaders {
  return {
    currencyAssetByIsoCode: getCurrencyAssetByIsoCodeDataloader(prisma, {
      ...defaultOptions,
      cacheKeyFn: (key: db.CurrencyIsoCode): db.CurrencyIsoCode => key,
    }),
  };
}

type CurrencyAssetByIsoCodeDataLoader = Dataloader<db.CurrencyIsoCode, db.CurrencyAsset | null>;
function getCurrencyAssetByIsoCodeDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<db.CurrencyIsoCode, db.CurrencyAsset | null>,
): CurrencyAssetByIsoCodeDataLoader {
  return new Dataloader(async (isoCodes) => {
    const records = await prisma.currencyAsset.findMany({
      where: {
        isoCode: {
          in: [...isoCodes], // turn ids into non-readonly
        },
      },
    });
    const recordsByIsoCode = new Map(records.map((record) => [record.isoCode, record]));
    return isoCodes.map((isoCode) => recordsByIsoCode.get(isoCode) ?? null);
  }, dataloaderOptions);
}

export { Dataloaders, getDataloaders };
