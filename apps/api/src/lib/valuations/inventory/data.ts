import { sql } from 'kysely';
import { currentPrincipal } from 'principal';

import AssetType from '../../../generated/kysely/valuations/AssetType';
import { InvestmentId } from '../../../generated/kysely/valuations/Investment';
import { LegalEntityId } from '../../../generated/kysely/valuations/LegalEntity';
import { TeamId } from '../../../generated/kysely/core/Team';
import { jsonbAgg, getValuationsQb } from '../../kysely';
import { requestBatchLoader } from '../requestCache';
import { getAssetTrackedEntities } from '../trackedEntities';
import { AssetTransfer, AssetId, InvestingEntityId } from './types';

/** Which of our entities holds an investment. One investment's answer is its
 *  own, so every row's ask joins the same query. */
const loadInvestmentAssetHolder = requestBatchLoader<string, string>({
  identity: (investmentId) => investmentId,
  fetch: async (investmentIds) => {
    const results = await getValuationsQb(['investment'])
      .selectFrom('investment')
      .select(['id', 'investor_profile_id'])
      .where('investment.id', 'in', Array.from(new Set(investmentIds)) as InvestmentId[])
      .execute();

    return new Map(results.map((row) => [row.id as string, row.investor_profile_id]));
  },
});

async function getAssetHolderIdsForInvestments({
  investmentIds,
}: {
  investmentIds: string[];
}): Promise<string[]> {
  if (investmentIds.length === 0) return [];
  const holders = await Promise.all(investmentIds.map(loadInvestmentAssetHolder));

  return Array.from(new Set(holders.filter((id): id is string => !!id)));
}

/** The assets and transactions one investment opens the walk with. Each
 *  investment's rows are its own, so a hundred companies ask once between
 *  them. */
const loadInvestmentSeed = requestBatchLoader<
  { investmentId: string; asOfDate: Date },
  { assetIds: string[]; transactionIds: string[] }
>({
  identity: ({ investmentId, asOfDate }) => `${investmentId}|${asOfDate.toISOString()}`,
  fetch: async (batch) => {
    const teamId = currentPrincipal().teamId;
    const byDate = new Map<string, { asOfDate: Date; investmentIds: Set<string> }>();
    for (const { investmentId, asOfDate } of batch) {
      const key = asOfDate.toISOString();
      const group = byDate.get(key) ?? { asOfDate, investmentIds: new Set<string>() };
      group.investmentIds.add(investmentId);
      byDate.set(key, group);
    }

    const seeds = new Map<string, { assetIds: string[]; transactionIds: string[] }>();
    await Promise.all(
      Array.from(byDate.values()).map(async ({ asOfDate, investmentIds }) => {
        const results = await getValuationsQb([
          'asset_transfer',
          'asset',
          'transaction',
          'legal_entity',
        ])
          .selectFrom('asset_transfer')
          .innerJoin('transaction', 'transaction.id', 'asset_transfer.transaction_id')
          .innerJoin('asset', 'asset.id', 'asset_transfer.asset_id')
          .innerJoin('legal_entity as to', (join) =>
            join.on(($) =>
              $.and([
                $('to.id', '=', $.ref('asset_transfer.to_legal_entity_id')),
                $.or([$('to.is_portfolio', '=', true), $('to.is_own_investing_entity', '=', true)]),
              ]),
            ),
          )
          .innerJoin('legal_entity as from', 'from.id', 'asset_transfer.from_legal_entity_id')
          .select([
            'asset.id as asset_id',
            'transaction.id as transaction_id',
            'transaction.investment_id',
          ])
          .where('transaction.team_id', '=', teamId as TeamId)
          .where('transaction.investment_id', 'in', Array.from(investmentIds) as InvestmentId[])
          .where('transaction.close_date', '<=', asOfDate)
          .where('asset.type', '<>', AssetType.CURRENCY)
          .execute();

        for (const investmentId of investmentIds) {
          seeds.set(`${investmentId}|${asOfDate.toISOString()}`, {
            assetIds: [],
            transactionIds: [],
          });
        }
        for (const row of results) {
          const seed = seeds.get(`${row.investment_id}|${asOfDate.toISOString()}`);
          if (!seed) continue;
          seed.assetIds.push(row.asset_id);
          seed.transactionIds.push(row.transaction_id);
        }
      }),
    );

    return seeds;
  },
});

