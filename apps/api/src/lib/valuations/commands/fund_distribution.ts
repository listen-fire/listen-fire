import { z } from 'zod';

import { currentContext } from '../../../services/context';
import { addFundDistribution } from '../../import/distributions';
import { logFundingChange, formatCurrency } from '../../funding-changelog';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';

/**
 * `applyFundDistribution`'s input, exported as the single zod source of
 * truth — both the tRPC mutation (company.ts) and the REST command route
 * (interfaces/rest/v1/valuations/commands.ts) parse against this schema
 * rather than hand-duplicating the field list.
 */
export const applyFundDistributionInput = z.object({
  companyId: z.string(),
  date: z.string(),
  amount: z.number(),
  currency: z.string(),
  fundId: z.string(),
});

export type ApplyFundDistributionInput = z.infer<typeof applyFundDistributionInput>;

/**
 * Records a FUND distributing to an INVESTOR: delegates the `FUND_DISTRIBUTION`
 * event, its containing transaction, and the currency asset transfer to the
 * existing `addFundDistribution` lib helper (`lib/import/distributions.ts`),
 * then logs a `funding_changelog` audit entry — same shape as `applyDividends`,
 * but `companyId` names the distributing fund (`fundEntityId`) and `fundId`
 * names the receiving investor (`investorId`).
 *
 * Everything runs inside one transaction. The transaction boundary is the
 * CALLER's responsibility (`ctx.enterTransaction()` before invoking this),
 * not this service's — a reusable command must not leak a transaction into
 * whatever the caller does next.
 */
export async function applyFundDistribution(
  input: ApplyFundDistributionInput,
): Promise<{ eventId: string }> {
  const ctx = currentContext();
  if (!ctx.inTransaction) {
    throw new Error(
      'applyFundDistribution must run inside a transaction — the caller owns the transaction boundary',
    );
  }

  const event = await addFundDistribution({
    fundEntityId: input.companyId,
    investorId: input.fundId,
    distribution: {
      date: new Date(input.date),
      amount: input.amount,
      currency: input.currency as CurrencyIsoCode,
    },
  });

  await logFundingChange({
    legalEntityId: input.companyId,
    category: 'Add Distribution',
    description: `Added fund distribution of ${formatCurrency(input.amount, input.currency)}`,
    eventDate: input.date,
  });

  return { eventId: event.id };
}
