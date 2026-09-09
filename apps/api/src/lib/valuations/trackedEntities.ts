import { AssetId } from '../../generated/kysely/valuations/Asset';
import AssetType from '../../generated/kysely/valuations/AssetType';
import { LegalEntityId } from '../../generated/kysely/valuations/LegalEntity';
import { getValuationsQb } from '../kysely';
import { requestScopedMap } from './requestCache';

/** One asset's tracked set, memoised for the life of the request. */
const trackedByAsset = requestScopedMap<Promise<Set<string> | undefined>>();

/**
 * For each asset, the set of legal-entity ids whose underlying value it tracks.
 *
 * An asset tracks its own issuer; an SPV (or any wrapper carrying an
 * `underlying_company_id`) also tracks the company it holds, resolved both from
 * the issuing entity's `underlying_company_id` and from an SPV interest's
 * `spv_investment_target_company_id` property. Used to decide, for a held asset,
 * whether it still tracks the company we invested in (→ retained) or has become
 * a claim on something else (→ realised, even if illiquid).
 *
 * `inventory/data.ts`'s transaction discovery calls this too, and carries the
 * result into its join as a pairing of asset id to tracked entity id, so there
 * is one definition of the set rather than a SQL twin to keep in step.
 *
 * Lives here rather than under `valuation/` because the inventory walk needs the
 * same resolution to fix a lot's causal degree, and inventory must not depend on
 * valuation. `valuation/data` re-exports it so its existing callers are unmoved.
 *
 * The answer for one asset is memoised for the life of the request, so the
 * discovery walk, the retained split and the lots' degrees ask the database
 * once between them however many times they ask each other.
 */
async function getAssetTrackedEntities(assetIds: string[]): Promise<Map<string, Set<string>>> {
  const cache = trackedByAsset();
  const wanted = Array.from(new Set(assetIds));
  const misses = wanted.filter((assetId) => !cache.has(assetId));

  if (misses.length) {
    const fetched = fetchAssetTrackedEntities(misses);
    // Unobserved rejections take the process down; every caller awaits its own
    // read of the same promise below.
    fetched.catch(() => {});
    for (const assetId of misses) {
      cache.set(
        assetId,
        fetched.then((tracked) => tracked.get(assetId)),
      );
    }
  }

  const tracked = new Map<string, Set<string>>();
  await Promise.all(
    wanted.map(async (assetId) => {
      // An asset the query didn't find has no entry at all, and callers read
      // that absence — keep it out of the map rather than minting an empty set.
      const entities = await cache.get(assetId);
      if (entities) tracked.set(assetId, entities);
    }),
  );
  return tracked;
}

async function fetchAssetTrackedEntities(assetIds: string[]): Promise<Map<string, Set<string>>> {
  const tracked = new Map<string, Set<string>>();
  if (!assetIds.length) return tracked;

  const assets = await getValuationsQb(['asset'])
    .selectFrom('asset')
    .select(['id', 'type', 'issued_by_legal_entity_id', 'properties'])
    .where('asset.id', 'in', assetIds as AssetId[])
    .execute();

  const issuerIds = [
    ...new Set(
      assets
        .map((a) => a.issued_by_legal_entity_id)
        .filter((id): id is NonNullable<typeof id> => !!id),
    ),
  ];

  const issuerUnderlying = new Map<string, string>();
  if (issuerIds.length) {
    const issuers = await getValuationsQb(['legal_entity'])
      .selectFrom('legal_entity')
      .select(['id', 'underlying_company_id'])
      .where('id', 'in', issuerIds as LegalEntityId[])
      .execute();
    for (const issuer of issuers) {
      if (issuer.underlying_company_id) {
        issuerUnderlying.set(issuer.id, issuer.underlying_company_id);
      }
    }
  }

  for (const asset of assets) {
    const entities = new Set<string>();
    if (asset.issued_by_legal_entity_id) {
      entities.add(asset.issued_by_legal_entity_id);
      const underlying = issuerUnderlying.get(asset.issued_by_legal_entity_id);
      if (underlying) entities.add(underlying);
    }
    if (asset.type === AssetType.SPV_INTEREST_POINT) {
      const target = (asset.properties as { spv_investment_target_company_id?: unknown })
        ?.spv_investment_target_company_id;
      if (typeof target === 'string') entities.add(target);
    }
    tracked.set(asset.id, entities);
  }

  return tracked;
}

export { getAssetTrackedEntities };
