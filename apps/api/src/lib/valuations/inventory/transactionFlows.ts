import { AssetId, InvesteeEntityKey, InvestingEntityKey } from './types';

type Flow = {
  assetId: AssetId;
  assetName: string;
  assetType: string;
  numAssets: number;
};

type TransactionFlow = {
  transactionId: string;
  investmentId: string | null;
  inflows: Array<Flow>;
  outflows: Array<Flow>;
};

// This is basically a grouping of transactions with some helper functions
class TransactionFlowsByEntity {
  private flows = new Map<InvestingEntityKey, Map<InvesteeEntityKey, TransactionFlow>>();

  get({
    investingEntityKey,
    investeeEntityKey,
    transactionId,
    investmentId,
  }: {
    investingEntityKey: InvestingEntityKey;
    investeeEntityKey: InvesteeEntityKey;
    transactionId: string;
    investmentId: string | null;
  }) {
    if (!this.flows.has(investingEntityKey)) {
      this.flows.set(investingEntityKey, new Map());
    }
    const flowsByInvestee = this.flows.get(investingEntityKey)!;
    if (!flowsByInvestee.has(investeeEntityKey)) {
      flowsByInvestee.set(investeeEntityKey, {
        transactionId,
        investmentId,
        inflows: [],
        outflows: [],
      });
    }

    return flowsByInvestee.get(investeeEntityKey)!;
  }

  entries() {
    return this.flows.entries() as IterableIterator<
      [InvestingEntityKey, Map<InvesteeEntityKey, TransactionFlow>]
    >;
  }

  addFlow(
    investingEntityKey: InvestingEntityKey,
    investeeEntityKey: InvesteeEntityKey,
    {
      assetId,
      assetName,
      assetType,
      numAssets,
      transactionId,
      investmentId,
      type,
    }: {
      assetId: AssetId;
      assetName: string;
      assetType: string;
      numAssets: number;
      transactionId: string;
      investmentId: string | null;
      type: 'inflow' | 'outflow';
    },
  ) {
    this.get({
      investingEntityKey,
      investeeEntityKey,
      transactionId,
      investmentId,
    })[`${type}s`].push({
      assetId,
      assetName,
      assetType,
      numAssets,
    });
  }
}

type TransactionFlowClassification =
  | 'CASH_INVESTMENT' // we've invested cash
  | 'NON_CASH_INVESTMENT' // we've invested non-cash assets - e.g. an acquisition
  | 'ASSET_EXCHANGE_FOR_NEW_INVESTMENT' // this is a non-cash asset exchange associated with a different investment
  | 'ASSET_EXCHANGE' // this is an exchange of assets without a new investment (e.g. SAFE -> Equity)
  | 'ASSET_PURCHASE' // this is a purchase of an asset - this should be a different investment
  | 'UNRELATED_ASSET_EXCHANGE' // an exchange of assets that have nothing to do with our investments
  | 'ONE_WAY_TRANSACTION'; // a one-way transaction (e.g. a dividend or share split)

// Classifies a transaction flow based on the assets and transactions it contains
function classifyTransactionFlow({
  transactionFlow,
  assetIds,
  transactionIds,
  transactionId,
}: {
  transactionFlow: TransactionFlow;
  assetIds: Set<string>;
  transactionIds: Set<string>;
  transactionId: string;
}) {
  let classification: TransactionFlowClassification;

  if (transactionIds.has(transactionId)) {
    // it's one of the original investments we're looking at

    // handle acquisition investments (for investments in the acquirer)
    const nonInvestmentAssets = transactionFlow.outflows.filter(
      (flow) =>
        flow.assetType !== 'CURRENCY' &&
        flow.assetType !== 'FUND_OUTSTANDING_COMMITMENT' &&
        !assetIds.has(flow.assetId),
    );
    classification = nonInvestmentAssets.length > 0 ? 'NON_CASH_INVESTMENT' : 'CASH_INVESTMENT';
  } else if (
    transactionFlow.outflows.some((flow) => assetIds.has(flow.assetId)) &&
    transactionFlow.inflows.length
  ) {
    // we're selling or exchanging an asset that we're looking at
    classification = transactionFlow.investmentId
      ? 'ASSET_EXCHANGE_FOR_NEW_INVESTMENT'
      : 'ASSET_EXCHANGE';
  } else if (
    transactionFlow.inflows.some((flow) => assetIds.has(flow.assetId)) &&
    transactionFlow.outflows.length
  ) {
    // we're buying an asset that we're looking at
    classification = 'ASSET_PURCHASE';
  } else if (transactionFlow.inflows.length && transactionFlow.outflows.length) {
    // it's an exchange of assets that we're not looking at
    classification = 'UNRELATED_ASSET_EXCHANGE';
  } else {
    // it's either a pure inflow or outflow of assets
    classification = 'ONE_WAY_TRANSACTION';
  }

  return classification;
}

export {
  TransactionFlowsByEntity,
  classifyTransactionFlow,
  TransactionFlow,
  TransactionFlowClassification,
};
