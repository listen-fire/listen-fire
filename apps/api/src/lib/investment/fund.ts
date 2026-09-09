import { formatDate } from 'date-fns';

import PriceType from '../../generated/kysely/valuations/PriceType';
import { getQb, getValuationsQb } from '../kysely';
import { currentContext } from '../../services/context';
import AssetType from '../../generated/kysely/valuations/AssetType';
import CurrencyIsoCode from '../../generated/kysely/valuations/CurrencyIsoCode';
import { LegalEntityId } from '../../generated/kysely/valuations/LegalEntity';
import { TeamId } from '../../generated/kysely/core/Team';
import { TransactionId } from '../../generated/kysely/valuations/Transaction';

async function addFundInvestmentAssetTransfers({
  investingEntity,
  targetEntityId,
  investmentDate,
  investmentCurrency,
  investmentAmount,
  committedCurrency,
  committedAmount,
  transactionId,
}: {
  investingEntity: string;
  targetEntityId: string;
  investmentDate: Date;
  investmentCurrency: CurrencyIsoCode;
  investmentAmount: number;
  committedCurrency?: CurrencyIsoCode | null;
  committedAmount?: number | null;
  transactionId: string;
}) {
  await addLpInterestPoint({
    from: targetEntityId,
    to: investingEntity,
    date: investmentDate,
    amount: investmentAmount,
    currency: investmentCurrency,
    transactionId,
  });

  const outstandingCommitmentAmount = committedAmount ? committedAmount - investmentAmount : null;

  if (outstandingCommitmentAmount && outstandingCommitmentAmount > 0 && committedCurrency) {
    await addOutstandingCommittment({
      investingEntity,
      targetEntityId,
      date: investmentDate,
      amount: outstandingCommitmentAmount,
      currency: committedCurrency,
      transactionId,
    });
  }
}

async function addLpInterestPoint({
  from,
  to,
  date,
  amount,
  currency,
  transactionId,
}: {
  from: string;
  to: string;
  date: Date;
  amount: number;
  currency: CurrencyIsoCode;
  transactionId: string;
}) {
  const ctx = currentContext();
  const fundAsset = await getValuationsQb(['asset'])
    .insertInto('asset')
    .values({
      name: `LP Interest Point - ${formatDate(date, 'yyyy-MM-dd')}`,
      type: AssetType.LP_INTEREST_POINT,
      issued_by_legal_entity_id: from as LegalEntityId,
      team_id: ctx.user.teamId as TeamId,
      properties: {},
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  await getValuationsQb(['price'])
    .insertInto('price')
    .values({
      asset_id: fundAsset.id,
      date,
      price: amount,
      currency,
      team_id: ctx.user.teamId as TeamId,
      type: PriceType.FROM_PRICED_ROUND,
    })
    .execute();

  // Create the fund interest point asset transfer
  await getValuationsQb(['asset_transfer'])
    .insertInto('asset_transfer')
    .values({
      team_id: ctx.user.teamId as TeamId,
      asset_id: fundAsset.id,
      date,
      from_legal_entity_id: from as LegalEntityId,
      to_legal_entity_id: to as LegalEntityId,
      num_assets: 1,
      transaction_id: transactionId as TransactionId,
    })
    .execute();
}

async function addOutstandingCommittment({
  investingEntity,
  targetEntityId,
  date,
  currency,
  transactionId,
  amount,
}: {
  investingEntity: string;
  targetEntityId: string;
  date: Date;
  currency: CurrencyIsoCode;
  transactionId: string;
  amount: number;
}) {
  const ctx = currentContext();

  const outstandingCommitment = await getValuationsQb(['asset'])
    .insertInto('asset')
    .values({
      name: `Outstanding Commitment - ${formatDate(date, 'yyyy-MM-dd')}`,
      type: AssetType.FUND_OUTSTANDING_COMMITMENT,
      issued_by_legal_entity_id: investingEntity as LegalEntityId,
      team_id: ctx.user.teamId as TeamId,
      properties: {
        target_company_id: targetEntityId as LegalEntityId,
      },
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  await getValuationsQb(['price'])
    .insertInto('price')
    .values({
      asset_id: outstandingCommitment.id,
      date,
      price: amount,
      currency,
      team_id: ctx.user.teamId as TeamId,
      type: PriceType.FROM_PRICED_ROUND,
    })
    .execute();

  await getValuationsQb(['asset_transfer'])
    .insertInto('asset_transfer')
    .values({
      team_id: ctx.user.teamId as TeamId,
      asset_id: outstandingCommitment.id,
      date,
      from_legal_entity_id: investingEntity as LegalEntityId,
      to_legal_entity_id: targetEntityId as LegalEntityId,
      num_assets: 1,
      transaction_id: transactionId as TransactionId,
    })
    .execute();
}

export { addFundInvestmentAssetTransfers };
