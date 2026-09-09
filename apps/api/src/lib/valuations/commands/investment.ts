import { z } from 'zod';

import { ProfileService } from '../../../services/profiles/profile';
import { getQb, getValuationsQb } from '../../kysely';
import { currentContext } from '../../../services/context';
import { addFundInvestmentAssetTransfers } from '../../investment/fund';
import { getOrCreateEvent } from '../../investment/round';
import { addCashFlow } from '../../investment/cash';
import { addInvestmentAndTransaction } from '../../investment';
import { addEquityTransferAndPrice } from '../../investment/equity';
import { addConvertibleAssetTransferAndPrice } from '../../investment/convertible';
import { addSpvAssetTransferAndPrice } from '../../investment/spv';
import { addSecondaryAssetTransferAndPrice } from '../../investment/secondary';
import { logFundingChange, formatCurrency } from '../../funding-changelog';
import { LegalEntityId } from '../../../generated/kysely/valuations/LegalEntity';
import { TeamId } from '../../../generated/kysely/core/Team';
import AssetType from '../../../generated/kysely/valuations/AssetType';
import LegalEntityType from '../../../generated/kysely/valuations/LegalEntityType';
import ConvertibleType from '../../../generated/kysely/valuations/ConvertibleType';
import ValuationType from '../../../generated/kysely/valuations/ValuationType';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';

/**
 * `applyInvestment`'s input, exported as the single zod source of truth —
 * both the tRPC mutation (company.ts) and the REST command route
 * (interfaces/rest/v1/valuations/commands.ts) parse against this schema
 * rather than hand-duplicating the field list.
 */
