import { currentPrincipal } from 'principal';

import { AssetId } from '../../../generated/kysely/valuations/Asset';
import { getQb, getValuationsQb } from '../../kysely';
import { AssetPrice } from './types';
import AssetType from '../../../generated/kysely/valuations/AssetType';
import { LegalEntityId } from '../../../generated/kysely/valuations/LegalEntity';
import { TeamId } from '../../../generated/kysely/core/Team';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import PriceType from '../../../generated/kysely/valuations/PriceType';
import { getAssetTrackedEntities } from '../trackedEntities';
import { requestMemo, requestScopedMap } from '../requestCache';

/** One asset's price as of one date, memoised for the life of the request. */
const priceByAssetAndDate = requestScopedMap<Promise<AssetPrice | undefined>>();

function priceKey(assetId: string, date: Date): string {
  return `${assetId}@${date.toISOString()}`;
}

/**
 * The latest price on or before `date` for each asset that has one.
 *
 * An asset's answer depends on the asset and the date and nothing else — the
 * equity leg resolves a price for the whole issuing entity, from every asset
 * that entity issued rather than from the ones asked about — so it is memoised
 * per (asset, date) and a repeat ask costs nothing. Assets with no price at all
 * are memoised as such too, so an unpriced holding is not re-queried once per
 * company on the list.
 */
async function getLatestPrices({
  assetIds,
  date,
}: {
  assetIds: string[];
  date: Date;
}): Promise<Record<string, AssetPrice>> {
  if (!assetIds.length) {
    return {};
  }

  const cache = priceByAssetAndDate();
  const wanted = Array.from(new Set(assetIds));
  const misses = wanted.filter((assetId) => !cache.has(priceKey(assetId, date)));

  if (misses.length) {
    const fetched = fetchLatestPrices({ assetIds: misses, date });
    // Unobserved rejections take the process down; every caller awaits its own
    // read of the same promise below.
    fetched.catch(() => {});
    for (const assetId of misses) {
      cache.set(
        priceKey(assetId, date),
        fetched.then((prices) => prices[assetId]),
      );
    }
  }

  const prices: Record<string, AssetPrice> = {};
  await Promise.all(
    wanted.map(async (assetId) => {
      const price = await cache.get(priceKey(assetId, date));
      if (price) prices[assetId] = price;
    }),
  );
  return prices;
}

