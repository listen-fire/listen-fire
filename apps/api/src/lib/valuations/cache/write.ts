import { sql } from 'kysely';

import { getQb } from '../../kysely';
import { currentContext } from '../../../services/context';
import { rollUpHoldings } from '../inventory';
import { toLots } from '../inventory/lots';
import { getAssetTrackedEntities } from '../trackedEntities';
import { extractDeltasFromLots, DeltaEvent } from './extract';

async function warmInventoryCacheForInvestment({
  investmentId,
  asOfDate,
  strategy = 'FIFO',
}: {
  investmentId: string;
  asOfDate?: Date;
  strategy?: 'LIFO' | 'FIFO';
}): Promise<{ eventsWritten: number }> {
  const { holdings, classifiedTransactionFlows } = await rollUpHoldings({
    investmentIds: [investmentId],
    asOfDate,
    strategy,
  });

  // Resolve, once, which entities each held asset tracks — the same graph fact
  // the live path uses twice over: to split retained into "in the company" and
  // "in what it became", and to seat each lot at its causal degree.
  const assetIds = new Set<string>();
  for (const investeeHoldings of holdings.values()) {
    for (const assetKey of investeeHoldings.keys()) {
      assetIds.add(assetKey.split(':')[0]);
    }
  }
  const trackedEntities = await getAssetTrackedEntities(Array.from(assetIds));

  // The cache is a store of the walk's leaf lots, bucketed. Deriving it from
  // `toLots` rather than from raw holdings is what carries degree into it, and
  // is why the cached read can answer every atom the walk answers.
  const lots = toLots({ holdings, trackedEntities });

  const deltas = extractDeltasFromLots({
    lots,
    classifiedTransactionFlows,
    trackedEntities,
  });
  return persistDeltas({ investmentId, deltas });
}

async function persistDeltas({
  investmentId,
  deltas,
}: {
  investmentId: string;
  deltas: DeltaEvent[];
}): Promise<{ eventsWritten: number }> {
  const teamId = currentContext().user.teamId;
  const qb = getQb();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await qb.transaction().execute(async (trx: any) => {
    await sql`
      DELETE FROM public.inventory_delta_event
      WHERE investment_id = ${investmentId}::uuid
        AND team_id = ${teamId}::uuid
    `.execute(trx);

    for (const event of deltas) {
      const inserted = await sql<{ id: string }>`
        INSERT INTO public.inventory_delta_event (team_id, investment_id, close_date, has_non_cash_investment)
        VALUES (${teamId}::uuid, ${investmentId}::uuid, ${event.closeDate}, ${event.hasNonCashInvestment})
        RETURNING id
      `.execute(trx);

      const eventId = inserted.rows[0].id;
      if (!event.holdings.length) continue;

      const values = event.holdings
        .map(
          (h) =>
            sql`(${eventId}::uuid, ${h.assetId}::uuid, ${h.assetType}::valuations."AssetType", ${h.degree}::integer, ${h.isInflow}, ${h.numAssets}::double precision, ${h.tracksInvestee})`,
        )
        .reduce((acc, row, i) => (i === 0 ? row : sql`${acc}, ${row}`));

      await sql`
        INSERT INTO public.inventory_delta_holding (event_id, asset_id, asset_type, degree, is_inflow, num_assets, tracks_investee)
        VALUES ${values}
      `.execute(trx);
    }
  });

  return { eventsWritten: deltas.length };
}

export { warmInventoryCacheForInvestment, persistDeltas };