const applyInvestmentInput = z.object({
  entity: z.string(),
  entityName: z.string().optional(),
  entityType: z.nativeEnum(LegalEntityType).optional(),
  entityWebsite: z.string().optional(),
  investingEntity: z.string(),
  investingEntityName: z.string(),
  roundName: z.string().optional(),
  investmentDate: z.string(),
  investmentAmount: z.string(),
  investmentCurrency: z.nativeEnum(CurrencyIsoCode),
  investmentType: z.enum(['EQUITY', 'CONVERTIBLE', 'SPV', 'SECONDARY']).optional(),
  // Fund details
  committedAmount: z.string().optional(),
  committedCurrency: z.nativeEnum(CurrencyIsoCode).optional(),
  // Equity details
  pricePerShare: z.string().optional(),
  pricePerShareCurrency: z.nativeEnum(CurrencyIsoCode).optional(),
  numberOfShares: z.string().optional(),
  shareClass: z.string().optional(),
  valuationAmount: z.string().optional(),
  valuationType: z.nativeEnum(ValuationType).optional(),
  valuationCurrency: z.nativeEnum(CurrencyIsoCode).optional(),
  totalRaisedAmount: z.string().optional(),
  totalRaisedCurrency: z.nativeEnum(CurrencyIsoCode).optional(),
  // Convertible details
  convertibleType: z.nativeEnum(ConvertibleType).optional(),
  convertibleName: z.string().optional(),
  convertibleValuationCap: z.number().optional(),
  convertibleMaturityDate: z.string().optional(),
  convertibleInterestRate: z.number().optional(),
  convertibleDiscountRate: z.number().optional(),
  // SPV details
  spv: z.string().optional(),
  spvName: z.string().optional(),
  // Secondary details (price/shares/class as above)
  seller: z.string().optional(),
  sellerName: z.string().optional(),
  // Co-investor details
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

type ApplyInvestmentInput = z.infer<typeof applyInvestmentInput>;

/**
 * Resolves the `'NEW'` entity/SPV/seller/co-investor sentinels in an
 * `applyInvestment` input into real ids, minting each via
 * `ProfileService.create` (Prisma). Returns a COPY of `input` with those
 * sentinels replaced.
 *
 * Runs BEFORE `ctx.enterTransaction()` and is not itself wrapped in a
 * transaction: `enterTransaction()` opens two SEPARATE DB transactions
 * (Prisma + Kysely), so a `ProfileService.create` made inside the Kysely
 * bulk's transaction would be invisible to it. Letting these creates
 * auto-commit here — before the atomic bulk starts — is what makes the new
 * ids visible to `applyInvestment`.
 */
async function resolveInvestmentEntities(input: ApplyInvestmentInput): Promise<ApplyInvestmentInput> {
  const resolved = { ...input };

  if (resolved.entity === 'NEW' && resolved.entityName) {
    const newEntity = await ProfileService.create({
      name: resolved.entityName,
      type: resolved.entityType ?? 'COMPANY',
      personalWebsite: resolved.entityWebsite,
      isPrivate: true,
    });

    if (!newEntity?.id) {
      throw new Error('Failed to create new entity');
    }
    resolved.entity = newEntity.id;
  }

  if (resolved.spv === 'NEW' && resolved.spvName) {
    const newEntity = await ProfileService.create({
      name: resolved.spvName,
      type: 'SPV',
      isPrivate: true,
    });

    if (!newEntity?.id) {
      throw new Error('Failed to create SPV entity');
    }
    resolved.spv = newEntity.id;
  }

  if (resolved.seller === 'NEW' && resolved.sellerName) {
    // TODO: find existing here? Require email or domain?
    const newEntity = await ProfileService.create({
      name: resolved.sellerName,
      type: 'COMPANY', // TODO: a person or a fund?
      isPrivate: true,
    });

    if (!newEntity?.id) {
      throw new Error('Failed to create seller entity');
    }
    resolved.seller = newEntity.id;
  }

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
 * Records a new investment against a company: the investing entity's cash
 * flow into the target, the containing `investment`/`transaction` pair, an
 * optional round `event`, the type-specific asset transfer + price
 * (EQUITY/CONVERTIBLE/SPV/SECONDARY, or a fund's committed-capital
 * transfers), and any co-investor `investment` rows.
 *
 * Assumes all ids are already real — `entity`/`spv`/`seller`/
 * `coInvestors[].id` must not be `'NEW'`. The caller resolves those via
 * `resolveInvestmentEntities` BEFORE opening the transaction (see that
 * function's doc comment for why).
 *
 * Everything here runs inside one transaction, so a failure partway through
 * (e.g. the type-specific transfer after the cash flow) leaves no partial
 * investment. The transaction boundary is the CALLER's responsibility
 * (`ctx.enterTransaction()` before invoking this), not this service's — a
 * reusable command must not leak a transaction into whatever the caller
 * does next.
 */
async function applyInvestment(
  input: ApplyInvestmentInput,
): Promise<{ investmentId: string; eventId: string | null; transactionId: string }> {
  const ctx = currentContext();
  if (!ctx.inTransaction) {
    throw new Error('applyInvestment must run inside a transaction — the caller owns the transaction boundary');
  }

  const {
    entity,
    entityName,
    entityType,
    entityWebsite,
    investingEntity,
    investingEntityName,
    roundName,
    investmentDate,
    investmentAmount,
    investmentCurrency,
    investmentType,
    committedAmount,
    committedCurrency,
    pricePerShare,
    pricePerShareCurrency,
    numberOfShares,
    shareClass,
    valuationAmount,
    valuationType,
    valuationCurrency,
    totalRaisedAmount,
    totalRaisedCurrency,
    convertibleType,
    convertibleName,
    convertibleValuationCap,
    convertibleMaturityDate,
    convertibleInterestRate,
    convertibleDiscountRate,
    spv,
    spvName,
    seller,
    sellerName,
  } = input;

  // Entity/SPV/seller ids are already real — resolveInvestmentEntities
  // (the caller, before the transaction) has resolved any 'NEW' sentinels.
  const targetEntityId = entity;
  const spvEntityId = spv;
  const sellerEntityId = seller;

  // Handle event creation
  const event = roundName
    ? await getOrCreateEvent({
        targetEntityId,
        roundName,
        investmentDate,
        investmentCurrency,
        totalRaisedAmount: totalRaisedAmount ? parseFloat(totalRaisedAmount) : null,
        totalRaisedCurrency,
        valuationAmount: valuationAmount ? parseFloat(valuationAmount) : null,
        valuationCurrency,
        valuationType,
        investmentType:
          investmentType === 'EQUITY' || investmentType === 'CONVERTIBLE'
            ? (investmentType as AssetType)
            : undefined,
      })
    : null;
  const eventId = event?.id;

  // Add containing investment and transaction
  const { investment, transaction } = await addInvestmentAndTransaction({
    investingEntity,
    targetEntityId,
    investmentDate: new Date(investmentDate),
    eventId,
  });

  // Add the cash given to the investment target
  await addCashFlow({
    from: investingEntity,
    to: targetEntityId,
    date: new Date(investmentDate),
    amount: parseFloat(investmentAmount),
    currency: investmentCurrency,
    transactionId: transaction.id,
  });

  // Collect common parameters for the investment
  const params = {
    investingEntity,
    targetEntityId,
    investmentDate: new Date(investmentDate),
    eventId,
    transactionId: transaction.id,
    investmentAmount: parseFloat(investmentAmount),
    investmentCurrency,
  };

  if (entityType === 'FUND') {
    await addFundInvestmentAssetTransfers({
      ...params,
      committedAmount: committedAmount ? parseFloat(committedAmount) : null,
      committedCurrency,
    });
  } else if (investmentType === 'EQUITY' && numberOfShares) {
    await addEquityTransferAndPrice({
      ...params,
      numberOfShares: parseFloat(numberOfShares),
      pricePerShare: pricePerShare ? parseFloat(pricePerShare) : undefined,
      pricePerShareCurrency,
      shareClass,
    });
  } else if (investmentType === 'CONVERTIBLE' && convertibleType && convertibleName) {
    await addConvertibleAssetTransferAndPrice({
      ...params,
      convertibleName,
      convertibleType,
      convertibleValuationCap,
      convertibleDiscountRate,
      convertibleInterestRate,
      convertibleMaturityDate: convertibleMaturityDate
        ? new Date(convertibleMaturityDate)
        : undefined,
    });
  } else if (investmentType === 'SPV' && spvEntityId) {
    await addSpvAssetTransferAndPrice({
      ...params,
      spvEntityId,
      spvName,
    });
  } else if (investmentType === 'SECONDARY' && sellerEntityId && numberOfShares) {
    await addSecondaryAssetTransferAndPrice({
      ...params,
      numberOfShares: parseFloat(numberOfShares),
      pricePerShare: pricePerShare ? parseFloat(pricePerShare) : undefined,
      pricePerShareCurrency,
      shareClass,
      sellerEntityId,
    });
  }
  // If type-specific fields are incomplete (e.g. "Save and add details later"),
  // the investment and cash flow are still created — details can be added later.

  // Handle co-investors if present — ids are already real (resolved above).
  if (input.coInvestors?.length) {
    for (const coInvestor of input.coInvestors) {
      await getValuationsQb(['investment'])
        .insertInto('investment')
        .values({
          investor_profile_id: coInvestor.id as LegalEntityId,
          investment_profile_id: targetEntityId as LegalEntityId,
          invested_at: new Date(investmentDate),
          event_id: eventId,
          team_id: ctx.user.teamId as TeamId,
        })
        .execute();
    }
  }

  const typeLabel = investmentType ? investmentType.toLowerCase() : 'investment';
  const roundLabel = roundName ? ` in ${roundName}` : '';
  const headline = `Added ${typeLabel} of ${formatCurrency(investmentAmount, investmentCurrency)}${roundLabel}`;
  const details: string[] = [];
  details.push(`Investor: ${investingEntityName}`);
  if (investmentType === 'EQUITY') {
    if (numberOfShares) details.push(`Shares: ${numberOfShares}${shareClass ? ` (${shareClass})` : ''}`);
    if (pricePerShare && pricePerShareCurrency) details.push(`Price/share: ${formatCurrency(pricePerShare, pricePerShareCurrency)}`);
    if (valuationAmount && valuationCurrency) details.push(`Valuation: ${formatCurrency(valuationAmount, valuationCurrency)} ${valuationType === 'PRE_MONEY' ? 'pre-money' : 'post-money'}`);
    if (totalRaisedAmount && totalRaisedCurrency) details.push(`Total raised: ${formatCurrency(totalRaisedAmount, totalRaisedCurrency)}`);
  } else if (investmentType === 'CONVERTIBLE') {
    if (convertibleName) details.push(`Note: ${convertibleName}${convertibleType ? ` (${convertibleType.toLowerCase()})` : ''}`);
    if (convertibleValuationCap) details.push(`Valuation cap: ${formatCurrency(convertibleValuationCap, investmentCurrency)}`);
    if (convertibleDiscountRate) details.push(`Discount: ${convertibleDiscountRate}%`);
    if (convertibleInterestRate) details.push(`Interest: ${convertibleInterestRate}%`);
    if (convertibleMaturityDate) details.push(`Maturity: ${convertibleMaturityDate}`);
  } else if (investmentType === 'SPV') {
    if (spvName) details.push(`SPV: ${spvName}`);
  } else if (investmentType === 'SECONDARY') {
    if (sellerName) details.push(`Seller: ${sellerName}`);
    if (numberOfShares) details.push(`Shares: ${numberOfShares}${shareClass ? ` (${shareClass})` : ''}`);
    if (pricePerShare && pricePerShareCurrency) details.push(`Price/share: ${formatCurrency(pricePerShare, pricePerShareCurrency)}`);
  }
  if (input.coInvestors?.length) details.push(`Co-investors: ${input.coInvestors.map((c) => c.name).join(', ')}`);
  await logFundingChange({
    legalEntityId: targetEntityId,
    category: 'Add Investment',
    description: details.length > 0 ? `${headline}\n${details.join('\n')}` : headline,
    eventDate: investmentDate,
  });

  return { investmentId: investment.id, eventId: eventId ?? null, transactionId: transaction.id };
}

export { applyInvestment, applyInvestmentInput, resolveInvestmentEntities };
export type { ApplyInvestmentInput };
