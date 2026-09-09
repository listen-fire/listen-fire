import * as db from '@prisma/client';
import Dataloader, { Options } from 'dataloader';

import { AssetTransferWithCurrencyAsset } from './asset_transfer';
import { actingTeamFilter } from './dataloaders';

type EventWithTransfers = {
  id: string;
  legalEntityId: string;
  date: Date;
  transactions: (db.Transaction & {
    assetTransfers: AssetTransferWithCurrencyAsset[];
  })[];
};

type EventWithTransfersByLegalEntityIdDataloader = Dataloader<string, EventWithTransfers[]>;
type EventByTransactionIdDataloader = Dataloader<string, db.Event | null>;

function getEventByTransactionIdDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<string, db.Event | null>,
): EventByTransactionIdDataloader {
  return new Dataloader(async (ids) => {
    const events = await prisma.transaction.findMany({
      where: {
        teamId: actingTeamFilter(),
        id: { in: [...ids] }, // turn ids into non-readonly
      },
      select: { id: true, event: true },
    });

    const eventByTransactionId = new Map(events.map((item) => [item.id, item.event]));
    return ids.map((id) => eventByTransactionId.get(id) ?? null);
  }, dataloaderOptions);
}

type EventWithTransfersByIdDataloader = Dataloader<string, EventWithTransfers | null>;

function getEventWithTransfersByIdDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<string, EventWithTransfers | null>,
): EventWithTransfersByIdDataloader {
  return new Dataloader(async (ids) => {
    const events = await prisma.event.findMany({
      where: {
        teamId: actingTeamFilter(),
        id: { in: [...ids] }, // turn ids into non-readonly
      },
      select: {
        legalEntityId: true,
        id: true,
        date: true,
        name: true,
        transactions: {
          include: {
            assetTransfers: {
              include: { asset: { include: { currencyAsset: { select: { isoCode: true } } } } },
            },
          },
        },
      },
    });

    const eventById = new Map(events.map((item) => [item.id, item]));
    return ids.map((transactionId) => eventById.get(transactionId) ?? null);
  }, dataloaderOptions);
}

const getEventsWithTransfers = async ({
  legalEntityIds,
  eventType,
  prisma,
}: {
  legalEntityIds: string[];
  eventType: db.EventType;
  prisma: db.Prisma.TransactionClient;
}) => {
  return prisma.event.findMany({
    where: {
      teamId: actingTeamFilter(),
      legalEntityId: { in: [...legalEntityIds] }, // turn ids into non-readonly
      type: eventType,
    },
    select: {
      legalEntityId: true,
      id: true,
      date: true,
      name: true,
      transactions: {
        include: {
          assetTransfers: {
            include: { asset: { include: { currencyAsset: { select: { isoCode: true } } } } },
          },
        },
      },
    },
  });
};

export {
  EventWithTransfers,
  EventWithTransfersByLegalEntityIdDataloader,
  getEventByTransactionIdDataloader,
  getEventsWithTransfers,
  getEventWithTransfersByIdDataloader,
};
