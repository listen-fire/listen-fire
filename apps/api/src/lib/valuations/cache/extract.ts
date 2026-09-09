import AssetType from '../../../generated/kysely/valuations/AssetType';
import { Lot } from '../inventory/lots';
import { ClassifiedTransactionFlow } from '../inventory';

/**
 * One degree bucket of the roll-up's leaf lots on one close date. Prices and FX
 * are never baked in — quantities are the only cacheable fact, so the read path
 * applies the analysis date's price and each flow's own rate exactly as the walk
 * does.
 */
interface DeltaHolding {
  assetId: string;
  assetType: AssetType;
  /** Causal degree of every lot summed here — 0 at the company invested into,
   *  one more per exchange away from it. Cash at degree 1 is what the company
   *  itself paid. */
  degree: number;
  /** Which side of the flow. Value is linear in `numAssets`, so summing lots
   *  inside a bucket is lossless; but realised and invested are split by flow
   *  SIGN, so an inflow and an outflow must never net into one bucket. */
  isInflow: boolean;
  numAssets: number;
  // Does this held asset still track the value of the company we invested in?
  // Resolved from the same graph facts as the live valuation path
  // (getAssetTrackedEntities): a non-cash asset that has stopped tracking the
  // investee is retained in what the company became, not in the company itself.
  // Not implied by degree — an inflow with no predecessor sits at 0 either way.
  tracksInvestee: boolean;
}

interface DeltaEvent {
  closeDate: Date;
  hasNonCashInvestment: boolean;
  holdings: DeltaHolding[];
}

function extractDeltasFromLots({
  lots,
  classifiedTransactionFlows,
  trackedEntities,
}: {
  lots: Lot[];
  classifiedTransactionFlows: ClassifiedTransactionFlow[];
  // asset id → set of legal-entity ids whose value the asset tracks.
  trackedEntities: Map<string, Set<string>>;
}): DeltaEvent[] {
  const nonCashDates = new Set<string>();
  for (const flow of classifiedTransactionFlows) {
    if (flow.classification === 'NON_CASH_INVESTMENT') {
      nonCashDates.add(flow.date.toISOString());
    }
  }

  const byDate = new Map<string, Map<string, DeltaHolding>>();

  for (const lot of lots) {
    // The walk's valuation reads the investment bucket only; flows filed under
    // other transactions are not part of what this investment returned.
    if (lot.source !== 'INVESTMENT') continue;

    const [assetId, , assetTypeStr] = lot.assetKey.split(':');
    const assetType = assetTypeStr as AssetType;
    const investeeId = lot.investeeEntityKey.split(':')[0];
    const tracksInvestee = trackedEntities.get(assetId)?.has(investeeId) ?? false;
    const isInflow = lot.numAssets > 0;

    const dateKey = lot.date.toISOString();
    let dayMap = byDate.get(dateKey);
    if (!dayMap) {
      dayMap = new Map();
      byDate.set(dateKey, dayMap);
    }

    const bucketKey = `${assetId}:${lot.degree}:${tracksInvestee}:${isInflow}`;
    const existing = dayMap.get(bucketKey);
    if (existing) {
      existing.numAssets += lot.numAssets;
    } else {
      dayMap.set(bucketKey, {
        assetId,
        assetType,
        degree: lot.degree,
        isInflow,
        numAssets: lot.numAssets,
        tracksInvestee,
      });
    }
  }

  return Array.from(byDate.entries())
    .map(([dateKey, dayMap]) => ({
      closeDate: new Date(dateKey),
      hasNonCashInvestment: nonCashDates.has(dateKey),
      holdings: Array.from(dayMap.values()).filter((h) => h.numAssets !== 0),
    }))
    .filter((event) => event.holdings.length > 0)
    .sort((a, b) => a.closeDate.getTime() - b.closeDate.getTime());
}

export { extractDeltasFromLots, DeltaEvent, DeltaHolding };
