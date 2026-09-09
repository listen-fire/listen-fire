import { sql } from 'kysely';

import { getQb } from '../../kysely';
import { currentContext } from '../../../services/context';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';
import { InvestmentValuation } from '../valuation/types';

interface CachedValuationRow {
  investment_id: string;
  unrealised_tx_date: number | null;
  unrealised_val_date: number | null;
  realised_tx_date: number | null;
  realised_val_date: number | null;
  // The share of realised cash the company we invested into paid itself — one
  // causal step from it, so degree 1. Answerable only because the cache is
  // degree-bucketed.
  realised_direct_tx_date: number | null;
  // Held non-cash assets that no longer track the investee, marked to market —
  // the acquirer roll-up. Retained alongside the tracking leg, but kept in its
  // own column so the two halves of retained stay separable.
  realised_rollup_tx_date: number | null;
  realised_rollup_val_date: number | null;
  invested_tx_date: number | null;
  invested_val_date: number | null;
  missing_fx: boolean;
  has_non_cash_investment: boolean;
  // Do we still hold any non-cash asset (net positive as of asOfDate) that
  // tracks the investee?
  holds_tracking_assets: boolean;
  // The same question over every held non-cash asset, tracking or not — the
  // Status column's predicate.
  holds_retained_assets: boolean;
}

