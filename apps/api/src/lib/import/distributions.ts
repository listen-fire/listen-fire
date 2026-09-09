import * as db from '@prisma/client';

import { CurrencyAsset } from '../datasources/currency';
import { currentContext } from '../../services/context';

interface Distribution {
  date: Date;
  amount: number;
  currency: db.CurrencyIsoCode;
}

/*
  Adds a fund distribution.
  All that happens here is that the investor receives some cash from the fund.
  Unlike an Exit, the investor is not selling their stake in the fund, and is just
  receiving the proceeds of an exit of the fund's portfolio companies
  (or a distribution from another fund in turn).
*/
async function addFundDistribution({
  fundEntityId,
  investorId,
  distribution,
}: {
  fundEntityId: string;
  investorId: string;
  distribution: Distribution;
}) {
  const ctx = currentContext();
  const fund = await ctx.prisma.legalEntity.findUniqueOrThrow({ where: { id: fundEntityId } });

  const eventDate = distribution.date;

  const event = await ctx.prisma.event.create({
    data: {
      date: eventDate,
      name: `${fund.name} Distribution`,
      type: db.EventType.FUND_DISTRIBUTION,
      legalEntityId: fundEntityId,
      teamId: ctx.user.teamId,
    },
  });

  const transaction = await ctx.prisma.transaction.create({
    data: { closeDate: eventDate, eventId: event.id, teamId: ctx.user.teamId },
  });

  const currencyAssetTable = new CurrencyAsset(ctx);
  const currency = await currencyAssetTable.getByIsoCode(distribution.currency);
  await ctx.prisma.assetTransfer.create({
    data: {
      fromLegalEntityId: fundEntityId,
      toLegalEntityId: investorId,
      assetId: currency.assetId,
      numAssets: distribution.amount,
      date: distribution.date,
      transactionId: transaction.id,
      teamId: ctx.user.teamId,
    },
  });

  return event;
}

export { addFundDistribution };
