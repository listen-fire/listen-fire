import { defaultOptions } from '.';

import * as db from '@prisma/client';
import Dataloader, { Options } from 'dataloader';

interface Dataloaders {
  legalEntityById: LegalEntityByIdDataLoader;
}

function getDataloaders(prisma: db.Prisma.TransactionClient): Dataloaders {
  return {
    legalEntityById: getLegalEntityByIdDataloader(prisma, defaultOptions),
  };
}

type LegalEntityByIdDataLoader = Dataloader<string, db.LegalEntity | null>;
function getLegalEntityByIdDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<string, db.LegalEntity | null>,
): LegalEntityByIdDataLoader {
  return new Dataloader(async (ids) => {
    const legalEntities = await prisma.legalEntity.findMany({
      where: {
        id: {
          in: [...ids], // turn ids into non-readonly
        },
      },
    });
    const legalEntitiesById = new Map(legalEntities.map((item) => [item.id, item]));
    return ids.map((id) => legalEntitiesById.get(id) ?? null);
  }, dataloaderOptions);
}

export { Dataloaders, getDataloaders };
