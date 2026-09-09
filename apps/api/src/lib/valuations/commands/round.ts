import { z } from 'zod';

import { ProfileService } from '../../../services/profiles/profile';
import { getQb, getValuationsQb } from '../../kysely';
import { currentContext } from '../../../services/context';
import { logFundingChange, formatCurrency } from '../../funding-changelog';
import { LegalEntityId } from '../../../generated/kysely/valuations/LegalEntity';
import { TeamId } from '../../../generated/kysely/core/Team';
import EventType from '../../../generated/kysely/valuations/EventType';
import EquityRoundType from '../../../generated/kysely/valuations/EquityRoundType';
import AssetType from '../../../generated/kysely/valuations/AssetType';
import ValuationType from '../../../generated/kysely/valuations/ValuationType';
import PriceType from '../../../generated/kysely/valuations/PriceType';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';

/**
 * `applyRound`'s input, exported as the single zod source of truth — both
 * the tRPC mutation (company.ts) and the REST command route
 * (interfaces/rest/v1/valuations/commands.ts) parse against this schema
 * rather than hand-duplicating the field list.
 */
const applyRoundInput = z.object({
  entity: z.string(),
  roundName: z.string(),
  date: z.string(),
  currency: z.nativeEnum(CurrencyIsoCode).optional(),
  pricePerShare: z.string().optional(),
  valuationAmount: z.string().optional(),
  valuationType: z.nativeEnum(ValuationType).optional(),
  totalRaisedAmount: z.string().optional(),
  coInvestors: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.enum(['NATURAL_PERSON', 'FUND']),
      }),
    )
    .optional(),
});

type ApplyRoundInput = z.infer<typeof applyRoundInput>;

/**
 * Resolves `'NEW'` co-investor sentinels in an `applyRound` input into real
 * ids, minting each via `ProfileService.create` (Prisma). Returns a COPY of
 * `input` with those sentinels replaced.
 *
 * Runs BEFORE `ctx.enterTransaction()` and is not itself wrapped in a
 * transaction: `enterTransaction()` opens two SEPARATE DB transactions
 * (Prisma + Kysely), so a `ProfileService.create` made inside the Kysely
 * bulk's transaction would be invisible to it. Letting these creates
 * auto-commit here — before the atomic bulk starts — is what makes the new
 * ids visible to `applyRound`.
 */
async function resolveRoundEntities(input: ApplyRoundInput): Promise<ApplyRoundInput> {
  const resolved = { ...input };

  if (resolved.coInvestors?.length) {
    const resolvedCoInvestors = [];
    for (const coInvestor of resolved.coInvestors) {
      if (coInvestor.id !== 'NEW') {
        resolvedCoInvestors.push(coInvestor);
        continue;
      }
      const newCoInvestor = await ProfileService.create({
        name: coInvestor.name,
        type: coInvestor.type,
        isPrivate: true,
      });

      if (!newCoInvestor?.id) {
        throw new Error('Failed to create co-investor entity');
      }
      resolvedCoInvestors.push({ ...coInvestor, id: newCoInvestor.id });
    }
    resolved.coInvestors = resolvedCoInvestors;
  }

  return resolved;
}

/**
 * Records a funding round against a company: gets-or-creates the
 * `INVESTMENT_ROUND` `event`, an optional price-per-share `Price` row, any
 * co-investor `investment` rows, and a `funding_changelog` audit entry.
 *
 * Assumes all ids are already real — `coInvestors[].id` must not be `'NEW'`.
 * The caller resolves those via `resolveRoundEntities` BEFORE opening the
 * transaction (see that function's doc comment for why).
 *
 * Everything here runs inside one transaction. The transaction boundary is
 * the CALLER's responsibility (`ctx.enterTransaction()` before invoking
 * this), not this service's — a reusable command must not leak a
 * transaction into whatever the caller does next.
 */
