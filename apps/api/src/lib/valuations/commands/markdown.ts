import * as db from '@prisma/client';

import { currentContext } from '../../../services/context';
import { getQb, getValuationsQb } from '../../kysely';
import { logFundingChange } from '../../funding-changelog';
import { notNull } from '../../utils/nullability';
import AssetType from '../../../generated/kysely/valuations/AssetType';
import PriceType from '../../../generated/kysely/valuations/PriceType';
import { LegalEntityId } from '../../../generated/kysely/valuations/LegalEntity';
import { TeamId } from '../../../generated/kysely/core/Team';

/**
 * Records a markdown against a company: a `MARKDOWN` event (optionally with
 * a note), plus derived `FROM_ASSET_HOLDER` prices for the company's equity
 * and every convertible, each written as `priorPrice * (1 - percentage/100)`.
 *
 * Everything — the reads that find the prior prices and the writes that
 * record the event/note/prices — runs inside one transaction, so a failure
 * partway through leaves no partial markdown. The transaction boundary is
 * the CALLER's responsibility (`ctx.enterTransaction()` before invoking
 * this), not this service's — a reusable command must not leak a
 * transaction into whatever the caller does next.
 */
async function applyMarkdown(input: {
  companyId: string;
  date: string;
  percentage: number;
  note?: string;
}): Promise<{ eventId: string; priceIds: string[] }> {
  const ctx = currentContext();
  if (!ctx.inTransaction) {
    throw new Error('applyMarkdown must run inside a transaction — the caller owns the transaction boundary');
  }

  const event = await ctx.prisma.event.create({
    data: {
      date: new Date(input.date),
      name: 'Markdown',
      type: db.EventType.MARKDOWN,
      legalEntityId: input.companyId,
      teamId: ctx.user.teamId,
      data: { percentage: input.percentage },
    },
  });

  if (input.note) {
    await ctx.prisma.note.create({
      data: {
        message: input.note,
        referenceId: event.id,
        createdBy: ctx.user.id,
        teamId: ctx.user.teamId,
        noteType: 'EVENT',
      },
    });
  }

  const allEntityAssets = await getValuationsQb(['asset'])
    .selectFrom('asset')
    .select('id')
    .where('type', '=', AssetType.EQUITY)
    .where('issued_by_legal_entity_id', '=', input.companyId as LegalEntityId)
    .execute();

  const assetIds = allEntityAssets.map((a) => a.id);

  const [equityPrice, convertibles] = await Promise.all([
    getValuationsQb(['price'])
      .selectFrom('price')
      .select(['asset_id', 'price', 'currency', 'date'])
      .where(($) =>
        $.and([
          $('price.team_id', '=', ctx.user.teamId as TeamId),
          $('price.type', '=', PriceType.FROM_PRICED_ROUND),
        ]),
      )
      .where(($) =>
        $.or(
          [
            assetIds.length > 0 ? $.and([$('price.asset_id', 'in', assetIds)]) : null,
            $.and([
              $('price.asset_id', 'is', null),
              $('legal_entity_id', '=', input.companyId as LegalEntityId),
            ]),
          ].filter(notNull),
        ),
      )
      .orderBy('price.date', 'desc')
      .limit(1)
      .executeTakeFirst(),
    getValuationsQb(['asset'])
      .selectFrom('asset as a')
      .select(['a.id as asset_id', 'a.convertible_amount', 'a.convertible_currency'])
      .where(($) =>
        $.and([
          $('a.team_id', '=', ctx.user.teamId as TeamId),
          $('a.issued_by_legal_entity_id', '=', input.companyId as LegalEntityId),
          $('a.type', '=', AssetType.CONVERTIBLE),
        ]),
      )
      .execute(),
  ]);

  const priceIds: string[] = [];

  if (equityPrice?.price && equityPrice?.currency) {
    const price = await ctx.prisma.price.create({
      data: {
        legalEntityId: input.companyId,
        price: equityPrice.price * (1 - input.percentage / 100),
        currency: equityPrice.currency,
        date: new Date(input.date),
        teamId: ctx.user.teamId,
        eventId: event.id,
        type: db.PriceType.FROM_ASSET_HOLDER,
      },
    });
    priceIds.push(price.id);
  }

  const convertiblePricePromises = [];
  for (const convertible of convertibles) {
    if (convertible.convertible_amount && convertible.convertible_currency) {
      convertiblePricePromises.push(
        ctx.prisma.price.create({
          data: {
            legalEntityId: input.companyId,
            assetId: convertible.asset_id,
            price: convertible.convertible_amount * (1 - input.percentage / 100),
            currency: convertible.convertible_currency,
            date: new Date(input.date),
            teamId: ctx.user.teamId,
            eventId: event.id,
            type: db.PriceType.FROM_ASSET_HOLDER,
          },
        }),
      );
    }
  }

  if (convertiblePricePromises.length > 0) {
    const convertiblePrices = await Promise.all(convertiblePricePromises);
    priceIds.push(...convertiblePrices.map((p) => p.id));
  }

  const headline = `Added markdown of ${input.percentage}%`;
  const details = input.note ? `${headline}\nNote: ${input.note}` : headline;
  await logFundingChange({
    legalEntityId: input.companyId,
    category: 'Add Markdown',
    description: details,
    eventDate: input.date,
  });

  return { eventId: event.id, priceIds };
}

export { applyMarkdown };
