import { TransactionFlow } from './transactionFlows';
import {
  AssetFlow,
  AssetKey,
  getAssetKey,
  InvesteeEntityKey,
  InvestingEntityKey,
  ProvenanceShare,
} from './types';
import { round } from './utils';

class AssetHolding {
  data: {
    fromInvestment: AssetFlow[];
    fromOtherTransactions: AssetFlow[];
  };

  constructor() {
    this.data = {
      fromInvestment: [],
      fromOtherTransactions: [],
    };
  }

  sum() {
    return {
      fromInvestment: this.data.fromInvestment.reduce((acc, flow) => acc + flow.numAssets, 0),
      fromOtherTransactions: this.data.fromOtherTransactions.reduce(
        (acc, flow) => acc + flow.numAssets,
        0,
      ),
    };
  }

  count() {
    return {
      fromInvestment: this.data.fromInvestment.length,
      fromOtherTransactions: this.data.fromOtherTransactions.length,
    };
  }

  add(assetFlow: AssetFlow, source: 'INVESTMENT' | 'OTHER') {
    if (source === 'INVESTMENT') {
      this.data.fromInvestment.push(assetFlow);
    } else {
      this.data.fromOtherTransactions.push(assetFlow);
    }
  }

  toFlat() {
    return [
      ...this.data.fromInvestment
        .filter((flow) => flow.numAssets > 0)
        .map((flow) => ({ ...flow, source: 'investment' as const })),
      ...this.data.fromOtherTransactions
        .filter((flow) => flow.numAssets > 0)
        .map((flow) => ({ ...flow, source: 'other' as const })),
    ];
  }
}

class InvesteeHoldings {
  private data: Record<AssetKey, AssetHolding>;

  constructor() {
    this.data = {};
  }

  get(assetKey: AssetKey): AssetHolding {
    if (!this.data[assetKey]) {
      this.data[assetKey] = new AssetHolding();
    }
    return this.data[assetKey];
  }

  getManyByType(assetType: string | ((type: string) => boolean)) {
    const holdingsByType = this.entries().filter(([assetKey]) => {
      const type = assetKey.split(':')[2];
      return typeof assetType === 'string' ? type === assetType : assetType(type);
    });

    return holdingsByType;
  }

  entries() {
    return Object.entries(this.data) as [AssetKey, AssetHolding][];
  }

  keys() {
    return Object.keys(this.data) as AssetKey[];
  }

  values() {
    return Object.values(this.data);
  }

  proportionallyAdd({
    transactionFlow,
    investmentProportion,
    date,
    inflowProvenance,
  }: {
    transactionFlow: TransactionFlow;
    investmentProportion: number;
    date: Date;
    inflowProvenance?: ProvenanceShare[];
  }) {
    for (const flow of transactionFlow.inflows) {
      const assetKey = getAssetKey(flow);

      const investmentAmount = round(flow.numAssets * investmentProportion);
      const otherAmount = round(flow.numAssets - investmentAmount);

      if (investmentAmount > 0) {
        this.get(assetKey).add(
          {
            numAssets: investmentAmount,
            date,
            provenance: inflowProvenance,
          },
          'INVESTMENT',
        );
      }
      if (otherAmount > 0) {
        this.get(assetKey).add(
          {
            numAssets: otherAmount,
            date,
            provenance: inflowProvenance,
          },
          'OTHER',
        );
      }
    }

    for (const flow of transactionFlow.outflows) {
      const assetKey = getAssetKey(flow);

      const investmentAmount = round(flow.numAssets * investmentProportion);
      const otherAmount = round(flow.numAssets - investmentAmount);

      if (investmentAmount > 0) {
        this.get(assetKey).add(
          {
            numAssets: -investmentAmount,
            date,
          },
          'INVESTMENT',
        );
      }
      if (otherAmount > 0) {
        this.get(assetKey).add(
          {
            numAssets: -otherAmount,
            date,
          },
          'OTHER',
        );
      }
    }
  }

  classifySplit() {
    const holdingsBreakdown = this.values().reduce(
      (acc, holding) => {
        const count = holding.count();
        acc.fromInvestment += count.fromInvestment;
        acc.fromOtherTransactions += count.fromOtherTransactions;
        return acc;
      },
      { fromInvestment: 0, fromOtherTransactions: 0 } as {
        fromInvestment: number;
        fromOtherTransactions: number;
      },
    );

    return holdingsBreakdown.fromInvestment === 0 && holdingsBreakdown.fromOtherTransactions === 0
      ? 'EMPTY'
      : holdingsBreakdown.fromInvestment === 0
        ? 'OTHER_ONLY'
        : holdingsBreakdown.fromOtherTransactions === 0
          ? 'INVESTMENT_ONLY'
          : 'MIXED';
  }
}

class Holdings {
  private data: Record<InvestingEntityKey, Record<InvesteeEntityKey, InvesteeHoldings>>;

  constructor() {
    this.data = {};
  }

  get(
    investingEntityKey: InvestingEntityKey,
    investeeEntityKey: InvesteeEntityKey,
  ): InvesteeHoldings {
    if (!this.data[investingEntityKey]) {
      this.data[investingEntityKey] = {};
    }
    if (!this.data[investingEntityKey][investeeEntityKey]) {
      this.data[investingEntityKey][investeeEntityKey] = new InvesteeHoldings();
    }

    return this.data[investingEntityKey][investeeEntityKey];
  }

  toString() {
    return JSON.stringify(
      this.entries().map(([investingEntityKey, investeeEntityKey, holdings]) => {
        return [
          investingEntityKey,
          investeeEntityKey,
          holdings.entries().map(([assetKey, holding]) => [assetKey, holding.data]),
        ];
      }),
    );
  }

  entries(): (readonly [InvestingEntityKey, InvesteeEntityKey, InvesteeHoldings])[] {
    const entries = Object.entries(this.data) as [
      InvestingEntityKey,
      Record<InvesteeEntityKey, InvesteeHoldings>,
    ][];
    return entries.flatMap(([investingEntityKey, investeeHoldings]) => {
      return (Object.entries(investeeHoldings) as [InvesteeEntityKey, InvesteeHoldings][]).map(
        ([investeeEntityKey, holdings]) => {
          return [investingEntityKey, investeeEntityKey, holdings] as const;
        },
      );
    });
  }

  values(): InvesteeHoldings[] {
    return Object.values(this.data).flatMap((investeeHoldings) => {
      return Object.values(investeeHoldings);
    });
  }
}

export { Holdings, InvesteeHoldings, AssetHolding };
