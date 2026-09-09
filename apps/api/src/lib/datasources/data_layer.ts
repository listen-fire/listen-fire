// TODO(SUP-686) Legacy data layer from lib/import

import * as db from '@prisma/client';

import { Context } from '../../services/context';

async function getOrCreateTransactionByAssetTransfers(
  {
    toLegalEntityId,
    fromLegalEntityId,
    givenAssetId,
    receivedAssetId,
    date,
    eventId,
  }: {
    toLegalEntityId: string;
    fromLegalEntityId: string;
    givenAssetId: string;
    receivedAssetId: string;
    date: Date;
    eventId?: string;
  },
  ctx: Context,
): Promise<db.Transaction> {
  const transaction = await ctx.prisma.transaction.findFirst({
    where: {
      teamId: ctx.user.teamId,
      AND: [
        { assetTransfers: { every: { date } } },
        {
          assetTransfers: {
            some: {
              AND: [
                { assetId: { equals: givenAssetId } },
                { fromLegalEntityId: { equals: fromLegalEntityId } },
                { toLegalEntityId: { equals: toLegalEntityId } },
              ],
            },
          },
        },
        {
          assetTransfers: {
            some: {
              AND: [
                { assetId: { equals: receivedAssetId } },
                { fromLegalEntityId: { equals: toLegalEntityId } },
                { toLegalEntityId: { equals: fromLegalEntityId } },
              ],
            },
          },
        },
      ],
    },
  });

  if (transaction === null) {
    return ctx.prisma.transaction.create({
      data: {
        closeDate: date,
        eventId: eventId,
        teamId: ctx.user.teamId,
      },
    });
  }

  return transaction;
}

export { getOrCreateTransactionByAssetTransfers };