async function getAssetsAndTransactionsForInvestments({
  investmentIds,
  asOfDate = new Date(),
}: {
  investmentIds: string[];
  asOfDate?: Date;
}): Promise<{ assetIds: Set<string>; transactionIds: Set<string> }> {
  if (!investmentIds.length) {
    return {
      assetIds: new Set(),
      transactionIds: new Set(),
    };
  }

  const seeds = await Promise.all(
    investmentIds.map((investmentId) => loadInvestmentSeed({ investmentId, asOfDate })),
  );

  const assetIds = new Set<string>();
  const transactionIds = new Set<string>();
  for (const seed of seeds) {
    for (const assetId of seed?.assetIds ?? []) assetIds.add(assetId);
    for (const transactionId of seed?.transactionIds ?? []) transactionIds.add(transactionId);
  }

  return { assetIds, transactionIds };
}

type SeededTransferRow = {
  /** Which asset of the batch reached this transfer. The walk asks per asset,
   *  so the answer is filed per asset and merged back for whoever asked. */
  seedAssetId: string;
  /** The `asset_transfer` row itself: unique, and everything but the investee
   *  list is a function of it, so it is the key two seeds' rows merge on. */
  transferId: string;
  /** Where the row sat in the batch's own chronological result, so a merge of
   *  several seeds' rows stays in the order the database put them in. */
  position: number;
  transaction: Omit<AssetTransfer, 'transfers'>;
  transfer: AssetTransfer['transfers'][number];
};

/**
 * Every transfer one asset takes part in — of the asset itself, or of cash from
 * an entity whose value it tracks.
 *
 * Asked per asset and answered per batch. The walk runs once per company and
 * steps level by level, so without this each level of each company is its own
 * round trip; with it, every company's level is one query. An asset's rows are
 * a function of the asset and the date alone — the one thing that isn't is the
 * investee list, which names the issuers of the ASKING assets, so the merge
 * below rebuilds it from whichever seeds the caller actually asked about.
 */
const loadAssetTransfers = requestBatchLoader<
  { assetId: string; asOfDate: Date },
  SeededTransferRow[]
>({
  identity: ({ assetId, asOfDate }) => `${assetId}|${asOfDate.toISOString()}`,
  fetch: async (batch) => {
    const byDate = new Map<string, { asOfDate: Date; assetIds: Set<string> }>();
    for (const { assetId, asOfDate } of batch) {
      const key = asOfDate.toISOString();
      const group = byDate.get(key) ?? { asOfDate, assetIds: new Set<string>() };
      group.assetIds.add(assetId);
      byDate.set(key, group);
    }

    const rowsByAsset = new Map<string, SeededTransferRow[]>();
    await Promise.all(
      Array.from(byDate.values()).map(async ({ asOfDate, assetIds }) => {
        const wanted = Array.from(assetIds);
        for (const assetId of wanted) {
          rowsByAsset.set(`${assetId}|${asOfDate.toISOString()}`, []);
        }

        const results = await fetchTransfersForAssets({ assetIds: wanted, asOfDate });
        results.forEach((row, position) => {
          rowsByAsset.get(`${row.seed_asset_id}|${asOfDate.toISOString()}`)?.push({
            seedAssetId: row.seed_asset_id,
            transferId: row.transfer_id,
            position,
            transaction: {
              transaction_id: row.transaction_id,
              event_id: row.event_id,
              investment_id: row.investment_id,
              due_to_rights_from_asset_id: row.due_to_rights_from_asset_id,
              close_date: row.close_date,
              convertedToId: row.converted_to_id,
            },
            transfer: {
              assetId: row.asset_id as AssetId,
              assetName: row.name,
              assetType: row.type,
              assetIssuerId: row.asset_issuer_id,
              numAssets: row.num_assets ?? 0,
              type: row.flowtype,
              investingEntityId: row.investing_entity_id as string as InvestingEntityId,
              investingEntityName: row.investing_entity_name,
              investees: row.investees,
            },
          });
        });
      }),
    );

    return rowsByAsset;
  },
});

