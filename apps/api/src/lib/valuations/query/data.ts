import { currentPrincipal } from 'principal';

import { AssetId } from '../../../generated/kysely/valuations/Asset';
import AssetType from '../../../generated/kysely/valuations/AssetType';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import { InvestmentId } from '../../../generated/kysely/valuations/Investment';
import { LegalEntityId } from '../../../generated/kysely/valuations/LegalEntity';
import { ProfilePublicRoundId } from '../../../generated/kysely/public/ProfilePublicRound';
import { TeamId } from '../../../generated/kysely/core/Team';
import { getQb, getValuationsQb } from '../../kysely';

interface QueriedInvestment {
  id: string;
  investingEntityId: string;
  investeeEntityId: string;
  investedAt: Date | null;
  roundId: string | null;
  roundName: string | null;
}

interface InvestmentSelector {
  ids?: string[];
  investedFrom?: Date;
  investedTo?: Date;
  roundId?: string;
  investingEntityIds?: string[];
  investeeEntityIds?: string[];
}

/** The investments a query runs over, always team-scoped. A round is the
 *  investment's public round where it has one; investments that only name a
 *  round type carry no round id and group together under that name. */
async function getInvestmentsForQuery(selector: InvestmentSelector): Promise<QueriedInvestment[]> {
  const teamId = currentPrincipal().teamId;

  // `profile_public_round` stayed in the residual `public` schema (V-7 drops it
  // outright once its last dealflow readers go), so the round name is the one
  // cross-schema crossing this query owes — spelled out at the call site per
  // D35(b).
  let query = getQb(['valuations.investment', 'profile_public_round'])
    .selectFrom('valuations.investment as investment')
    .leftJoin('profile_public_round as round', 'round.id', 'investment.public_round_id')
    .select([
      'investment.id as id',
      'investment.investor_profile_id as investing_entity_id',
      'investment.investment_profile_id as investee_entity_id',
      'investment.invested_at as invested_at',
      'investment.public_round_id as round_id',
      'investment.round_type as investment_round_type',
      'round.round_type as public_round_type',
    ])
    .where('investment.team_id', '=', teamId as TeamId);

  if (selector.ids) {
    query = query.where('investment.id', 'in', selector.ids as InvestmentId[]);
  }
  if (selector.investedFrom) {
    query = query.where('investment.invested_at', '>=', selector.investedFrom);
  }
  if (selector.investedTo) {
    query = query.where('investment.invested_at', '<=', selector.investedTo);
  }
  if (selector.roundId) {
    query = query.where('investment.public_round_id', '=', selector.roundId as ProfilePublicRoundId);
  }
  if (selector.investingEntityIds) {
    query = query.where(
      'investment.investor_profile_id',
      'in',
      selector.investingEntityIds as LegalEntityId[],
    );
  }
  if (selector.investeeEntityIds) {
    query = query.where(
      'investment.investment_profile_id',
      'in',
      selector.investeeEntityIds as LegalEntityId[],
    );
  }

  const rows = await query.execute();

  return rows.map((row) => ({
    id: row.id,
    investingEntityId: row.investing_entity_id,
    investeeEntityId: row.investee_entity_id,
    investedAt: row.invested_at,
    roundId: row.round_id,
    roundName: row.public_round_type ?? row.investment_round_type,
  }));
}

async function getCurrencyIsoCodes(assetIds: string[]): Promise<Map<string, CurrencyIsoCode>> {
  const codes = new Map<string, CurrencyIsoCode>();
  if (!assetIds.length) return codes;

  const rows = await getValuationsQb(['currency_asset'])
    .selectFrom('currency_asset')
    .select(['asset_id', 'iso_code'])
    .where('asset_id', 'in', assetIds as AssetId[])
    .execute();

  for (const row of rows) codes.set(row.asset_id, row.iso_code);
  return codes;
}

/**
 * The entity a held asset is exposure to today — the axis that answers "how
 * much do I hold in the acquirer" without minting investment lines.
 *
 * `getAssetTrackedEntities` answers a different question (does this asset still
 * track company X, over a set of candidates); grouping needs the ONE entity the
 * asset stands for, so a wrapper resolves to what it points at and everything
 * else to its issuer.
 */
async function getAssetExposureEntities(
  assetIds: string[],
): Promise<Map<string, { id: string; name: string }>> {
  const exposure = new Map<string, { id: string; name: string }>();
  if (!assetIds.length) return exposure;

  const assets = await getValuationsQb(['asset', 'legal_entity'])
    .selectFrom('asset')
    .leftJoin('legal_entity as issuer', 'issuer.id', 'asset.issued_by_legal_entity_id')
    .select([
      'asset.id as id',
      'asset.type as type',
      'asset.properties as properties',
      'asset.issued_by_legal_entity_id as issuer_id',
      'issuer.underlying_company_id as underlying_company_id',
    ])
    .where('asset.id', 'in', assetIds as AssetId[])
    .execute();

  const targetByAsset = new Map<string, string>();
  for (const asset of assets) {
    const spvTarget =
      asset.type === AssetType.SPV_INTEREST_POINT
        ? (asset.properties as { spv_investment_target_company_id?: unknown })
            ?.spv_investment_target_company_id
        : undefined;
    const target =
      (typeof spvTarget === 'string' ? spvTarget : null) ??
      asset.underlying_company_id ??
      asset.issuer_id;
    if (target) targetByAsset.set(asset.id, target);
  }

  const targetIds = Array.from(new Set(targetByAsset.values()));
  if (!targetIds.length) return exposure;

  const entities = await getValuationsQb(['legal_entity'])
    .selectFrom('legal_entity')
    .select(['id', 'name'])
    .where('id', 'in', targetIds as LegalEntityId[])
    .execute();

  const namesById = new Map(entities.map((entity) => [entity.id as string, entity.name]));
  for (const [assetId, targetId] of targetByAsset) {
    exposure.set(assetId, { id: targetId, name: namesById.get(targetId) ?? '' });
  }

  return exposure;
}

export {
  getAssetExposureEntities,
  getCurrencyIsoCodes,
  getInvestmentsForQuery,
  InvestmentSelector,
  QueriedInvestment,
};
