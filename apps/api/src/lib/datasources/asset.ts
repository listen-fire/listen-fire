import * as db from '@prisma/client';
import Dataloader, { Options } from 'dataloader';
import { Record, Static, String } from 'runtypes';

import { Context } from '../../services/context';
import { actingTeamFilter } from './dataloaders';

const spvInvestmentTargetCompanyIdKey = 'spv_investment_target_company_id';

const DbSpvInterestPropertiesRuntype = Record({
  [spvInvestmentTargetCompanyIdKey]: String,
});

type DbSpvInterestProperties = Static<typeof DbSpvInterestPropertiesRuntype>;

function isSpvInterestProperties(
  assetProperties: db.Prisma.InputJsonValue | db.Prisma.JsonValue | undefined,
): assetProperties is DbSpvInterestProperties {
  return DbSpvInterestPropertiesRuntype.guard(assetProperties);
}

type AssetByIdDataLoader = Dataloader<string, db.Asset | null>;

/**
 * Assets by id, for the acting team only — which means a CURRENCY asset does
 * not resolve here, because it belongs to no team. That is the whole point of
 * `getCurrencyAsset` below: the one deliberately team-less asset read says so
 * in its name, and every other asset read is narrow.
 */
function getAssetByIdDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<string, db.Asset | null>,
): AssetByIdDataLoader {
  return new Dataloader(async (ids) => {
    const assets = await prisma.asset.findMany({
      where: {
        teamId: actingTeamFilter(),
        id: {
          in: [...ids], // turn ids into non-readonly
        },
      },
    });
    const assetsById = new Map(assets.map((item) => [item.id, item]));
    return ids.map((id) => assetsById.get(id) ?? null);
  }, dataloaderOptions);
}

/**
 * The one asset read that is DELIBERATELY not team-scoped.
 *
 * A currency asset is global reference data — minted team-less by
 * `sync-fx-rates`, and the single shape the ability granted unconditionally
 * (`can(READ, 'Asset', { type: CURRENCY })`) rather than scoping to a
 * membership. Every other `asset` read carries `teamId`.
 *
 * It exists as a named function precisely so that stays legible: with the
 * authorisation layer gone, a bare `asset.findFirst` with no `teamId` reads as
 * a bug, and there is otherwise nothing to distinguish "team-less on purpose"
 * from "someone forgot".
 */
async function getCurrencyAsset(isoCode: db.CurrencyIsoCode, ctx: Context): Promise<db.Asset> {
  return ctx.prisma.asset.findFirstOrThrow({
    where: {
      type: db.AssetType.CURRENCY,
      currencyAsset: { isoCode },
    },
  });
}

async function upsertCompanyAsset(
  {
    assetName,
    assetType,
    assetProperties,
    issuingLegalEntityId,
  }: {
    assetName: string;
    assetType: db.AssetType;
    assetProperties: db.Prisma.InputJsonValue;
    issuingLegalEntityId: string;
  },
  ctx: Context,
): Promise<db.Asset> {
  const item = {
    name: assetName,
    type: assetType,
    issuedByLegalEntityId: issuingLegalEntityId,
    properties: assetProperties,
  };

  const isSpvProperties = isSpvInterestProperties(assetProperties);
  const spvConditions = isSpvProperties
    ? {
        properties: {
          path: [spvInvestmentTargetCompanyIdKey],
          equals: assetProperties.spv_investment_target_company_id,
        },
      }
    : {};

  const assets = await ctx.prisma.asset.findMany({
    where: {
      teamId: ctx.user.teamId,
      issuedByLegalEntityId: issuingLegalEntityId,
      name: assetName,
      type: assetType,
      ...spvConditions,
    },
  });

  if (assets.length > 1) {
    const suffixSpv = isSpvProperties
      ? ` and SPV target company ${assetProperties.spv_investment_target_company_id}`
      : '';
    throw new Error(
      `Matched too many assets for issuer ${issuingLegalEntityId}, name ${assetName}${suffixSpv}`,
    );
  }

  if (assets.length === 0) {
    return ctx.prisma.asset.create({ data: { ...item, teamId: ctx.user.teamId } });
  }
  return ctx.prisma.asset.update({ where: { id: assets[0].id }, data: item });
}

export { getAssetByIdDataloader, getCurrencyAsset, upsertCompanyAsset };