async function getCachedInvestmentsValuation({
  investmentIds,
  asOfDate,
  fxDate,
  targetCurrency,
}: {
  investmentIds: string[];
  asOfDate: Date;
  fxDate: Date;
  targetCurrency: CurrencyIsoCode;
}): Promise<{
  perInvestment: Record<string, InvestmentValuation>;
  totals: InvestmentValuation;
  investmentsMissingFx: string[];
  investmentsWithoutCache: string[];
}> {
  if (!investmentIds.length) {
    return {
      perInvestment: {},
      totals: emptyValuation(targetCurrency),
      investmentsMissingFx: [],
      investmentsWithoutCache: [],
    };
  }

  const teamId = currentContext().user.teamId;
  const qb = getQb();

  const result = await sql<CachedValuationRow>`
    WITH events AS (
      SELECT
        e.investment_id,
        e.close_date,
        h.asset_id,
        h.asset_type,
        h.degree,
        h.num_assets,
        h.tracks_investee
      FROM public.inventory_delta_event e
      JOIN public.inventory_delta_holding h ON h.event_id = e.id
      WHERE e.team_id = ${teamId}::uuid
        AND e.investment_id = ANY(${investmentIds}::uuid[])
        AND e.close_date <= ${asOfDate}::date
    ),

    general_equity_price AS (
      SELECT price, currency
      FROM valuations.price
      WHERE asset_id IS NULL
        AND team_id = ${teamId}::uuid
        AND date <= ${asOfDate}::date
      ORDER BY date DESC
      LIMIT 1
    ),

    latest_price AS (
      SELECT
        a.id AS asset_id,
        COALESCE(asp.price, CASE WHEN a.type = 'EQUITY' THEN gen.price END) AS price,
        COALESCE(asp.currency, CASE WHEN a.type = 'EQUITY' THEN gen.currency END) AS currency
      FROM valuations.asset a
      LEFT JOIN LATERAL (
        SELECT p.price, p.currency
        FROM valuations.price p
        WHERE p.asset_id = a.id
          AND p.team_id = ${teamId}::uuid
          AND p.date <= ${asOfDate}::date
        ORDER BY p.date DESC
        LIMIT 1
      ) asp ON TRUE
      LEFT JOIN general_equity_price gen ON TRUE
      WHERE a.id IN (SELECT DISTINCT asset_id FROM events)
    ),

    flow AS (
      -- Held non-cash positions, marked to market at asOfDate. Assets that still
      -- track the investee are retained (unrealised); those that no longer track
      -- it (an acquirer's shares after a share-for-share swap) are realised at
      -- market — the roll-up. Same split, same prices/FX as the live path.
      SELECT
        e.investment_id,
        e.close_date,
        e.degree,
        e.num_assets * p.price
          * CASE WHEN e.asset_type = 'FUND_OUTSTANDING_COMMITMENT' THEN -1 ELSE 1 END
          AS native_amount,
        p.currency AS native_currency,
        CASE WHEN e.tracks_investee THEN 'unrealised' ELSE 'realised_rollup' END AS side
      FROM events e
      JOIN latest_price p ON p.asset_id = e.asset_id
      WHERE e.asset_type <> 'CURRENCY'
        AND p.price IS NOT NULL

      UNION ALL

      SELECT
        e.investment_id,
        e.close_date,
        e.degree,
        CASE WHEN e.asset_type = 'CURRENCY' THEN e.num_assets
             ELSE e.num_assets * p.price
        END AS native_amount,
        COALESCE(ca.iso_code, p.currency) AS native_currency,
        'realised'::text AS side
      FROM events e
      LEFT JOIN valuations.currency_asset ca ON ca.asset_id = e.asset_id
      LEFT JOIN latest_price p ON p.asset_id = e.asset_id
      WHERE e.asset_type IN ('CURRENCY', 'FUND_OUTSTANDING_COMMITMENT')
        AND (
          (e.asset_type = 'CURRENCY' AND ca.iso_code IS NOT NULL)
          OR (e.asset_type = 'FUND_OUTSTANDING_COMMITMENT' AND p.price IS NOT NULL)
        )
    ),

    priced AS (
      SELECT
        f.investment_id,
        f.side,
        f.degree,
        f.native_amount,
        CASE
          WHEN f.native_currency = ${targetCurrency}::valuations."CurrencyIsoCode" THEN 1.0
          ELSE fx_tx.rate
        END AS fx_at_flow,
        CASE
          WHEN f.native_currency = ${targetCurrency}::valuations."CurrencyIsoCode" THEN 1.0
          ELSE fx_val.rate
        END AS fx_at_fx_date
      FROM flow f
      LEFT JOIN LATERAL (
        SELECT
          CASE WHEN x.from_currency = f.native_currency THEN x.rate ELSE 1.0 / x.rate END AS rate
        FROM valuations.exchange_rate x
        WHERE (
            (x.from_currency = f.native_currency AND x.to_currency = ${targetCurrency}::valuations."CurrencyIsoCode")
            OR (x.from_currency = ${targetCurrency}::valuations."CurrencyIsoCode" AND x.to_currency = f.native_currency)
          )
          AND x.date <= f.close_date
        ORDER BY x.date DESC
        LIMIT 1
      ) fx_tx ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          CASE WHEN x.from_currency = f.native_currency THEN x.rate ELSE 1.0 / x.rate END AS rate
        FROM valuations.exchange_rate x
        WHERE (
            (x.from_currency = f.native_currency AND x.to_currency = ${targetCurrency}::valuations."CurrencyIsoCode")
            OR (x.from_currency = ${targetCurrency}::valuations."CurrencyIsoCode" AND x.to_currency = f.native_currency)
          )
          AND x.date <= ${fxDate}::date
        ORDER BY x.date DESC
        LIMIT 1
      ) fx_val ON TRUE
    ),

    aggregated AS (
      SELECT
        investment_id,
        bool_or(fx_at_flow IS NULL OR fx_at_fx_date IS NULL) AS missing_fx,
        SUM(native_amount * fx_at_flow)
          FILTER (WHERE side = 'unrealised') AS unrealised_tx_date,
        SUM(native_amount * fx_at_fx_date)
          FILTER (WHERE side = 'unrealised') AS unrealised_val_date,
        SUM(native_amount * fx_at_flow)
          FILTER (WHERE side = 'realised' AND native_amount > 0) AS realised_tx_date,
        SUM(native_amount * fx_at_fx_date)
          FILTER (WHERE side = 'realised' AND native_amount > 0) AS realised_val_date,
        -- Degree 1 is one causal step from the investee: the company itself paid
        -- it. Degree 2 and beyond came out of whatever the investment turned
        -- into. Same predicate the live path applies to its cash lots.
        SUM(native_amount * fx_at_flow)
          FILTER (WHERE side = 'realised' AND native_amount > 0 AND degree = 1)
          AS realised_direct_tx_date,
        SUM(native_amount * fx_at_flow)
          FILTER (WHERE side = 'realised_rollup') AS realised_rollup_tx_date,
        SUM(native_amount * fx_at_fx_date)
          FILTER (WHERE side = 'realised_rollup') AS realised_rollup_val_date,
        SUM(-native_amount * fx_at_flow)
          FILTER (WHERE side = 'realised' AND native_amount < 0) AS invested_tx_date,
        SUM(-native_amount * fx_at_fx_date)
          FILTER (WHERE side = 'realised' AND native_amount < 0) AS invested_val_date
      FROM priced
      GROUP BY investment_id
    ),

    non_cash_per_investment AS (
      SELECT investment_id, bool_or(has_non_cash_investment) AS has_non_cash_investment
      FROM public.inventory_delta_event
      WHERE team_id = ${teamId}::uuid
        AND investment_id = ANY(${investmentIds}::uuid[])
        AND close_date <= ${asOfDate}::date
      GROUP BY investment_id
    ),

    -- Per held non-cash asset, net balance as of asOfDate and whether it tracks
    -- the investee. FUND_OUTSTANDING_COMMITMENT is quasi-cash, not a holding.
    asset_balance AS (
      SELECT investment_id, asset_id, bool_or(tracks_investee) AS tracks_investee,
             SUM(num_assets) AS net_balance
      FROM events
      WHERE asset_type NOT IN ('CURRENCY', 'FUND_OUTSTANDING_COMMITMENT')
      GROUP BY investment_id, asset_id
    ),

    holds_tracking AS (
      SELECT investment_id,
             bool_or(tracks_investee AND net_balance > 0) AS holds_tracking_assets,
             bool_or(net_balance > 0) AS holds_retained_assets
      FROM asset_balance
      GROUP BY investment_id
    )

    SELECT
      agg.investment_id,
      agg.missing_fx,
      agg.unrealised_tx_date,
      agg.unrealised_val_date,
      agg.realised_tx_date,
      agg.realised_val_date,
      agg.realised_direct_tx_date,
      agg.realised_rollup_tx_date,
      agg.realised_rollup_val_date,
      agg.invested_tx_date,
      agg.invested_val_date,
      COALESCE(nc.has_non_cash_investment, false) AS has_non_cash_investment,
      COALESCE(ht.holds_tracking_assets, false) AS holds_tracking_assets,
      COALESCE(ht.holds_retained_assets, false) AS holds_retained_assets
    FROM aggregated agg
    LEFT JOIN non_cash_per_investment nc ON nc.investment_id = agg.investment_id
    LEFT JOIN holds_tracking ht ON ht.investment_id = agg.investment_id
  `.execute(qb);

  const perInvestment: Record<string, InvestmentValuation> = {};
  const investmentsMissingFx: string[] = [];
  for (const row of result.rows) {
    if (row.missing_fx) investmentsMissingFx.push(row.investment_id);
    perInvestment[row.investment_id] = rowToValuation(row, targetCurrency);
  }

  const seen = new Set(Object.keys(perInvestment));
  const investmentsWithoutCache = investmentIds.filter((id) => !seen.has(id));

  const totals = sumValuations(Object.values(perInvestment), targetCurrency);
  return { perInvestment, totals, investmentsMissingFx, investmentsWithoutCache };
}

