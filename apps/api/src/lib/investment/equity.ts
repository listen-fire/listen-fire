import { currentContext } from '../../services/context';
import { getQb, getValuationsQb } from '../kysely';
import AssetType from '../../generated/kysely/valuations/AssetType';
import { TeamId } from '../../generated/kysely/core/Team';
import { LegalEntityId } from '../../generated/kysely/valuations/LegalEntity';
import { TransactionId } from '../../generated/kysely/valuations/Transaction';
import { EventId } from '../../generated/kysely/valuations/Event';
import CurrencyIsoCode from '../../generated/kysely/valuations/CurrencyIsoCode';
import PriceType from '../../generated/kysely/valuations/PriceType';

async function getOrCreateEquityAsset({
  targetEntityId,
  shareClass,
}: {
  targetEntityId: string;
  shareClass?: string;
}) {
  const ctx = currentContext();

  let equityAsset = await getValuationsQb(['asset'])
    .selectFrom('asset')
    .where('name', '=', shareClass || 'Ordinary shares')
    .where('type', '=', AssetType.EQUITY)
    .where('issued_by_legal_entity_id', '=', targetEntityId as LegalEntityId)
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

  return equityAsset;
}

async function addEquityTransferAndPrice({
  investingEntity,
  targetEntityId,
  investmentDate,
  numberOfShares,
  pricePerShare,
  pricePerShareCurrency,
  investmentCurrency,
  eventId,
  transactionId,
  shareClass,
}: {
  investingEntity: string;
  targetEntityId: string;
  investmentDate: Date;
  numberOfShares: number;
  pricePerShare?: number;
  pricePerShareCurrency?: CurrencyIsoCode;
  investmentCurrency: CurrencyIsoCode;
  eventId?: string;
  transactionId: string;
  shareClass?: string;
}) {
  const ctx = currentContext();

  const equityAsset = await getOrCreateEquityAsset({ targetEntityId, shareClass });

  // Create equity asset transfer
  await getValuationsQb(['asset_transfer'])
    .insertInto('asset_transfer')
    .values({
      team_id: ctx.user.teamId as TeamId,
      asset_id: equityAsset.id,
      date: investmentDate,
      from_legal_entity_id: targetEntityId as LegalEntityId,
      to_legal_entity_id: investingEntity as LegalEntityId,
      num_assets: numberOfShares,
      transaction_id: transactionId as TransactionId,
    })
    .execute();

  if (pricePerShare) {
    const existingEquityPrice = await getValuationsQb(['price'])
      .selectFrom('price')
      .where('legal_entity_id', '=', targetEntityId as LegalEntityId)
      .where('date', '=', investmentDate)
      .where('team_id', '=', ctx.user.teamId as TeamId)
      .where('type', '=', PriceType.FROM_PRICED_ROUND)
      .select('id')
      .executeTakeFirst();
    const existingAssetPrice = await getValuationsQb(['price'])
      .selectFrom('price')
      .where('asset_id', '=', equityAsset.id)
      .where('date', '=', investmentDate)
      .where('team_id', '=', ctx.user.teamId as TeamId)
      .where('type', '=', PriceType.FROM_PRICED_ROUND)
      .select('id')
      .executeTakeFirst();

    // Create price record
    if (!existingEquityPrice && !existingAssetPrice) {
      await getValuationsQb(['price'])
        .insertInto('price')
        .values({
          team_id: ctx.user.teamId as TeamId,
          date: investmentDate,
          price: pricePerShare,
          currency: pricePerShareCurrency || investmentCurrency,
          legal_entity_id: targetEntityId as LegalEntityId,
          event_id: eventId as EventId,
          type: PriceType.FROM_PRICED_ROUND,
        })
        .execute();
    }
  }
}

export { addEquityTransferAndPrice };
