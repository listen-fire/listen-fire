import * as db from '@prisma/client';
import Dataloader, { Options } from 'dataloader';

import {
  EventWithTransfers,
  EventWithTransfersByLegalEntityIdDataloader,
  getEventsWithTransfers,
} from './event';

function getDividendByLegalEntityIdDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<string, EventWithTransfers[]>,
): EventWithTransfersByLegalEntityIdDataloader {
  return new Dataloader(async (legalEntityIds) => {
    const ids = [...legalEntityIds];
    const events = await getEventsWithTransfers({
      legalEntityIds: ids,
      eventType: db.EventType.DIVIDEND,
      prisma,
    });

    const eventsByLegalEntityId = events.reduce((acc, item) => {
      const currentItems = acc.get(item.legalEntityId);
      return currentItems
        ? acc.set(item.legalEntityId, [...currentItems, item])
        : acc.set(item.legalEntityId, [item]);
    }, new Map<string, EventWithTransfers[]>());

    return legalEntityIds.map((legalEntityId) => eventsByLegalEntityId.get(legalEntityId) ?? []);
  }, dataloaderOptions);
}

export { getDividendByLegalEntityIdDataloader };