function rowToValuation(row: CachedValuationRow, targetCurrency: CurrencyIsoCode): InvestmentValuation {
  const unrealizedTransactionDateValue = numOrZero(row.unrealised_tx_date);
  const unrealizedValuationDateValue = numOrZero(row.unrealised_val_date);
  // Cash proceeds (CURRENCY / FUND_OUTSTANDING_COMMITMENT inflows) only — the
  // whole of realised under the tense rule.
  const realizedCashTransactionDateValue = numOrZero(row.realised_tx_date);
  // Full retained: what we still hold in the investee plus what we still hold
  // in whatever it became, both marked live.
  const retainedValue = unrealizedValuationDateValue + numOrZero(row.realised_rollup_val_date);
  // The two legacy single-basis views, still cash + roll-up on one basis each.
  const realizedTransactionDateValue =
    realizedCashTransactionDateValue + numOrZero(row.realised_rollup_tx_date);
  const realizedValuationDateValue =
    numOrZero(row.realised_val_date) + numOrZero(row.realised_rollup_val_date);
  return {
    targetCurrency,
    unrealizedTransactionDateValue,
    unrealizedValuationDateValue,
    retainedValue,
    realizedCashTransactionDateValue,
    // Cash the company itself paid, read straight off the degree buckets.
    realisedDirectValue: numOrZero(row.realised_direct_tx_date),
    realizedTransactionDateValue,
    realizedValuationDateValue,
    totalTransactionDateValue: unrealizedTransactionDateValue + realizedTransactionDateValue,
    totalValuationDateValue: retainedValue + realizedCashTransactionDateValue,
    investedTransactionDateValue: row.has_non_cash_investment ? null : numOrZero(row.invested_tx_date),
    investedValuationDateValue: row.has_non_cash_investment ? null : numOrZero(row.invested_val_date),
    holdsTrackingAssets: row.holds_tracking_assets,
    holdsRetainedAssets: row.holds_retained_assets,
  };
}

