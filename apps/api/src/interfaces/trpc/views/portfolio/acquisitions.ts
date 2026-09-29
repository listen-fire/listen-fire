import { jsonArrayFrom } from 'kysely/helpers/postgres';

import { getValuationsQb } from '../../../../lib/kysely';
import { getInvestmentsValuation } from '../../../../lib/valuations/valuation';
import { getExchangeRate, getLatestPrices } from '../../../../lib/valuations/valuation/data';
import { AssetPrice } from '../../../../lib/valuations/valuation/types';
import { isReportableInvestment } from '../reportableInvestments';
import AssetType from '../../../../generated/kysely/valuations/AssetType';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import EventType from '../../../../generated/kysely/valuations/EventType';
import { LegalEntityId } from '../../../../generated/kysely/valuations/LegalEntity';
import { TeamId } from '../../../../generated/kysely/core/Team';

/**
 * One position a fund took in this company as payment for another company it
 * held being acquired — the rows `isReportableInvestment` keeps out of the
 * page's figures. They stay out of every total; this only lets the acquirer's
 * page say the shares are there.
 */
interface AcquisitionRow {
  investmentId: string;
  fund: { id: string; name: string };
  acquiredCompany: { id: string; name: string; slug: string | null };
  date: Date;
  received: {
    assetId: string;
    assetName: string;
    assetType: AssetType;
    quantity: number;
    currency: CurrencyIsoCode | null;
    date: Date;
  }[];
}

interface Acquisition {
  investmentId: string;
  fund: { id: string; name: string };
  acquiredCompany: { id: string; name: string; slug: string | null };
  date: string;
  sharesReceived: { assetId: string; assetName: string; quantity: number }[];
  /**
   * What the fund paid for the acquired company in total, in `currency`. The
   * engine keeps no cost per share, so this is not the cost of just the shares
   * handed over in this swap: it equals that only when the swap took the
   * fund's whole holding, which is the usual acquisition.
   */
  acquiredCompanyCost: number | null;
  /** Shares received at the latest price, in `currency`; null if any is unpriced. */
  valueNow: number | null;
  /** Cash paid alongside the shares, at the rate on the day it arrived; null if none. */
  cashReceived: number | null;
  /** (value now + cash received) / acquired company cost. */
  multiple: number | null;
  currency: CurrencyIsoCode;
}

interface ValuationDeps {
  costOf: (acquisition: { acquiredCompanyId: string; fundId: string }) => Promise<number | null>;
  pricesFor: (assetIds: string[]) => Promise<Record<string, AssetPrice>>;
  rate: (conversion: { from: CurrencyIsoCode; date: Date }) => Promise<number>;
}

async function loadAcquisitionRows({
  companyId,
  teamId,
}: {
  companyId: string;
  teamId: TeamId;
}): Promise<AcquisitionRow[]> {
  const rows = await getValuationsQb([
    'investment',
    'legal_entity',
    'event',
    'transaction',
    'asset_transfer',
    'asset',
    'currency_asset',
  ])
    .selectFrom('investment as i')
    .innerJoin('legal_entity as fund', 'fund.id', 'i.investor_profile_id')
    // The exit this position settles: the DISTRIBUTION it is tagged to, or —
    // for positions written before the tag existed — the one its own
    // transaction settles.
    .innerJoinLateral(
      ($) =>
        $.selectFrom('event as exit')
          .select(['exit.date', 'exit.legal_entity_id'])
          .where('exit.type', '=', EventType.DISTRIBUTION)
          .whereRef('exit.legal_entity_id', '!=', 'i.investment_profile_id')
          .where(($$) =>
            $$.or([
              $$('exit.id', '=', $$.ref('i.event_id')),
              $$.exists(
                $$.selectFrom('transaction as settling')
                  .select('settling.id')
                  .whereRef('settling.event_id', '=', 'exit.id')
                  .whereRef('settling.investment_id', '=', 'i.id'),
              ),
            ]),
          )
          .orderBy('exit.date', 'asc')
          .limit(1)
          .as('exit'),
      (join) => join.onTrue(),
    )
    .innerJoin('legal_entity as acquired', 'acquired.id', 'exit.legal_entity_id')
    .select(($) => [
      'i.id as investmentId',
      'fund.id as fundId',
      'fund.name as fundName',
      'acquired.id as acquiredId',
      'acquired.name as acquiredName',
      'acquired.slug as acquiredSlug',
      'exit.date',
      jsonArrayFrom(
        $.selectFrom('asset_transfer as leg')
          .innerJoin('transaction as t', 't.id', 'leg.transaction_id')
          .innerJoin('asset as a', 'a.id', 'leg.asset_id')
          .leftJoin('currency_asset as ca', 'ca.asset_id', 'a.id')
          .select([
            'a.id as assetId',
            'a.name as assetName',
            'a.type as assetType',
            'leg.num_assets as quantity',
            'ca.iso_code as currency',
            'leg.date',
          ])
          .whereRef('t.investment_id', '=', 'i.id')
          .whereRef('leg.to_legal_entity_id', '=', 'i.investor_profile_id')
          .orderBy('leg.date'),
      ).as('received'),
    ])
    .where('i.investment_profile_id', '=', companyId as LegalEntityId)
    .where('i.team_id', '=', teamId)
    // Exactly the rows the page's investment list leaves out, so every
    // position on this company lands on one side or the other.
    .where(($) => $.not(isReportableInvestment($, { event: 'event', investment: 'i' })))
    .where(($) =>
      $.or([$('fund.is_portfolio', '=', true), $('fund.is_own_investing_entity', '=', true)]),
    )
    .orderBy('exit.date', 'asc')
    .orderBy('fund.name', 'asc')
    .execute();

  return rows.map((row) => ({
    investmentId: row.investmentId,
    fund: { id: row.fundId, name: row.fundName },
    acquiredCompany: { id: row.acquiredId, name: row.acquiredName, slug: row.acquiredSlug },
    date: new Date(row.date),
    // jsonArrayFrom hands dates back as the JSON strings Postgres wrote.
    received: row.received.map((leg) => ({
      assetId: leg.assetId,
      assetName: leg.assetName,
      assetType: leg.assetType,
      quantity: Number(leg.quantity ?? 0),
      currency: leg.currency,
      date: new Date(leg.date),
    })),
  }));
}

