import * as db from '@prisma/client';

import { Context } from '../services/context';
import { getOrCreateTransactionByAssetTransfers } from './datasources/data_layer';
import { upsertCompanyAsset } from './datasources/asset';
import { getTransfersByAssetType, upsertAssetTransfer } from './datasources/asset_transfer';
import { isClose } from './utils/math';

/**
 * The door check for every write in this file, all of which work from ids
 * `transactionById` handed back.
 *
 * That loader now carries the acting team's id itself (phase 6.2), so a
 * cross-team transaction comes back null and never reaches here — this is the
 * second line, not the only one, and it is kept because the writes below fan
 * out from one read and the cost of saying it twice is a single comparison.
 */
function assertOwnedByActingTeam(
  transaction: db.Transaction,
  transactionId: string,
  ctx: Context,
): void {
  if (transaction.teamId !== ctx.user.teamId) {
    throw new Error(`Could not find transaction ${transactionId}`);
  }
}

async function convertConvertible(
  {
    transactionId,
    conversionDate,
    conversionPrice,
    interest,
    firstShares,
    secondShares,
    currency,
  }: {
    transactionId: string;
    conversionDate: Date;
    conversionPrice: number;
    currency: db.CurrencyIsoCode;
    interest?: number;
    firstShares: { assetLegalName: string; numAssets: number };
    secondShares?: { assetLegalName: string; numAssets: number };
  },
  ctx: Context,
): Promise<
  db.Transaction & {
    equityAssetId: string;
    convertibleAssetId: string;
    issuingLegalEntityId: string;
    investorId: string;
    transfer: db.AssetTransfer;
  }
> {
  await validateConversionInput(
    {
      transactionId,
      conversionPrice,
      interest,
      firstShares,
      secondShares,
    },
    ctx,
  );

  const transaction = await ctx.dataloaders.transactionById.load(transactionId);
  if (transaction === null) {
    throw new Error(`Could not find transaction ${transactionId}`);
  }
  assertOwnedByActingTeam(transaction, transactionId, ctx);

  if (transaction.convertedToId) {
    throw new Error(`Already converted in transaction ${transaction.convertedToId}`);
  }

  const convertibleTransfer = getTransfersByAssetType({
    transfers: transaction.assetTransfers,
    assetType: db.AssetType.CONVERTIBLE,
  });

  if (convertibleTransfer.length === 0) {
    throw new Error(`Transaction ${transactionId} is not a convertible investment`);
  }
  if (convertibleTransfer.length > 1) {
    throw new Error('Matched too many convertible transfers');
  }

  const issuingLegalEntityId = convertibleTransfer[0].fromLegalEntityId;
  const investorId = convertibleTransfer[0].toLegalEntityId;

  // Get a transaction by the asset transfer and if it doesn't exist, create it
  const equityAsset1 = await upsertCompanyAsset(
    {
      assetName: firstShares.assetLegalName,
      assetType: db.AssetType.EQUITY,
      assetProperties: {},
      issuingLegalEntityId,
    },
    ctx,
  );

  const conversionEvent = await ctx.prisma.event.findFirst({
    where: {
      teamId: ctx.user.teamId,
      type: db.EventType.INVESTMENT_ROUND,
      legalEntityId: issuingLegalEntityId,
      date: conversionDate,
    },
  });

  const conversionTransaction = await getOrCreateTransactionByAssetTransfers(
    {
      fromLegalEntityId: issuingLegalEntityId,
      toLegalEntityId: investorId,
      givenAssetId: equityAsset1.id,
      receivedAssetId: equityAsset1.id,
      date: conversionDate,
      eventId: conversionEvent?.id,
    },
    ctx,
  );

  // Link the converted transaction
  await ctx.prisma.transaction.update({
    where: { id: transaction.id },
    data: { convertedToId: conversionTransaction.id },
  });

  // Give back the convertible to the company
  await upsertAssetTransfer(
    {
      fromLegalEntityId: investorId,
      toLegalEntityId: issuingLegalEntityId,
      assetId: convertibleTransfer[0].assetId,
      numAssets: 1, // Only one convertible asset is always used
      transactionId: conversionTransaction.id,
      date: conversionDate,
    },
    ctx,
  );

  await upsertAssetTransfer(
    {
      fromLegalEntityId: issuingLegalEntityId,
      toLegalEntityId: investorId,
      assetId: equityAsset1.id,
      numAssets: firstShares.numAssets,
      transactionId: conversionTransaction.id,
      date: conversionDate,
    },
    ctx,
  );

  await ctx.prisma.price.create({
    data: {
      legalEntityId: issuingLegalEntityId,
      assetId: equityAsset1.id,
      price: conversionPrice,
      currency: currency,
      date: conversionDate,
      teamId: ctx.user.teamId,
      type: db.PriceType.CONVERSION,
    },
  });

  await ctx.prisma.asset.update({
    where: { id: convertibleTransfer[0].assetId },
    data: { conversionDate, conversionPrice, interest },
  });

  if (secondShares) {
    const equityAsset2 = await upsertCompanyAsset(
      {
        assetName: secondShares.assetLegalName,
        assetType: db.AssetType.EQUITY,
        assetProperties: {},
        issuingLegalEntityId,
      },
      ctx,
    );

    await upsertAssetTransfer(
      {
        fromLegalEntityId: issuingLegalEntityId,
        toLegalEntityId: investorId,
        assetId: equityAsset2.id,
        numAssets: secondShares.numAssets,
        transactionId: conversionTransaction.id,
        date: conversionDate,
      },
      ctx,
    );

    await ctx.prisma.price.create({
      data: {
        legalEntityId: issuingLegalEntityId,
        assetId: equityAsset2.id,
        price: conversionPrice,
        currency: currency,
        date: conversionDate,
        teamId: ctx.user.teamId,
        type: db.PriceType.CONVERSION,
      },
    });
  }

  return {
    ...conversionTransaction,
    equityAssetId: equityAsset1.id,
    transfer: convertibleTransfer[0],
    convertibleAssetId: convertibleTransfer[0].assetId,
    issuingLegalEntityId,
    investorId,
  };
}

async function validateConversionInput(
  {
    transactionId,
    conversionPrice,
    interest,
    firstShares,
    secondShares,
  }: {
    transactionId: string;
    conversionPrice: number;
    interest?: number;
    firstShares: { assetLegalName: string; numAssets: number };
    secondShares?: { assetLegalName: string; numAssets: number };
  },
  ctx: Context,
): Promise<boolean> {
  const transaction = await ctx.dataloaders.transactionById.load(transactionId);
  if (transaction === null) {
    throw new Error(`Could not find transaction ${transactionId}`);
  }
  assertOwnedByActingTeam(transaction, transactionId, ctx);
  const currencyTransfers = getTransfersByAssetType({
    transfers: transaction.assetTransfers,
    assetType: db.AssetType.CURRENCY,
  });

  const investedAmount = currencyTransfers
    .filter((item): item is typeof item & { numAssets: number } => item.numAssets !== null)
    .reduce((acc, item) => acc + item.numAssets, 0);
  const calculatedConversionPrice =
    (investedAmount + (interest ?? 0)) / (firstShares.numAssets + (secondShares?.numAssets ?? 0));

  if (!isClose(calculatedConversionPrice, conversionPrice, 0.0001)) {
    throw new Error('The conversion price differs too much from the re-calculated price');
  }

  return true;
}

export { convertConvertible };