async function getTransactionsForAssets({
  assetIds,
  asOfDate = new Date(),
}: {
  assetIds: string[];
  asOfDate?: Date;
}): Promise<AssetTransfer[]> {
  if (!assetIds.length) {
    return [];
  }

  const perAsset = await Promise.all(
    Array.from(new Set(assetIds)).map((assetId) => loadAssetTransfers({ assetId, asOfDate })),
  );

  // Back into one chronological stream. Two seeds that reached the same
  // transfer contribute one entry between them, carrying both their issuers —
  // which is what a single query over both assets would have aggregated.
  const merged = perAsset.flatMap((rows) => rows ?? []).sort((a, b) => a.position - b.position);

  const transactionMap = new Map<string, AssetTransfer>();
  const transferById = new Map<string, AssetTransfer['transfers'][number]>();

  for (const { transferId, transaction, transfer } of merged) {
    const seen = transferById.get(transferId);
    if (seen) {
      for (const investee of transfer.investees) {
        const known = seen.investees.some(
          (i) => i.id === investee.id && !!i.isAlsoIssuerOfAsset === !!investee.isAlsoIssuerOfAsset,
        );
        if (!known) seen.investees.push(investee);
      }
      continue;
    }

    if (!transactionMap.has(transaction.transaction_id)) {
      transactionMap.set(transaction.transaction_id, { ...transaction, transfers: [] });
    }
    const entry = { ...transfer, investees: [...transfer.investees] };
    transferById.set(transferId, entry);
    transactionMap.get(transaction.transaction_id)!.transfers.push(entry);
  }

  return Array.from(transactionMap.values());
}

