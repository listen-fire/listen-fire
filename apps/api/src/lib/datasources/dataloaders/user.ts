import { defaultOptions } from '.';

import * as db from '@prisma/client';
import Dataloader, { Options } from 'dataloader';

interface Dataloaders {
  userById: UserByIdDataLoader;
}

function getDataloaders(prisma: db.Prisma.TransactionClient): Dataloaders {
  return {
    userById: getUserByIdDataloader(prisma, defaultOptions),
  };
}

type UserByIdDataLoader = Dataloader<string, (db.User & { email: string }) | null>;
function getUserByIdDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<string, (db.User & { email: string }) | null>,
): UserByIdDataLoader {
  return new Dataloader(async (ids) => {
    const userEmails = await prisma.userEmail.findMany({
      where: {
        userId: {
          in: [...ids], // turn into non-readonly
        },
        isPrimary: true,
      },
      include: { user: true },
    });

    const users = userEmails.map(({ user, email }) => ({
      ...user,
      email,
    }));

    const usersById = new Map(users.map((item) => [item.id, item]));
    return ids.map((id) => usersById.get(id) ?? null);
  }, dataloaderOptions);
}

export { Dataloaders, getDataloaders };
