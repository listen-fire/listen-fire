import { z } from 'zod';

import { currentContext } from '../../../services/context';
import { getCurrencyAsset } from '../../datasources/asset';
import { logFundingChange, formatCurrency } from '../../funding-changelog';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';

/**
 * `applyFundDrawdown`'s input, exported as the single zod source of truth —
 * both the tRPC mutation (company.ts) and the REST command route
 * (interfaces/rest/v1/valuations/commands.ts) parse against this schema
 * rather than hand-duplicating the field list.
 *
 * The tab's mutation takes a nested `outstandingCommitment: { assetId,
 * investorId, price, currency }` object — movements/adapters can't build
 * nested bodies, so this is the FLATTENED shape: `assetId`, `investorId`,
 * `price`, `currency` sit at the top level. `company.ts`'s `addFundDrawdown`
 * still accepts the nested tab shape and destructures it down to this one
 * when calling in.
 */
export const applyFundDrawdownInput = z.object({
  fundId: z.string(),
  drawdownAmount: z.number(),
  date: z.string().date(),
  assetId: z.string(),
  investorId: z.string(),
  price: z.number(),
  currency: z.nativeEnum(CurrencyIsoCode),
});

export type ApplyFundDrawdownInput = z.infer<typeof applyFundDrawdownInput>;

/**
 * Records a fund drawing down against an outstanding commitment: a
 * `transaction` (no event), a cash `asset_transfer` from the commitment
 * investor to the fund, and a reduced `price` on the commitment asset
 * (marked down by the drawdown amount, floored at zero), plus a
 * `funding_changelog` audit entry.
 *
 * Everything runs inside one transaction. The transaction boundary is the
 * CALLER's responsibility (`ctx.enterTransaction()` before invoking this),
 * not this service's — a reusable command must not leak a transaction into
 * whatever the caller does next.
 */
export async function applyFundDrawdown(
  input: ApplyFundDrawdownInput,
): Promise<{ transactionId: string; priceId: string }> {
  const ctx = currentContext();
  if (!ctx.inTransaction) {
    throw new Error('applyFundDrawdown must run inside a transaction — the caller owns the transaction boundary');
  }

  const currencyAsset = await getCurrencyAsset(input.currency, ctx);

  const transaction = await ctx.prisma.transaction.create({
    data: {
      closeDate: new Date(input.date),
      teamId: ctx.user.teamId,
      dueToRightsFromAssetId: input.assetId,
    },
  });

  await ctx.prisma.assetTransfer.create({
    data: {
      assetId: currencyAsset.id,
      date: new Date(input.date),
      toLegalEntityId: input.fundId,
      fromLegalEntityId: input.investorId,
      numAssets: input.drawdownAmount,
      transactionId: transaction.id,
      teamId: ctx.user.teamId,
    },
  });

  const price = await ctx.prisma.price.create({
    data: {
      assetId: input.assetId,
      price: Math.max(0, input.price - input.drawdownAmount),
      currency: input.currency,
      teamId: ctx.user.teamId,
      type: 'FROM_PRICED_ROUND',
      date: new Date(input.date),
    },
  });

  await logFundingChange({
    legalEntityId: input.fundId,
    category: 'Add Drawdown',
    description: `Added fund drawdown of ${formatCurrency(input.drawdownAmount, input.currency)}`,
    eventDate: input.date,
  });

  return { transactionId: transaction.id, priceId: price.id };
}