function numOrZero(v: number | null): number {
  return v === null ? 0 : Number(v);
}

function emptyValuation(targetCurrency: CurrencyIsoCode): InvestmentValuation {
  return {
    targetCurrency,
    unrealizedTransactionDateValue: 0,
    unrealizedValuationDateValue: 0,
    retainedValue: 0,
    realizedCashTransactionDateValue: 0,
    realisedDirectValue: 0,
    realizedTransactionDateValue: 0,
    realizedValuationDateValue: 0,
    totalTransactionDateValue: 0,
    totalValuationDateValue: 0,
    investedTransactionDateValue: 0,
    investedValuationDateValue: 0,
    holdsTrackingAssets: false,
    holdsRetainedAssets: false,
  };
}

function sumValuations(values: InvestmentValuation[], targetCurrency: CurrencyIsoCode): InvestmentValuation {
  return values.reduce<InvestmentValuation>(
    (acc, v) => ({
      targetCurrency,
      unrealizedTransactionDateValue: acc.unrealizedTransactionDateValue + v.unrealizedTransactionDateValue,
      unrealizedValuationDateValue: acc.unrealizedValuationDateValue + v.unrealizedValuationDateValue,
      retainedValue: acc.retainedValue + v.retainedValue,
      realizedCashTransactionDateValue:
        acc.realizedCashTransactionDateValue + v.realizedCashTransactionDateValue,
      realisedDirectValue: acc.realisedDirectValue + v.realisedDirectValue,
      realizedTransactionDateValue: acc.realizedTransactionDateValue + v.realizedTransactionDateValue,
      realizedValuationDateValue: acc.realizedValuationDateValue + v.realizedValuationDateValue,
      totalTransactionDateValue: acc.totalTransactionDateValue + v.totalTransactionDateValue,
      totalValuationDateValue: acc.totalValuationDateValue + v.totalValuationDateValue,
      investedTransactionDateValue:
        acc.investedTransactionDateValue === null || v.investedTransactionDateValue === null
          ? null
          : acc.investedTransactionDateValue + v.investedTransactionDateValue,
      investedValuationDateValue:
        acc.investedValuationDateValue === null || v.investedValuationDateValue === null
          ? null
          : acc.investedValuationDateValue + v.investedValuationDateValue,
      holdsTrackingAssets: acc.holdsTrackingAssets || v.holdsTrackingAssets,
      holdsRetainedAssets: acc.holdsRetainedAssets || v.holdsRetainedAssets,
    }),
    emptyValuation(targetCurrency),
  );
}

export { getCachedInvestmentsValuation, sumValuations, emptyValuation };
