import { AssetHolding, Holdings, InvesteeHoldings } from './holdings';
import { TransactionFlow } from './transactionFlows';
import {
  AssetFlow,
  AssetKey,
  InvesteeEntityKey,
  InvestingEntityKey,
  ProvenanceShare,
} from './types';

/** Cash is pinned at the moment it moved — the fund no longer bears its risk.
 *  Everything else is a position that still floats. */
type LotTense = 'fact' | 'live';

/**
 * One attributed flow, scoped to its (investing entity, investee) bucket. This
 * is an `AssetFlow` out of the roll-up with the walk's causal facts resolved:
 * where the value came from, and how many exchanges it sits away from the
 * company we invested in.
 */
interface Lot {
  investingEntityKey: InvestingEntityKey;
  investeeEntityKey: InvesteeEntityKey;
  assetKey: AssetKey;
  /** Signed and fractional: negative for disposals, split where a flow's
   *  attribution spans predecessors. */
  numAssets: number;
  date: Date;
  source: 'INVESTMENT' | 'OTHER';
  tense: LotTense;
  /** 0 if the asset tracks the bucket's investee, else one more than its
   *  predecessor's. A conversion into an asset that tracks resets to 0. */
  degree: number;
  provenanceAssetId: string | null;
}

/** The disposed non-currency assets an exchange's consideration came out of,
 *  weighted by how much of each left. Currency outflows are cash paid alongside
 *  the swap, not a predecessor of what arrived. */
function provenanceFromDisposals(
  outflows: TransactionFlow['outflows'],
): ProvenanceShare[] | undefined {
  return weightedShares(
    outflows
      .filter((flow) => flow.assetType !== 'CURRENCY')
      .map((flow) => [flow.assetId, flow.numAssets] as const),
  );
}

/** The holdings a one-way payment was attributed to, weighted by the balances
 *  that attribution rests on. Weights only decide which degree each split lands
 *  in; the amounts stay whatever the walk computed. */
function provenanceFromHoldings(
  holdings: (readonly [AssetKey, AssetHolding])[],
): ProvenanceShare[] | undefined {
  return weightedShares(
    holdings.map(([assetKey, holding]) => {
      const { fromInvestment, fromOtherTransactions } = holding.sum();
      return [assetKey.split(':')[0], Math.abs(fromInvestment + fromOtherTransactions)] as const;
    }),
  );
}

function weightedShares(
  weights: (readonly [string, number])[],
): ProvenanceShare[] | undefined {
  const byAsset = new Map<string, number>();
  for (const [assetId, weight] of weights) {
    if (!(weight > 0)) continue;
    byAsset.set(assetId, (byAsset.get(assetId) ?? 0) + weight);
  }

  const total = Array.from(byAsset.values()).reduce((sum, weight) => sum + weight, 0);
  if (!total) return undefined;

  return Array.from(byAsset).map(([assetId, weight]) => ({ assetId, weight: weight / total }));
}

/** Every flow in a holding, tagged with the bucket it was filed under. */
function flowsWithSource(
  holding: AssetHolding,
): { flow: AssetFlow; source: 'INVESTMENT' | 'OTHER' }[] {
  return [
    ...holding.data.fromInvestment.map((flow) => ({ flow, source: 'INVESTMENT' as const })),
    ...holding.data.fromOtherTransactions.map((flow) => ({ flow, source: 'OTHER' as const })),
  ];
}

function toLots({
  holdings,
  trackedEntities,
}: {
  holdings: Holdings;
  trackedEntities: Map<string, Set<string>>;
}): Lot[] {
  return holdings
    .entries()
    .flatMap(([investingEntityKey, investeeEntityKey, investeeHoldings]) =>
      bucketLots({ investingEntityKey, investeeEntityKey, investeeHoldings, trackedEntities }),
    );
}

