import { currentContext } from '../../services/context';
import { getQb, getValuationsQb } from '../kysely';
import AssetType from '../../generated/kysely/valuations/AssetType';
import PriceType from '../../generated/kysely/valuations/PriceType';
import { TeamId } from '../../generated/kysely/core/Team';
import { LegalEntityId } from '../../generated/kysely/valuations/LegalEntity';
import { TransactionId } from '../../generated/kysely/valuations/Transaction';
import { EventId } from '../../generated/kysely/valuations/Event';
import CurrencyIsoCode from '../../generated/kysely/valuations/CurrencyIsoCode';
import ConvertibleType from '../../generated/kysely/valuations/ConvertibleType';

async function addConvertibleAssetTransferAndPrice({
  investingEntity,
  targetEntityId,
  eventId,
  investmentDate,
  investmentAmount,
  investmentCurrency,
  transactionId,
  convertibleName,
  convertibleType,
  convertibleValuationCap,
  convertibleDiscountRate,
  convertibleInterestRate,
  convertibleMaturityDate,
}: {
  investingEntity: string;
  targetEntityId: string;
  eventId?: string | null;
  investmentDate: Date;
  investmentAmount: number;
  investmentCurrency: CurrencyIsoCode;
  transactionId: string;
  convertibleName: string;
  convertibleType: ConvertibleType;
  convertibleValuationCap?: number;
  convertibleDiscountRate?: number;
  convertibleInterestRate?: number;
  convertibleMaturityDate?: Date;
}) {
  const ctx = currentContext();
  const asset = await getValuationsQb(['asset'])
    .insertInto('asset')
    .values({
      team_id: ctx.user.teamId as TeamId,
      issued_by_legal_entity_id: targetEntityId as LegalEntityId,
      name: convertibleName,
      type: AssetType.CONVERTIBLE,
      properties: {},
      convertible_type: convertibleType,
      valuation_cap: convertibleValuationCap,
      discount_rate: convertibleDiscountRate,
      annualised_interest_rate: convertibleInterestRate,
      maturity_date: convertibleMaturityDate,
      interest: convertibleInterestRate,
      issued_at: investmentDate,
      convertible_investor_id: investingEntity as LegalEntityId,
      convertible_amount: investmentAmount,
      convertible_currency: investmentCurrency,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  await getValuationsQb(['asset_transfer'])
    .insertInto('asset_transfer')
    .values({
      team_id: ctx.user.teamId as TeamId,
      asset_id: asset.id,
      date: investmentDate,
      from_legal_entity_id: targetEntityId as LegalEntityId,
      to_legal_entity_id: investingEntity as LegalEntityId,
      num_assets: 1,
      transaction_id: transactionId as TransactionId,
    })
    .execute();

  await getValuationsQb(['price'])
    .insertInto('price')
    .values({
      team_id: ctx.user.teamId as TeamId,
      date: investmentDate,
      price: investmentAmount,
      currency: investmentCurrency,
      asset_id: asset.id,
      event_id: eventId as EventId,
      type: PriceType.FROM_PRICED_ROUND,
    })
    .execute();
}

export { addConvertibleAssetTransferAndPrice };
