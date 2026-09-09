type InvestingEntityId = string & { __brand: 'InvestingEntityId' };
type InvestingEntityName = string & { __brand: 'InvestingEntityName' };
type InvestingEntityKey = `${InvestingEntityId}:${InvestingEntityName}`;
type AssetId = string & { __brand: 'valuations.asset' };
type AssetName = string & { __brand: 'AssetName' };
type AssetType = string & { __brand: 'AssetType' };
type AssetKey = `${AssetId}:${AssetName}:${AssetType}`;
type InvesteeEntityId = string & { __brand: 'InvesteeEntityId' };
type InvesteeEntityName = string & { __brand: 'InvesteeEntityName' };
type InvesteeEntityKey = `${InvesteeEntityId}:${InvesteeEntityName}`;

function getInvestingEntityKey({
  investingEntityId,
  investingEntityName,
}: {
  investingEntityId: string;
  investingEntityName: string | null | undefined;
}): InvestingEntityKey {
  return `${investingEntityId as InvestingEntityId}:${(investingEntityName ?? '').toString() as InvestingEntityName}`;
}

function getInvesteeEntityKey({
  investeeEntityId,
  investeeEntityName,
}: {
  investeeEntityId: string;
  investeeEntityName: string;
}): InvesteeEntityKey {
  return `${investeeEntityId as InvesteeEntityId}:${investeeEntityName as InvesteeEntityName}`;
}

function getAssetKey({
  assetId,
  assetName,
  assetType,
}: {
  assetId: string;
  assetName: string;
  assetType: string;
}): AssetKey {
  return `${assetId as AssetId}:${assetName as AssetName}:${assetType as AssetType}`;
}

type TransactionId = string;

interface AssetTransfer {
  transaction_id: TransactionId;
  convertedToId: string | null;
  investment_id: string | null;
  due_to_rights_from_asset_id: string | null;
  close_date: Date;
  event_id: string | null;
  transfers: Array<{
    assetId: AssetId;
    assetName: string;
    assetType: string;
    /** The entity that issued the asset moved — the payer of a dividend paid on
     *  rights we hold, which cash itself can never name. */
    assetIssuerId: string | null;
    numAssets: number;
    type: 'inflow' | 'outflow';
    investingEntityId?: InvestingEntityId | null;
    investingEntityName?: string | null;
    investees: {
      id: string;
      name: string;
      isAlsoIssuerOfAsset: boolean | 0 | 1;
    }[];
  }>;
}

/** One causal predecessor of an inflow, with the share of it attributable to
 *  that predecessor. Weights across a flow's shares sum to 1. */
interface ProvenanceShare {
  assetId: string;
  weight: number;
}

interface AssetFlow {
  numAssets: number;
  date: Date;
  /** The holding(s) whose disposal or existence caused this inflow — the swap's
   *  disposed asset, or the holding a one-way payment was attributed to. Absent
   *  on outflows (the record IS the asset leaving) and on root investment
   *  inflows, where the asset's own tracking check fixes its degree. */
  provenance?: ProvenanceShare[];
}

export {
  AssetId,
  InvestingEntityId,
  AssetTransfer,
  AssetFlow,
  ProvenanceShare,
  InvestingEntityKey,
  InvesteeEntityKey,
  AssetKey,
  getInvestingEntityKey,
  getInvesteeEntityKey,
  getAssetKey,
};
