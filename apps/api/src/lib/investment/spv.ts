import { currentContext } from '../../services/context';
import { getQb, getValuationsQb } from '../kysely';
import CurrencyIsoCode from '../../generated/kysely/valuations/CurrencyIsoCode';
import AssetType from '../../generated/kysely/valuations/AssetType';
import PriceType from '../../generated/kysely/valuations/PriceType';
import { LegalEntityId } from '../../generated/kysely/valuations/LegalEntity';
import { TeamId } from '../../generated/kysely/core/Team';
import { EventId } from '../../generated/kysely/valuations/Event';
import { TransactionId } from '../../generated/kysely/valuations/Transaction';

async function addSpvAssetTransferAndPrice({
  spvEntityId,
  targetEntityId,
  investingEntity,
  transactionId,
  eventId,
  spvName = 'Unknown',
  investmentDate,
  investmentAmount,
  investmentCurrency,
}: {
  spvEntityId: string;
  targetEntityId: string;
  investingEntity: string;
  transactionId: string;
  eventId?: string | null;
  spvName?: string;
  investmentDate: Date;
  investmentAmount: number;
  investmentCurrency: CurrencyIsoCode;
}) {
  const ctx = currentContext();
  const asset = await getValuationsQb(['asset'])
    .insertInto('asset')
    .values({
      team_id: ctx.user.teamId as TeamId,
      issued_by_legal_entity_id: spvEntityId as LegalEntityId,
      name: spvName + ' SPV Interest',
      type: AssetType.SPV_INTEREST_POINT,
      properties: {
        spv_investment_date: investmentDate,
        spv_investment_target_asset_type: 'EQUITY_UNKNOWN_SHARES',
        spv_investment_target_company_id: targetEntityId,
      },
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  await getValuationsQb(['asset_transfer'])
    .insertInto('asset_transfer')
    .values({
      team_id: ctx.user.teamId as TeamId,
      asset_id: asset.id,
      date: investmentDate,
      from_legal_entity_id: spvEntityId as LegalEntityId,
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

export { addSpvAssetTransferAndPrice };