async function applyRound(input: ApplyRoundInput): Promise<{ eventId: string | null; priceId: string | null }> {
  const ctx = currentContext();
  if (!ctx.inTransaction) {
    throw new Error('applyRound must run inside a transaction — the caller owns the transaction boundary');
  }

  const {
    entity,
    date,
    currency,
    roundName,
    pricePerShare,
    valuationAmount,
    valuationType,
    totalRaisedAmount,
  } = input;
  const targetEntityId = entity;

  let eventId;
  let priceId: string | null = null;
  if (roundName) {
    const existing = await getValuationsQb(['event'])
      .selectFrom('event')
      .where('name', '=', roundName)
      .where('legal_entity_id', '=', targetEntityId as LegalEntityId)
      .where('date', '=', new Date(date))
      .where('type', '=', EventType.INVESTMENT_ROUND)
      .where('team_id', '=', ctx.user.teamId as TeamId)
      .select('id')
      .executeTakeFirst();

    if (existing) {
      eventId = existing.id;
    } else {
      // Create the investment round
      const event = await getValuationsQb(['event'])
        .insertInto('event')
        .values({
          legal_entity_id: targetEntityId as LegalEntityId,
          name: roundName,
          type: EventType.INVESTMENT_ROUND,
          date: new Date(date),
          team_id: ctx.user.teamId as TeamId,
          round_type: EquityRoundType.UNKNOWN,
          raised_amount: totalRaisedAmount ? parseFloat(totalRaisedAmount) : null,
          raised_currency: currency,
          valuation: valuationAmount ? parseFloat(valuationAmount) : null,
          valuation_currency: currency,
          valuation_type: valuationType || ValuationType.POST_MONEY, // Default to POST_MONEY as per memory
          asset_type: AssetType.UNKNOWN,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      eventId = event.id;
    }

    if (pricePerShare && currency) {
      // Create price record
      const createdPrice = await getValuationsQb(['price'])
        .insertInto('price')
        .values({
          team_id: ctx.user.teamId as TeamId,
          date: new Date(date),
          price: parseFloat(pricePerShare),
          currency: currency,
          legal_entity_id: targetEntityId as LegalEntityId,
          event_id: eventId,
          type: PriceType.FROM_PRICED_ROUND,
        })
        .returning(['id'])
        .executeTakeFirst();
      priceId = createdPrice?.id ?? null;
    }
  }

  // Handle co-investors if present — ids are already real (resolved above).
  if (input.coInvestors?.length) {
    for (const coInvestor of input.coInvestors) {
      await getValuationsQb(['investment'])
        .insertInto('investment')
        .values({
          investor_profile_id: coInvestor.id as LegalEntityId,
          investment_profile_id: targetEntityId as LegalEntityId,
          event_id: eventId,
          team_id: ctx.user.teamId as TeamId,
        })
        .execute();
    }
  }

  const headline = `Added round: ${roundName}`;
  const roundDetails: string[] = [];
  if (totalRaisedAmount && currency) roundDetails.push(`Raised: ${formatCurrency(totalRaisedAmount, currency)}`);
  if (valuationAmount && currency) roundDetails.push(`Valuation: ${formatCurrency(valuationAmount, currency)} ${valuationType === 'PRE_MONEY' ? 'pre-money' : 'post-money'}`);
  if (pricePerShare && currency) roundDetails.push(`Price/share: ${formatCurrency(pricePerShare, currency)}`);
  if (input.coInvestors?.length) roundDetails.push(`Co-investors: ${input.coInvestors.map((c) => c.name).join(', ')}`);
  await logFundingChange({
    legalEntityId: targetEntityId,
    category: 'Add Round',
    description: roundDetails.length > 0 ? `${headline}\n${roundDetails.join('\n')}` : headline,
    eventDate: date,
  });

  return { eventId: eventId ?? null, priceId };
}

export { applyRound, applyRoundInput, resolveRoundEntities };
export type { ApplyRoundInput };
