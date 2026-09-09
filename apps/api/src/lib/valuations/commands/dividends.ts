import * as db from '@prisma/client';
import { sql } from 'kysely';
import { z } from 'zod';

import { currentContext } from '../../../services/context';
import { getCurrencyAsset } from '../../datasources/asset';
import { logFundingChange, formatCurrency } from '../../funding-changelog';
import { getValuationsQb } from '../../kysely';
import { getAssetTrackedEntities } from '../trackedEntities';
import AssetType from '../../../generated/kysely/valuations/AssetType';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import { LegalEntityId } from '../../../generated/kysely/valuations/LegalEntity';
import { TeamId } from '../../../generated/kysely/core/Team';

/**
 * `applyDividends`'s input, exported as the single zod source of truth —
 * both the tRPC mutation (company.ts) and the REST command route
 * (interfaces/rest/v1/valuations/commands.ts) parse against this schema
 * rather than hand-duplicating the field list.
 */
export const applyDividendsInput = z.object({
  companyId: z.string(),
  date: z.string(),
  amount: z.number(),
  currency: z.string(),
  fundId: z.string(),
});

export type ApplyDividendsInput = z.infer<typeof applyDividendsInput>;

/**
 * The holding a dividend was paid on, when the data says so without guessing:
 * exactly one non-currency asset the receiving investor still holds at the
 * payment date whose value tracks the paying company (its own stock, an SPV
 * over it, …). Nothing held, or more than one candidate, leaves the edge null
 * and the roll-up's proportional fallbacks decide attribution as before.
 *
 * The edge matters because it is the only thing that tells a dividend on the
 * company we invested in apart from one on the stock we took for it — one step
 * of causal distance, and the difference between direct and indirect proceeds.
 */
async function rightsAssetForDividend({
  companyId,
  investorId,
  date,
}: {
  companyId: string;
  investorId: string;
  date: Date;
}): Promise<string | null> {
  const ctx = currentContext();

  const balances = await getValuationsQb(['asset_transfer', 'asset', 'transaction'])
    .selectFrom('asset_transfer as at')
    .innerJoin('asset as a', 'a.id', 'at.asset_id')
    .innerJoin('transaction as t', 't.id', 'at.transaction_id')
    .select([
      'a.id as asset_id',
      sql<number>`sum(case when at.to_legal_entity_id = ${investorId}::uuid then coalesce(at.num_assets, 0) else -coalesce(at.num_assets, 0) end)`.as(
        'balance',
      ),
    ])
    .where('at.team_id', '=', ctx.user.teamId as TeamId)
    .where('a.type', '<>', AssetType.CURRENCY)
    .where('t.close_date', '<=', date)
    .where(($) =>
      $.or([
        $('at.to_legal_entity_id', '=', investorId as LegalEntityId),
        $('at.from_legal_entity_id', '=', investorId as LegalEntityId),
      ]),
    )
    .groupBy('a.id')
    .execute();

  const held = balances.filter((row) => Number(row.balance) > 0).map((row) => row.asset_id);
  if (!held.length) return null;

  const tracked = await getAssetTrackedEntities(held);
  const onPayingCompany = held.filter((assetId) => tracked.get(assetId)?.has(companyId));

  return onPayingCompany.length === 1 ? onPayingCompany[0] : null;
}

/**
 * Records a company paying a dividend to a fund: a `DIVIDEND` event, its
 * containing transaction, and the currency asset transfer from the paying
 * company to the receiving fund, plus a `funding_changelog` audit entry.
 *
 * Everything runs inside one transaction. The transaction boundary is the
 * CALLER's responsibility (`ctx.enterTransaction()` before invoking this),
 * not this service's — a reusable command must not leak a transaction into
 * whatever the caller does next.
 */
export async function applyDividends(input: ApplyDividendsInput): Promise<{ eventId: string }> {
  const ctx = currentContext();
  if (!ctx.inTransaction) {
    throw new Error('applyDividends must run inside a transaction — the caller owns the transaction boundary');
  }

  const event = await ctx.prisma.event.create({
    data: {
      type: db.EventType.DIVIDEND,
      name: 'Dividend',
      date: new Date(input.date),
      teamId: ctx.user.teamId,
      legalEntityId: input.companyId,
    },
  });

  const transaction = await ctx.prisma.transaction.create({
    data: {
      closeDate: new Date(input.date),
      eventId: event.id,
      teamId: ctx.user.teamId,
      dueToRightsFromAssetId: await rightsAssetForDividend({
        companyId: input.companyId,
        investorId: input.fundId,
        date: new Date(input.date),
      }),
    },
  });

  const currencyAsset = await getCurrencyAsset(input.currency as CurrencyIsoCode, ctx);

  await ctx.prisma.assetTransfer.create({
    data: {
      assetId: currencyAsset.id,
      date: new Date(input.date),
      fromLegalEntityId: input.companyId,
      toLegalEntityId: input.fundId,
      numAssets: input.amount,
      transactionId: transaction.id,
      teamId: ctx.user.teamId,
    },
  });

  await logFundingChange({
    legalEntityId: input.companyId,
    category: 'Add Dividend',
    description: `Added dividend of ${formatCurrency(input.amount, input.currency)}`,
    eventDate: input.date,
  });

  return { eventId: event.id };
}
