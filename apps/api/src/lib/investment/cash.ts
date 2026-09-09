import { currentContext } from '../../services/context';
import { getQb, getValuationsQb } from '../kysely';
import { TeamId } from '../../generated/kysely/core/Team';
import { LegalEntityId } from '../../generated/kysely/valuations/LegalEntity';
import { TransactionId } from '../../generated/kysely/valuations/Transaction';
import CurrencyIsoCode from '../../generated/kysely/valuations/CurrencyIsoCode';

async function addCashFlow({
  from,
  to,
  date,
  currency,
  amount,
  transactionId,
}: {
  from: string;
  to: string;
  date: Date;
  currency: CurrencyIsoCode;
  amount: number;
  transactionId: string;
}) {
  const ctx = currentContext();

  const currencyAsset = await getValuationsQb(['asset', 'currency_asset'])
    .selectFrom('currency_asset')
    .innerJoin('asset', 'asset.id', 'currency_asset.asset_id')
    .where('iso_code', '=', currency)
    .select('asset.id')
    .executeTakeFirstOrThrow();

  await getValuationsQb(['asset_transfer'])
    .insertInto('asset_transfer')
    .values({
      team_id: ctx.user.teamId as TeamId,
      asset_id: currencyAsset.id,
      date,
      from_legal_entity_id: from as LegalEntityId,
      to_legal_entity_id: to as LegalEntityId,
      num_assets: amount,
      transaction_id: transactionId as TransactionId,
    })
    .execute();
}

export { addCashFlow };