async function fetchTransfersForAssets({
  assetIds,
  asOfDate,
}: {
  assetIds: string[];
  asOfDate: Date;
}) {
  // What we need is to get two types of transaction:
  // - exchanges of the assets
  // - cash from any entity whose value the asset tracks
  //
  // The paying entity is not always the issuer: a position held through an SPV
  // is issued by the SPV, but the wind-down payout, the dividend and the exit
  // proceeds all come from the company underneath it. Discovering only the
  // issuer's cash loses those flows entirely.

  // Resolve which entities each asset tracks up front rather than deriving it
  // inside the join. Expressed in SQL the SPV-target arm has to compare a JSONB
  // property to a uuid column, which is not indexable — Postgres abandons the
  // asset_transfer indexes and scans the whole table once per call. Carried in
  // as a pairing of plain uuids, every arm is an equality the indexes serve.
  const tracked = await getAssetTrackedEntities(assetIds);
  const pairedAssetIds: string[] = [];
  const pairedEntityIds: string[] = [];
  for (const [assetId, entityIds] of tracked) {
    for (const entityId of entityIds) {
      pairedAssetIds.push(assetId);
      pairedEntityIds.push(entityId);
    }
  }

  const query = getValuationsQb([
    'asset_transfer',
    'asset',
    'transaction',
    'legal_entity',
    'currency_asset',
  ])
    .selectFrom('asset as a')
    // One row per (asset, entity whose value it tracks). Left-joined so an
    // asset that tracks nothing still finds transfers of itself.
    .leftJoin(
      sql<{ asset_id: AssetId; entity_id: LegalEntityId }>`(select * from unnest(${sql.val(
        pairedAssetIds,
      )}::uuid[], ${sql.val(pairedEntityIds)}::uuid[]) as t(asset_id, entity_id))`.as('tracked'),
      'tracked.asset_id',
      'a.id',
    )
    .innerJoin('asset_transfer as at', (join) =>
      join.on(($) =>
        $.or([
          // Get either transfers of the asset itself
          $('at.asset_id', '=', $.ref('a.id')),
          // or transfers involving an entity the asset tracks
          $('at.from_legal_entity_id', '=', $.ref('tracked.entity_id')),
          $('at.to_legal_entity_id', '=', $.ref('tracked.entity_id')),
        ]),
      ),
    )
    .innerJoin('transaction as t', 't.id', 'at.transaction_id')
    .innerJoin('asset_transfer as at2', 'at2.transaction_id', 't.id')
    .innerJoin('asset as a2', 'a2.id', 'at2.asset_id')
    .leftJoin('currency_asset as ca', 'ca.asset_id', 'a2.id')
    .innerJoin('legal_entity as to', 'to.id', 'at2.to_legal_entity_id')
    .innerJoin('legal_entity as from', 'from.id', 'at2.from_legal_entity_id')
    .innerJoin('legal_entity as issuer', (join) =>
      join.on(($) =>
        $.and([
          $('issuer.id', '=', $.ref('a.issued_by_legal_entity_id')),
          $('issuer.is_portfolio', 'is distinct from', true),
          $('issuer.is_own_investing_entity', 'is distinct from', true),
        ]),
      ),
    )
    .select(($) => [
      // The asking asset and the transfer row: the merge in
      // `getTransactionsForAssets` keys on the transfer, and files each row
      // under the seed that reached it. Everything else below is a function of
      // the transfer alone — except `investees`, which names this seed's issuer
      // and so is unioned across the seeds a caller asked about.
      'a.id as seed_asset_id',
      'at2.id as transfer_id',
      't.id as transaction_id',
      't.event_id',
      't.investment_id',
      't.close_date',
      't.converted_to_id',
      't.due_to_rights_from_asset_id',
      'a2.id as asset_id',
      'a2.type',
      'a2.issued_by_legal_entity_id as asset_issuer_id',
      $.fn.coalesce($.cast<string>('ca.iso_code', 'text'), 'a2.name').as('name'),
      'at2.num_assets',
      jsonbAgg($, {
        id: 'issuer.id',
        name: 'issuer.name',
        isAlsoIssuerOfAsset: $('a2.issued_by_legal_entity_id', '=', $.ref('issuer.id')),
      })
        .distinct()
        .as('investees'),
      $.case()
        .when($.or([$('to.is_own_investing_entity', '=', true), $('to.is_portfolio', '=', true)]))
        .then('inflow' as const)
        .else('outflow' as const)
        .end()
        .as('flowtype'),
      $.case()
        .when($.or([$('to.is_own_investing_entity', '=', true), $('to.is_portfolio', '=', true)]))
        .then($.ref('to.id'))
        .when(
          $.or([$('from.is_own_investing_entity', '=', true), $('from.is_portfolio', '=', true)]),
        )
        .then($.ref('from.id'))
        .else(null)
        .end()
        .as('investing_entity_id'),
      $.case()
        .when($.or([$('to.is_own_investing_entity', '=', true), $('to.is_portfolio', '=', true)]))
        .then($.ref('to.name'))
        .when(
          $.or([$('from.is_own_investing_entity', '=', true), $('from.is_portfolio', '=', true)]),
        )
        .then($.ref('from.name'))
        .else(null)
        .end()
        .as('investing_entity_name'),
    ])
    .where('a.id', 'in', assetIds as AssetId[])
    .where('t.close_date', '<=', asOfDate)
    .where(($) =>
      $.or([
        $('to.is_own_investing_entity', '=', true),
        $('to.is_portfolio', '=', true),
        $('from.is_own_investing_entity', '=', true),
        $('from.is_portfolio', '=', true),
      ]),
    )
    .groupBy(['a.id', 't.id', 'at2.id', 'a2.id', 'to.id', 'from.id', 'ca.id'])
    // Same-day rows walk in one fixed order. A payout's split between cheques
    // depends on what is held when its row is walked, so leaving ties to the
    // query plan would let the same company value differently depending on
    // what else the batch was asked about.
    .orderBy('t.close_date', 'asc')
    .orderBy('t.id', 'asc')
    .orderBy('at2.id', 'asc');

  return query.execute();
}