async function valueAcquisitions(
  rows: AcquisitionRow[],
  { currency, fxDate, deps }: { currency: CurrencyIsoCode; fxDate: Date; deps: ValuationDeps },
): Promise<Acquisition[]> {
  const shareAssetIds = rows.flatMap((row) =>
    row.received.filter((leg) => leg.assetType !== AssetType.CURRENCY).map((leg) => leg.assetId),
  );
  const prices = shareAssetIds.length ? await deps.pricesFor(shareAssetIds) : {};

  const costs = new Map<string, Promise<number | null>>();
  const costOf = (acquiredCompanyId: string, fundId: string) => {
    const key = `${acquiredCompanyId}:${fundId}`;
    let cost = costs.get(key);
    if (!cost) {
      cost = deps.costOf({ acquiredCompanyId, fundId });
      costs.set(key, cost);
    }
    return cost;
  };

  return Promise.all(
    rows.map(async (row) => {
      const shares = row.received.filter((leg) => leg.assetType !== AssetType.CURRENCY);
      const cash = row.received.filter((leg) => leg.assetType === AssetType.CURRENCY);

      let valueNow: number | null = shares.length ? 0 : null;
      for (const leg of shares) {
        const price = prices[leg.assetId];
        if (!price || valueNow === null) {
          valueNow = null;
          continue;
        }
        // A held position floats, so it takes the valuation date's rate; cash
        // below is a fact and keeps the rate of the day it arrived.
        const fx = await deps.rate({ from: price.currency, date: fxDate });
        valueNow += leg.quantity * price.price * fx;
      }

      let cashReceived: number | null = null;
      for (const leg of cash) {
        if (!leg.currency) continue;
        const fx = await deps.rate({ from: leg.currency, date: leg.date });
        cashReceived = (cashReceived ?? 0) + leg.quantity * fx;
      }

      const acquiredCompanyCost = await costOf(row.acquiredCompany.id, row.fund.id);
      const multiple =
        acquiredCompanyCost && valueNow !== null
          ? (valueNow + (cashReceived ?? 0)) / acquiredCompanyCost
          : null;

      return {
        investmentId: row.investmentId,
        fund: row.fund,
        acquiredCompany: row.acquiredCompany,
        date: row.date.toISOString(),
        sharesReceived: shares.map((leg) => ({
          assetId: leg.assetId,
          assetName: leg.assetName,
          quantity: leg.quantity,
        })),
        acquiredCompanyCost,
        valueNow,
        cashReceived,
        multiple,
        currency,
      };
    }),
  );
}

/**
 * The acquirer-side positions on a company, each valued against what the fund
 * paid for the company it gave up. Uses only the engine's existing figures:
 * the invested total for the acquired company, the latest-price lookup and the
 * FX table.
 */
async function getCompanyAcquisitions({
  companyId,
  teamId,
  currency,
  asOfDate,
  fxDate,
}: {
  companyId: string;
  teamId: TeamId;
  currency: CurrencyIsoCode;
  asOfDate: Date;
  fxDate: Date;
}): Promise<Acquisition[]> {
  const rows = await loadAcquisitionRows({ companyId, teamId });
  if (!rows.length) return [];

  return valueAcquisitions(rows, {
    currency,
    fxDate,
    deps: {
      costOf: async ({ acquiredCompanyId, fundId }) => {
        const investments = await getValuationsQb(['investment', 'event', 'transaction'])
          .selectFrom('investment')
          .select(['investment.id', 'investment.invested_at as date'])
          .where('investment.investment_profile_id', '=', acquiredCompanyId as LegalEntityId)
          .where('investment.investor_profile_id', '=', fundId as LegalEntityId)
          .where('investment.team_id', '=', teamId)
          .where(($) => isReportableInvestment($, { event: 'event' }))
          .execute();
        if (!investments.length) return null;
        const { investedTransactionDateValue } = await getInvestmentsValuation({
          investments,
          targetCurrency: currency,
          asOfDate,
          fxDate,
        });
        return investedTransactionDateValue;
      },
      pricesFor: (assetIds) => getLatestPrices({ assetIds, date: asOfDate }),
      rate: ({ from, date }) => getExchangeRate({ fromCurrency: from, toCurrency: currency, date }),
    },
  });
}

export { getCompanyAcquisitions, valueAcquisitions };
export type { Acquisition, AcquisitionRow, ValuationDeps };
