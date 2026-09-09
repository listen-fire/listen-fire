import { getQb, getValuationsQb } from '../kysely';
import { currentContext } from '../../services/context';
import CurrencyIsoCode from '../../generated/kysely/valuations/CurrencyIsoCode';
import AssetType from '../../generated/kysely/valuations/AssetType';
import PriceType from '../../generated/kysely/valuations/PriceType';
import { LegalEntityId } from '../../generated/kysely/valuations/LegalEntity';
import { TeamId } from '../../generated/kysely/core/Team';
import { EventId } from '../../generated/kysely/valuations/Event';
import { TransactionId } from '../../generated/kysely/valuations/Transaction';

async function addSecondaryAssetTransferAndPrice({
  investingEntity,
  targetEntityId,
  sellerEntityId,
  eventId,
  transactionId,
  investmentDate,
  numberOfShares,
  pricePerShare,
  pricePerShareCurrency,
  investmentCurrency,
  shareClass,
}: {
  investingEntity: string;
  targetEntityId: string;
  sellerEntityId: string;
  eventId?: string | null;
  transactionId: string;
  investmentDate: Date;
  numberOfShares: number;
  pricePerShare?: number;
  pricePerShareCurrency?: CurrencyIsoCode;
  investmentCurrency: CurrencyIsoCode;
  shareClass?: string;
}) {
  const ctx = currentContext();

  // like equity but transferred to the seller instead
  let equityAsset = await getValuationsQb(['asset'])
    .selectFrom('asset')
    .where('name', '=', shareClass || 'Ordinary shares')
    .where('type', '=', AssetType.EQUITY)
    .where('issued_by_legal_entity_id', '=', targetEntityId as LegalEntityId)
    .where('team_id', '=', ctx.user.teamId as TeamId)
    .select('id')
    .executeTakeFirst();

  if (!equityAsset) {
    equityAsset = await getValuationsQb(['asset'])
      .insertInto('asset')
      .values({
        team_id: ctx.user.teamId as TeamId,
        issued_by_legal_entity_id: targetEntityId as LegalEntityId,
        name: shareClass || 'Ordinary shares',
        type: AssetType.EQUITY,
        properties: {},
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();
  }

  // Create equity asset transfer
  await getValuationsQb(['asset_transfer'])
    .insertInto('asset_transfer')
    .values({
      team_id: ctx.user.teamId as TeamId,
      asset_id: equityAsset.id,
      date: investmentDate,
      from_legal_entity_id: sellerEntityId as LegalEntityId,
      to_legal_entity_id: investingEntity as LegalEntityId,
      num_assets: numberOfShares,
      transaction_id: transactionId as TransactionId,
    })
    .execute();

  if (pricePerShare) {
    if (pricePerShare) {
      const existingPrice = await getValuationsQb(['price'])
        .selectFrom('price')
        .where('asset_id', '=', equityAsset.id)
        .where('date', '=', investmentDate)
        .where('team_id', '=', ctx.user.teamId as TeamId)
        .where('type', '=', PriceType.FROM_PRICED_ROUND)
        .select('id')
        .executeTakeFirst();
      // Create price record
      if (!existingPrice) {
        await getValuationsQb(['price'])
          .insertInto('price')
          .values({
            team_id: ctx.user.teamId as TeamId,
            date: investmentDate,
            price: pricePerShare,
            currency: pricePerShareCurrency || investmentCurrency,
            asset_id: equityAsset.id,
            event_id: eventId as EventId,
            type: PriceType.FROM_PRICED_ROUND,
          })
          .execute();
      }
    }
  }
}

export { addSecondaryAssetTransferAndPrice };