async function fetchLatestPrices({
  assetIds,
  date,
}: {
  assetIds: string[];
  date: Date;
}): Promise<Record<string, AssetPrice>> {
  const teamId = currentPrincipal().teamId;

  // First get asset metadata (type and issuing entity)
  const assets = await getValuationsQb(['asset'])
    .selectFrom('asset')
    .select(['id', 'type', 'issued_by_legal_entity_id'])
    .where('asset.id', 'in', assetIds as AssetId[])
    .execute();

  // Group assets by issuing entity for EQUITY assets
  const equityAssetsByEntity = new Map<string, string[]>();
  const nonEquityAssets: string[] = [];

  assets.forEach((asset) => {
    if (asset.type === 'EQUITY' && asset.issued_by_legal_entity_id) {
      const entityAssets = equityAssetsByEntity.get(asset.issued_by_legal_entity_id) || [];
      entityAssets.push(asset.id);
      equityAssetsByEntity.set(asset.issued_by_legal_entity_id, entityAssets);
    } else {
      nonEquityAssets.push(asset.id);
    }
  });

  // Get prices for non-equity assets normally
  const nonEquityPrices = await getPricesForAssets(nonEquityAssets, date);

  // Get prices for equity assets by entity
  const equityPrices = new Map<string, AssetPrice>();

  for (const [entityId, entityAssets] of equityAssetsByEntity) {
    // Get all equity assets issued by this entity
    const allEntityAssets = await getValuationsQb(['asset'])
      .selectFrom('asset')
      .select('id')
      .where('type', '=', AssetType.EQUITY)
      .where('issued_by_legal_entity_id', '=', entityId as LegalEntityId)
      .execute();

    const allEntityAssetIds = allEntityAssets.map((a) => a.id);

    // Get the latest price for any asset from this entity.
    // CONVERSION prices are suppressed when a uniform PPS — any FROM_PRICED_ROUND
    // or FROM_ASSET_HOLDER price scoped to this entity (either asset-less or on
    // any of the entity's equity assets) — exists on the same date or earlier.
    // Such prices represent the company's per-share value; a same-day conversion
    // at a discounted/capped price shouldn't override or tie with it.
    const latestEquityPrice = await getValuationsQb(['price'])
      .selectFrom('price')
      .select(['asset_id', 'price', 'currency', 'date'])
      .where('price.team_id', '=', teamId as TeamId)
      .where(($) =>
        $.or([
          $.and([$('price.asset_id', 'in', allEntityAssetIds)]),
          $.and([
            $('price.asset_id', 'is', null),
            $('legal_entity_id', '=', entityId as LegalEntityId),
          ]),
        ]),
      )
      .where('price.date', '<=', date)
      .where(($) =>
        $.or([
          $('price.type', '!=', PriceType.CONVERSION),
          $.not(
            $.exists(
              $.selectFrom('price as shadowing_price')
                .select('shadowing_price.id')
                .where('shadowing_price.team_id', '=', teamId as TeamId)
                .where('shadowing_price.type', 'in', [
                  PriceType.FROM_PRICED_ROUND,
                  PriceType.FROM_ASSET_HOLDER,
                ])
                .where(($$) =>
                  $$.or([
                    $$.and([$$('shadowing_price.asset_id', 'in', allEntityAssetIds)]),
                    $$.and([
                      $$('shadowing_price.asset_id', 'is', null),
                      $$('shadowing_price.legal_entity_id', '=', entityId as LegalEntityId),
                    ]),
                  ]),
                )
                .whereRef('shadowing_price.date', '<=', 'price.date'),
            ),
          ),
        ]),
      )
      .orderBy('price.date', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (latestEquityPrice) {
      // Apply this price to all requested assets from this entity
      entityAssets.forEach((assetId) => {
        equityPrices.set(assetId, {
          price: latestEquityPrice.price,
          currency: latestEquityPrice.currency,
          date: latestEquityPrice.date,
        });
      });
    }
  }

  // Combine both sets of prices
  const prices = {
    ...Object.fromEntries(equityPrices),
    ...nonEquityPrices,
  };

  // check for assets missing prices
  const missingAssets = assetIds.filter((assetId) => !prices[assetId]);
  for (const assetId of missingAssets) {
    // find the latest purchase of the asset
    const latestPurchase = await getValuationsQb(['transaction', 'asset_transfer', 'asset', 'currency_asset'])
      .selectFrom('transaction as t')
      .innerJoin('asset_transfer as at', 't.id', 'at.transaction_id')
      .innerJoin('asset_transfer as at2', 't.id', 'at2.transaction_id')
      .innerJoin('asset as a', 'at2.asset_id', 'a.id')
      .innerJoin('currency_asset as ca', 'a.id', 'ca.asset_id')
      .select(['at2.num_assets as price', 'at.num_assets', 't.close_date', 'ca.iso_code'])
      .where('at.asset_id', '=', assetId as AssetId)
      .where('a.type', '=', AssetType.CURRENCY)
      .where('t.close_date', '<=', date)
      .orderBy('t.close_date', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (latestPurchase) {
      prices[assetId] = {
        price: (latestPurchase.price ?? 0) / (latestPurchase.num_assets ?? 1),
        currency: latestPurchase.iso_code,
        date: latestPurchase.close_date,
      };
    }
  }

  return prices;
}

async function getPricesForAssets(
  assetIds: string[],
  date: Date,
): Promise<Record<string, AssetPrice>> {
  if (!assetIds.length) return {};

  const teamId = currentPrincipal().teamId;

  const results = await getValuationsQb(['price'])
    .selectFrom('price')
    .select(['asset_id', 'price', 'currency', 'date'])
    .where('price.team_id', '=', teamId as TeamId)
    .where('price.asset_id', 'in', assetIds as AssetId[])
    .where('price.date', '<=', date)
    .orderBy('price.date', 'desc')
    .execute();

  // Group by asset and take the latest price for each
  const pricesByAsset = new Map<string, AssetPrice>();
  for (const row of results) {
    if (row.asset_id && !pricesByAsset.has(row.asset_id)) {
      pricesByAsset.set(row.asset_id, {
        price: row.price,
        currency: row.currency,
        date: row.date,
      });
    }
  }

  return Object.fromEntries(pricesByAsset);
}

/**
 * The rate to convert `fromCurrency` into `toCurrency` on `date`, as of the
 * latest rate on or before it.
 *
 * Every flow the walk values asks for two of these — one at the flow's own
 * date, one at the valuation date — and a portfolio of a hundred companies asks
 * for the same handful of pairs and dates thousands of times, so the answer is
 * memoised for the life of the request.
 */
const getExchangeRate = requestMemo({
  identity: ({
    fromCurrency,
    toCurrency,
    date,
  }: {
    fromCurrency: CurrencyIsoCode;
    toCurrency: CurrencyIsoCode;
    date: Date;
  }) => `${fromCurrency}:${toCurrency}@${date.toISOString()}`,
  compute: fetchExchangeRate,
});

async function fetchExchangeRate({
  fromCurrency,
  toCurrency,
  date,
}: {
  fromCurrency: CurrencyIsoCode;
  toCurrency: CurrencyIsoCode;
  date: Date;
}): Promise<number> {
  if (fromCurrency === toCurrency) return 1;

  // Try to find the rate in either direction
  const result = await getValuationsQb(['exchange_rate'])
    .selectFrom('exchange_rate')
    .select(['from_currency', 'to_currency', 'rate'])
    .where((eb) =>
      eb.or([
        eb.and({
          from_currency: fromCurrency,
          to_currency: toCurrency,
        }),
        eb.and({
          from_currency: toCurrency,
          to_currency: fromCurrency,
        }),
      ]),
    )
    .where('date', '<=', date)
    .orderBy('date', 'desc')
    .limit(1)
    .executeTakeFirst();

  if (!result) {
    throw new Error(
      `No exchange rate found for ${fromCurrency}/${toCurrency} on or before ${date.toISOString()}`,
    );
  }

  // If we found the rate in reverse, return the reciprocal
  const rate = Number(result.rate);
  return result.from_currency === fromCurrency ? rate : 1 / rate;
}

/**
 * Which currency a cash asset is denominated in — memoised for the life of the
 * request, since a portfolio's every cashflow is denominated in one of a
 * handful of currencies.
 */
const getCurrencyAsset = requestMemo({
  identity: (assetId: string) => assetId,
  compute: fetchCurrencyAsset,
});

async function fetchCurrencyAsset(assetId: string): Promise<{ isoCode: CurrencyIsoCode } | null> {
  const currencyAsset = await getValuationsQb(['currency_asset'])
    .selectFrom('currency_asset')
    .select(['iso_code'])
    .where('asset_id', '=', assetId as AssetId)
    .executeTakeFirst();

  return currencyAsset ? { isoCode: currencyAsset.iso_code } : null;
}

export { getLatestPrices, getExchangeRate, getCurrencyAsset, getAssetTrackedEntities };
