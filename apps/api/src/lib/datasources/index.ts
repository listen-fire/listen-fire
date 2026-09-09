import * as db from '@prisma/client';

import { Dataloaders as AllDataloaders } from './dataloaders';

interface DataContext<Dataloaders = Partial<AllDataloaders>> {
  prisma: db.Prisma.TransactionClient;
  dataloaders: Dataloaders;
  teamId: string;
}

interface TeamlessDataContext<Dataloaders = Partial<AllDataloaders>>
  extends Omit<DataContext<Dataloaders>, 'teamId'> {
  teamId?: string | null;
}

export { DataContext, TeamlessDataContext };
