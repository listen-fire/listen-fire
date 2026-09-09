import { z } from 'zod';

import { currentContext } from '../../../services/context';
import { logFundingChange, formatCurrency } from '../../funding-changelog';
import PriceType from '../../../generated/kysely/valuations/PriceType';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';

/**
 * `applyPrice`'s input, exported as the single zod source of truth — both
 * the tRPC mutation (company.ts) and the REST command route
 * (interfaces/rest/v1/valuations/commands.ts) parse against this schema
 * rather than hand-duplicating the field list.
 */
const applyPriceInput = z.object({
  companyId: z.string(),
  assetId: z.string().optional(),
  price: z.number(),
  currency: z.nativeEnum(CurrencyIsoCode),
  date: z.string().optional(),
  note: z.string().optional(),
});

type ApplyPriceInput = z.infer<typeof applyPriceInput>;

/**
 * Records a price point against a company: a `Price` row (optionally with a
 * note), plus a `funding_changelog` audit entry.
 *
 * Everything runs inside one transaction. The transaction boundary is the
 * CALLER's responsibility (`ctx.enterTransaction()` before invoking this),
 * not this service's — a reusable command must not leak a transaction into
 * whatever the caller does next.
 */
async function applyPrice(input: ApplyPriceInput): Promise<{ priceId: string }> {
  const ctx = currentContext();
  if (!ctx.inTransaction) {
    throw new Error('applyPrice must run inside a transaction — the caller owns the transaction boundary');
  }

  const { companyId, price, currency, date, assetId } = input;
  const newPrice = await ctx.prisma.price.create({
    data: {
      assetId,
      teamId: ctx.user.teamId,
      date: date ? new Date(date) : new Date(),
      price: price,
      currency: currency,
      legalEntityId: companyId,
      type: PriceType.FROM_PRICED_ROUND,
    },
  });

  if (input.note) {
    await ctx.prisma.note.create({
      data: {
        message: input.note,
        referenceId: newPrice.id,
        teamId: ctx.user.teamId,
        createdBy: ctx.user.id,
        noteType: 'PRICE',
      },
    });
  }

  const priceHeadline = `Added price of ${formatCurrency(price, currency)}`;
  const priceDetails: string[] = [];
  if (input.note) priceDetails.push(`Note: ${input.note}`);
  await logFundingChange({
    legalEntityId: companyId,
    category: 'Add Price',
    description: priceDetails.length > 0 ? `${priceHeadline}\n${priceDetails.join('\n')}` : priceHeadline,
    eventDate: date,
  });

  return { priceId: newPrice.id };
}

export { applyPrice, applyPriceInput };
export type { ApplyPriceInput };