/** The investee company under whose holdings an asset's flows are keyed. A
 *  self/same-issuer asset keys under its own issuer; an asset received as
 *  consideration for a tracked asset (e.g. an acquirer's shares taken in a
 *  share-for-share deal) INHERITS the disposed asset's investee, so its whole
 *  downstream life stays keyed under the original investment's company rather
 *  than fragmenting under the acquirer. */
type CanonicalInvestee = Map<string, { id: string; name: string }>;

async function recursiveGetTransactionsForAssets({
  investmentIds,
  assetIds,
  assets,
  transactions,
  asOfDate,
  canonicalInvestee,
}: {
  investmentIds: string[];
  assetIds: string[];
  assets: Set<string>;
  transactions: Set<string>;
  asOfDate: Date;
  canonicalInvestee: CanonicalInvestee;
}): Promise<AssetTransfer[]> {
  const allAssetTransfers: AssetTransfer[] = [];
  const assetTransactions = await getTransactionsForAssets({
    assetIds,
    asOfDate,
  });

  const assetIdsToRecurse: string[] = [];
  for (const txn of assetTransactions) {
    const { transaction_id, transfers } = txn;
    if (transactions.has(transaction_id)) continue;
    transactions.add(transaction_id);

    allAssetTransfers.push({
      ...txn,
      transfers,
    });

    // An asset transferred by its own issuer keys under that issuer.
    for (const t of transfers) {
      if (t.assetType === 'CURRENCY') continue;
      const issuer = t.investees.find((i) => !!i.isAlsoIssuerOfAsset);
      if (issuer && !canonicalInvestee.has(t.assetId)) {
        canonicalInvestee.set(t.assetId, { id: issuer.id, name: issuer.name });
      }
    }

    // If this transaction disposes of an asset we're already tracking, the
    // assets received in exchange are the continuation of that value and must
    // be followed too — even across an issuer boundary (an acquirer's shares
    // don't share the acquired company's issuer, so `isAlsoIssuerOfAsset`
    // alone would stop the walk at the swap).
    const disposedTracked = transfers.find(
      (t) => t.type === 'outflow' && t.assetType !== 'CURRENCY' && assets.has(t.assetId),
    );

    for (const { assetId: transferAssetId, assetType, investees, type } of transfers) {
      // don't recurse into currency
      if (assetType === 'CURRENCY') continue;
      const isSameIssuerConversion = investees.some((i) => !!i.isAlsoIssuerOfAsset);
      const isConsideration = type === 'inflow' && !!disposedTracked;
      if (!isSameIssuerConversion && !isConsideration) continue;
      // Consideration inherits the disposed asset's investee so its holdings
      // stay under the original investment's company.
      if (isConsideration && disposedTracked && !canonicalInvestee.has(transferAssetId)) {
        const inherited = canonicalInvestee.get(disposedTracked.assetId);
        if (inherited) canonicalInvestee.set(transferAssetId, inherited);
      }
      if (!assets.has(transferAssetId)) {
        assets.add(transferAssetId);
        assetIdsToRecurse.push(transferAssetId);
      }
    }
  }

  if (assetIdsToRecurse.length) {
    const childTransfers = await recursiveGetTransactionsForAssets({
      investmentIds,
      assetIds: assetIdsToRecurse,
      assets,
      transactions,
      asOfDate,
      canonicalInvestee,
    });

    allAssetTransfers.push(...childTransfers);
  }

  return allAssetTransfers;
}

export {
  CanonicalInvestee,
  getAssetHolderIdsForInvestments,
  getAssetsAndTransactionsForInvestments,
  recursiveGetTransactionsForAssets,
};
