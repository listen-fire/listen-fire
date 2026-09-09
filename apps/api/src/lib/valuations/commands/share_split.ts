import { z } from 'zod';
import { formatDate } from 'date-fns';

import { currentContext } from '../../../services/context';
import { getInventoryForInvestments } from '../inventory';
import { logFundingChange } from '../../funding-changelog';

/**
 * `applyShareSplit`'s input, exported as the single zod source of truth —
 * both the tRPC mutation (company.ts) and the REST command route
 * (interfaces/rest/v1/valuations/commands.ts) parse against this schema
 * rather than hand-duplicating the field list.
 */
export const applyShareSplitInput = z.object({
  companyId: z.string(),
  date: z.string().date(),
  multiple: z.number(),
});

export type ApplyShareSplitInput = z.infer<typeof applyShareSplitInput>;

/**
 * Records a company-wide share split: a `SHARE_SPLIT` event, a new equity
 * asset representing the split, a company-level price derived from the
 * latest priced round (`latestAssetPrice.price / multiple`), and — for
 * every EXISTING equity holder — a transaction transferring the newly
 * minted shares that bring their holding up to `numAssets * multiple`.
 *
 * Everything runs inside one transaction. The transaction boundary is the
 * CALLER's responsibility (`ctx.enterTransaction()` before invoking this),
 * not this service's — a reusable command must not leak a transaction into
 * whatever the caller does next.
 */
export async function applyShareSplit(input: ApplyShareSplitInput): Promise<{ eventId: string }> {
  const ctx = currentContext();
  if (!ctx.inTransaction) {
    throw new Error('applyShareSplit must run inside a transaction — the caller owns the transaction boundary');
  }

  const investments = await ctx.prisma.investment.findMany({
    where: {
      investmentProfileId: input.companyId,
      teamId: ctx.user.teamId,
      investedAt: { lt: new Date(input.date) },
      legalEntityInvestmentInvestorProfileIdTolegalEntity: {
        OR: [
          {
            isPortfolio: true,
          },
          {
            isOwnInvestingEntity: true,
          },
        ],
      },
    },
  });

  const holdings = await getInventoryForInvestments({
    investmentIds: investments.map((i) => i.id),
    asOfDate: new Date(input.date),
  });

  const result: Array<{
    fundId: string;
    fundName: string;
    assetId: string;
    assetName: string;
    assetType: string;
    numAssets: number;
  }> = [];

  // Iterate through each investing entity (fund)
  holdings.entries().forEach(([investingEntityKey, _, fundData]) => {
    const [fundId, fundName] = investingEntityKey.split(':');

    // Iterate through each asset in the fund
    fundData.entries().forEach(([assetKey, assetData]) => {
      const [assetId, assetName, assetType] = assetKey.split(':');

      // Calculate total number of assets
      const { fromInvestment: totalAssets } = assetData.sum();

      if (assetType !== 'EQUITY') {
        return;
      }

      // Add to result array
      result.push({
        fundId,
        fundName,
        assetId,
        assetName,
        assetType,
        numAssets: totalAssets,
      });
    });
  });

  const equityAssetsByHolder = result.reduce((acc, asset) => {
    acc.set(asset.fundId, (acc.get(asset.fundId) || 0) + asset.numAssets);
    return acc;
  }, new Map<string, number>());

  if (equityAssetsByHolder.size === 0) {
    throw new Error('No equity assets found');
  }

  const latestAssetPrice = await ctx.prisma.price.findFirst({
    where: {
      teamId: ctx.user.teamId,
      legalEntityId: input.companyId,
      assetId: null,
    },
    orderBy: {
      date: 'desc',
    },
  });

  if (!latestAssetPrice) {
    throw new Error('No asset price found');
  }

  const event = await ctx.prisma.event.create({
    data: {
      name: 'Share Split',
      type: 'SHARE_SPLIT',
      date: new Date(input.date),
      legalEntityId: input.companyId,
      teamId: ctx.user.teamId,
      data: { multiple: input.multiple },
    },
  });

  // Split equity asset
  const asset = await ctx.prisma.asset.create({
    data: {
      name: `Share Split - ${formatDate(new Date(input.date), 'yyyy-MM-dd')}`,
      type: 'EQUITY',
      issuedByLegalEntityId: input.companyId,
      teamId: ctx.user.teamId,
      properties: {},
    },
  });

  await ctx.prisma.price.create({
    data: {
      date: new Date(input.date),
      legalEntityId: input.companyId,
      price: latestAssetPrice.price / input.multiple,
      currency: latestAssetPrice.currency,
      teamId: ctx.user.teamId,
      type: 'FROM_PRICED_ROUND',
    },
  });

  for (const [fundId, numAssets] of equityAssetsByHolder) {
    if (numAssets === 0) {
      continue;
    }

    const transaction = await ctx.prisma.transaction.create({
      data: {
        closeDate: new Date(input.date),
        eventId: event.id,
        teamId: ctx.user.teamId,
      },
    });

    const totalAssets = numAssets * input.multiple;
    const remainingAssets = totalAssets - numAssets;

    await ctx.prisma.assetTransfer.create({
      data: {
        assetId: asset.id,
        date: new Date(input.date),
        fromLegalEntityId: input.companyId,
        toLegalEntityId: fundId,
        numAssets: remainingAssets,
        transactionId: transaction.id,
        teamId: ctx.user.teamId,
      },
    });
  }

  await logFundingChange({
    legalEntityId: input.companyId,
    category: 'Add Share Split',
    description: `Added ${input.multiple}:1 share split`,
    eventDate: input.date,
  });

  return { eventId: event.id };
}