function bucketLots({
  investingEntityKey,
  investeeEntityKey,
  investeeHoldings,
  trackedEntities,
}: {
  investingEntityKey: InvestingEntityKey;
  investeeEntityKey: InvesteeEntityKey;
  investeeHoldings: InvesteeHoldings;
  trackedEntities: Map<string, Set<string>>;
}): Lot[] {
  const investeeId = investeeEntityKey.split(':')[0];
  const tracksInvestee = (assetId: string) =>
    trackedEntities.get(assetId)?.has(investeeId) ?? false;

  // Every predecessor recorded against an asset anywhere in this bucket. Degree
  // is bucket-scoped precisely because this map is: an acquirer's equity is one
  // exchange away under the acquired company's bucket and zero away under a
  // bucket rooted at a direct investment into the acquirer.
  const predecessors = new Map<string, Set<string>>();
  for (const [assetKey, holding] of investeeHoldings.entries()) {
    const assetId = assetKey.split(':')[0];
    for (const { flow } of flowsWithSource(holding)) {
      for (const share of flow.provenance ?? []) {
        if (share.assetId === assetId) continue;
        const existing = predecessors.get(assetId);
        if (existing) existing.add(share.assetId);
        else predecessors.set(assetId, new Set([share.assetId]));
      }
    }
  }

  const resolved = new Map<string, number>();
  const resolving = new Set<string>();
  const assetDegree = (assetId: string): number => {
    const memo = resolved.get(assetId);
    if (memo !== undefined) return memo;
    if (tracksInvestee(assetId)) {
      resolved.set(assetId, 0);
      return 0;
    }
    const preds = predecessors.get(assetId);
    // No predecessor means nothing to step back from — a root inflow of an asset
    // that doesn't track sits at the root all the same. A cycle is pathological
    // data; break it here rather than let it decide a number.
    if (!preds?.size || resolving.has(assetId)) return 0;

    resolving.add(assetId);
    const degree = 1 + Math.min(...Array.from(preds).map(assetDegree));
    resolving.delete(assetId);
    resolved.set(assetId, degree);
    return degree;
  };

  const lotDegree = ({
    assetId,
    provenanceAssetId,
    numAssets,
    tense,
  }: {
    assetId: string;
    provenanceAssetId: string | null;
    numAssets: number;
    tense: LotTense;
  }): number => {
    if (tracksInvestee(assetId)) return 0;
    if (provenanceAssetId !== null) return 1 + assetDegree(provenanceAssetId);
    // A disposal records a holding leaving, so it sits where that holding
    // arrived. Negative cash is money spent rather than a position sold — the
    // walk never carries cash holdings — so it stays at the root.
    if (numAssets < 0 && tense === 'live') return assetDegree(assetId);
    return 0;
  };

  const lots: Lot[] = [];
  for (const [assetKey, holding] of investeeHoldings.entries()) {
    const assetId = assetKey.split(':')[0];
    const tense: LotTense = assetKey.split(':')[2] === 'CURRENCY' ? 'fact' : 'live';

    for (const { flow, source } of flowsWithSource(holding)) {
      const base = { investingEntityKey, investeeEntityKey, assetKey, date: flow.date, source, tense };

      // A flow caused by the asset itself — a share split's extra shares — is
      // not a step away from the investee, so the lot keeps the asset's degree.
      const shares = (flow.provenance ?? []).filter((share) => share.assetId !== assetId);
      const totalWeight = shares.reduce((sum, share) => sum + share.weight, 0);

      if (!shares.length || !totalWeight) {
        lots.push({
          ...base,
          numAssets: flow.numAssets,
          degree: lotDegree({
            assetId,
            provenanceAssetId: null,
            numAssets: flow.numAssets,
            tense,
          }),
          provenanceAssetId: null,
        });
        continue;
      }

      // Split by predecessor so a payment attributed across holdings of
      // different degrees lands in each. The last share takes the residual, so
      // the split re-aggregates to the flow exactly.
      let remaining = flow.numAssets;
      shares.forEach((share, index) => {
        const numAssets =
          index === shares.length - 1
            ? remaining
            : flow.numAssets * (share.weight / totalWeight);
        remaining -= numAssets;
        lots.push({
          ...base,
          numAssets,
          degree: lotDegree({
            assetId,
            provenanceAssetId: share.assetId,
            numAssets,
            tense,
          }),
          provenanceAssetId: share.assetId,
        });
      });
    }
  }

  return lots;
}

export { Lot, LotTense, provenanceFromDisposals, provenanceFromHoldings, toLots };
