import { sql } from 'kysely';
import { currentPrincipal } from 'principal';

import { AssetId } from '../../../generated/kysely/valuations/Asset';
import { getValuationsQb } from '../../kysely';
import { AssetPrice } from './types';
import AssetType from '../../../generated/kysely/valuations/AssetType';
import { TeamId } from '../../../generated/kysely/core/Team';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import PriceType from '../../../generated/kysely/valuations/PriceType';
import { getAssetTrackedEntities } from '../trackedEntities';
import { requestBatchLoader, requestMemo } from '../requestCache';

/**
 * The latest price on or before `date` for each asset that has one.
 *
 * An asset's answer depends on the asset and the date and nothing else — the
 * equity leg resolves a price for the whole issuing entity, from every asset
 * that entity issued rather than from the ones asked about — so it is asked per
 * asset and answered per batch, and a repeat ask costs nothing. Assets with no
 * price at all are answered as such too, so an unpriced holding is not
 * re-queried once per company on the list.
 */
const loadLatestPrice = requestBatchLoader<{ assetId: string; date: Date }, AssetPrice>({
  identity: ({ assetId, date }) => `${assetId}@${date.toISOString()}`,
  fetch: async (batch) => {
    const byDate = new Map<string, { date: Date; assetIds: Set<string> }>();
    for (const { assetId, date } of batch) {
      const key = date.toISOString();
      const group = byDate.get(key) ?? { date, assetIds: new Set<string>() };
      group.assetIds.add(assetId);
      byDate.set(key, group);
    }

    const found = new Map<string, AssetPrice>();
    await Promise.all(
      Array.from(byDate.values()).map(async ({ date, assetIds }) => {
        const prices = await fetchLatestPrices({ assetIds: Array.from(assetIds), date });
        for (const [assetId, price] of Object.entries(prices)) {
          found.set(`${assetId}@${date.toISOString()}`, price);
        }
      }),
    );

    return found;
  },
});

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

  const wanted = Array.from(new Set(assetIds));
  const found = await Promise.all(wanted.map((assetId) => loadLatestPrice({ assetId, date })));

  const prices: Record<string, AssetPrice> = {};
  wanted.forEach((assetId, i) => {
    const price = found[i];
    if (price) prices[assetId] = price;
  });
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

  const [nonEquityPrices, pricePerShareByEntity] = await Promise.all([
    getPricesForAssets(nonEquityAssets, date),
    getEntityPricesPerShare({ entityIds: Array.from(equityAssetsByEntity.keys()), date, teamId }),
  ]);

  const equityPrices = new Map<string, AssetPrice>();
  for (const [entityId, entityAssets] of equityAssetsByEntity) {
    const pricePerShare = pricePerShareByEntity.get(entityId);
    if (!pricePerShare) continue;
    // Apply this price to all requested assets from this entity
    for (const assetId of entityAssets) equityPrices.set(assetId, pricePerShare);
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

/**
 * What a share in each of these companies was last worth on or before `date` —
 * the price every EQUITY asset the company issued is valued at.
 *
 * A company's price is the latest price scoped to it: on any equity asset it
 * issued, or on the company itself. CONVERSION prices are suppressed when a
 * uniform price per share — any FROM_PRICED_ROUND or FROM_ASSET_HOLDER price
 * scoped to the same company — exists on the same date or earlier: such a price
 * represents the company's per-share value, and a same-day conversion at a
 * discounted or capped price shouldn't override or tie with it.
 *
 * One company's answer is its own, so the whole portfolio's companies are asked
 * in a single statement — a lateral over the company list, each arm the same
 * "latest one" the company would have been asked on its own.
 */
async function getEntityPricesPerShare({
  entityIds,
  date,
  teamId,
}: {
  entityIds: string[];
  date: Date;
  teamId: string;
}): Promise<Map<string, AssetPrice>> {
  const perEntity = new Map<string, AssetPrice>();
  if (!entityIds.length) return perEntity;

  const rows = await sql<{
    entity_id: string;
    price: number;
    currency: CurrencyIsoCode;
    date: Date;
  }>`
    with scoped as (
      -- Priced on one of the company's own equity assets…
      select issuer.issued_by_legal_entity_id as entity_id,
             p.id, p.price, p.currency, p.date, p.type, true as on_an_asset
      from valuations.asset as issuer
      join valuations.price as p on p.asset_id = issuer.id
      where issuer.issued_by_legal_entity_id = any(${sql.val(entityIds)}::uuid[])
        and issuer.type = ${sql.lit(AssetType.EQUITY)}
        and p.team_id = ${sql.val(teamId)}::uuid
        and p.date <= ${sql.val(date)}
      union all
      -- …or on the company itself.
      select p.legal_entity_id as entity_id,
             p.id, p.price, p.currency, p.date, p.type, false as on_an_asset
      from valuations.price as p
      where p.asset_id is null
        and p.legal_entity_id = any(${sql.val(entityIds)}::uuid[])
        and p.team_id = ${sql.val(teamId)}::uuid
        and p.date <= ${sql.val(date)}
    ),
    -- The first date a uniform price per share exists from. On and after it a
    -- conversion price is shadowed.
    uniform as (
      select entity_id, min(date) as from_date
      from scoped
      where type in (${sql.lit(PriceType.FROM_PRICED_ROUND)}, ${sql.lit(
        PriceType.FROM_ASSET_HOLDER,
      )})
      group by entity_id
    )
    select distinct on (scoped.entity_id)
      scoped.entity_id, scoped.price, scoped.currency, scoped.date
    from scoped
    left join uniform on uniform.entity_id = scoped.entity_id
    where scoped.type <> ${sql.lit(PriceType.CONVERSION)}
      or uniform.from_date is null
      or scoped.date < uniform.from_date
    -- A price on the company itself is its price per share; one on a single
    -- equity asset prices that asset. Where both were recorded on the same day
    -- the company's own is the answer, and the row's id settles anything left,
    -- so the same data always gives the same price.
    order by scoped.entity_id, scoped.date desc, scoped.on_an_asset asc, scoped.id asc
  `.execute(getValuationsQb(['price', 'asset']));

  for (const row of rows.rows) {
    perEntity.set(row.entity_id, {
      price: row.price,
      currency: row.currency,
      date: row.date,
    });
  }

  return perEntity;
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
const loadExchangeRate = requestBatchLoader<
  { fromCurrency: CurrencyIsoCode; toCurrency: CurrencyIsoCode; date: Date },
  number
>({
  identity: ({ fromCurrency, toCurrency, date }) =>
    `${fromCurrency}:${toCurrency}@${date.toISOString()}`,
  fetch: async (batch) => {
    const froms = batch.map((r) => r.fromCurrency as string);
    const tos = batch.map((r) => r.toCurrency as string);
    // The dates go across as Dates, not as ISO strings: a rate is filed under a
    // calendar day, and west of Greenwich a local midnight read as UTC is the
    // day before — which silently values every flow at the previous day's rate.
    const dates = batch.map((r) => r.date);

    // One arm of the lateral per asked-for rate, each the same "latest on or
    // before" the pair would have been asked on its own. The table holds a rate
    // per pair per day, so pulling the history for every pair a portfolio
    // touches and picking in memory would be far more than it is worth.
    const rows = await sql<{
      position: string;
      from_currency: CurrencyIsoCode;
      rate: number;
    }>`
      select asked.position, found.from_currency, found.rate
      from unnest(
        ${sql.val(froms)}::text[],
        ${sql.val(tos)}::text[],
        ${sql.val(dates)}::date[]
      ) with ordinality as asked(from_currency, to_currency, date, position)
      join lateral (
        select r.from_currency, r.rate
        from valuations.exchange_rate as r
        where (
          (r.from_currency::text = asked.from_currency and r.to_currency::text = asked.to_currency)
          or (r.from_currency::text = asked.to_currency and r.to_currency::text = asked.from_currency)
        )
          and r.date <= asked.date
        order by r.date desc
        limit 1
      ) as found on true
    `.execute(getValuationsQb(['exchange_rate']));

    const rates = new Map<string, number>();
    for (const row of rows.rows) {
      const asked = batch[Number(row.position) - 1];
      if (!asked) continue;
      const rate = Number(row.rate);
      rates.set(
        `${asked.fromCurrency}:${asked.toCurrency}@${asked.date.toISOString()}`,
        // Found the other way round: the rate is the reciprocal.
        row.from_currency === asked.fromCurrency ? rate : 1 / rate,
      );
    }

    return rates;
  },
});

async function getExchangeRate({
  fromCurrency,
  toCurrency,
  date,
}: {
  fromCurrency: CurrencyIsoCode;
  toCurrency: CurrencyIsoCode;
  date: Date;
}): Promise<number> {
  if (fromCurrency === toCurrency) return 1;

  const rate = await loadExchangeRate({ fromCurrency, toCurrency, date });
  if (rate === undefined) {
    throw new Error(
      `No exchange rate found for ${fromCurrency}/${toCurrency} on or before ${date.toISOString()}`,
    );
  }

  return rate;
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
