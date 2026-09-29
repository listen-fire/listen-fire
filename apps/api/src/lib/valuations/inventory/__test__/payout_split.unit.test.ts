// A payout to a fund holding several cheques in one company is split between
// them by the shares each held just before the event. A wind-down is often
// recorded as two same-day transactions — the shares go back, the cash comes
// in — and a later distribution arrives with nothing held at all. At the
// instant those cash rows are walked the holdings can be empty, so the split
// has to come from what was held before, not from rounding residue.

import { rollUpHoldings } from '..';
import {
  getAssetHolderIdsForInvestments,
  getAssetsAndTransactionsForInvestments,
  recursiveGetTransactionsForAssets,
} from '../data';
import { AssetId, AssetTransfer, getInvesteeEntityKey, getInvestingEntityKey } from '../types';

jest.mock('../data', () => ({
  getAssetHolderIdsForInvestments: jest.fn(),
  getAssetsAndTransactionsForInvestments: jest.fn(),
  recursiveGetTransactionsForAssets: jest.fn(),
}));

const FUND_ID = 'fund-1';
const COMPANY = { id: 'company-1', name: 'Company A' };

const SEED = 'asset-seed' as AssetId;
const SERIES_A = 'asset-series-a' as AssetId;
const USD = 'asset-usd' as AssetId;

const SEED_INVESTMENT = 'investment-seed';
const SERIES_A_INVESTMENT = 'investment-series-a';

const SEED_SHARES = 43_550;
const SERIES_A_SHARES = 7_141;
const WIND_DOWN_CASH = 8_093.56;
const LATER_DISTRIBUTION = 589.39;
const TOTAL_PAYOUT = WIND_DOWN_CASH + LATER_DISTRIBUTION;

const ASSET_NAMES: Record<string, [string, string]> = {
  [SEED]: ['A Seed Shares', 'EQUITY'],
  [SERIES_A]: ['A Series A Shares', 'EQUITY'],
  [USD]: ['USD', 'CURRENCY'],
};

function transfer(
  assetId: AssetId,
  numAssets: number,
  type: 'inflow' | 'outflow',
): AssetTransfer['transfers'][number] {
  const [assetName, assetType] = ASSET_NAMES[assetId];
  return {
    assetId,
    assetName,
    assetType,
    assetIssuerId: COMPANY.id,
    numAssets,
    type,
    investingEntityId: FUND_ID as AssetTransfer['transfers'][number]['investingEntityId'],
    investingEntityName: 'Our Fund',
    investees: [{ ...COMPANY, isAlsoIssuerOfAsset: assetId !== USD }],
  };
}

function transaction(
  id: string,
  date: string,
  transfers: AssetTransfer['transfers'],
  investmentId: string | null = null,
): AssetTransfer {
  return {
    transaction_id: id,
    investment_id: investmentId,
    convertedToId: null,
    due_to_rights_from_asset_id: null,
    close_date: new Date(date),
    event_id: null,
    transfers,
  };
}

const seedCheque = transaction(
  'txn-seed',
  '2020-01-01',
  [transfer(USD, 100_000, 'outflow'), transfer(SEED, SEED_SHARES, 'inflow')],
  SEED_INVESTMENT,
);
const seriesACheque = transaction(
  'txn-series-a',
  '2021-01-01',
  [transfer(USD, 50_000, 'outflow'), transfer(SERIES_A, SERIES_A_SHARES, 'inflow')],
  SERIES_A_INVESTMENT,
);
const shareReturn = transaction('txn-share-return', '2026-03-23', [
  transfer(SEED, SEED_SHARES, 'outflow'),
  transfer(SERIES_A, SERIES_A_SHARES, 'outflow'),
]);
const windDownCash = transaction('txn-wind-down-cash', '2026-03-23', [
  transfer(USD, WIND_DOWN_CASH, 'inflow'),
]);
const laterDistribution = transaction('txn-distribution', '2026-06-01', [
  transfer(USD, LATER_DISTRIBUTION, 'inflow'),
]);

const SEEDS: Record<string, { assetIds: string[]; transactionIds: string[] }> = {
  [SEED_INVESTMENT]: { assetIds: [SEED], transactionIds: [seedCheque.transaction_id] },
  [SERIES_A_INVESTMENT]: { assetIds: [SERIES_A], transactionIds: [seriesACheque.transaction_id] },
};

/** Walk the given transactions, in the given order, valuing `investmentIds`.
 *  Returns the cash realised against those investments. */
async function realised(investmentIds: string[], walk: AssetTransfer[]): Promise<number> {
  jest.mocked(getAssetHolderIdsForInvestments).mockResolvedValue([FUND_ID]);
  jest.mocked(getAssetsAndTransactionsForInvestments).mockResolvedValue({
    assetIds: new Set(investmentIds.flatMap((id) => SEEDS[id].assetIds)),
    transactionIds: new Set(investmentIds.flatMap((id) => SEEDS[id].transactionIds)),
  });
  jest.mocked(recursiveGetTransactionsForAssets).mockResolvedValue(walk);

  const { holdings } = await rollUpHoldings({
    investmentIds,
    asOfDate: new Date('2026-09-29'),
  });

  const cash = holdings
    .get(
      getInvestingEntityKey({ investingEntityId: FUND_ID, investingEntityName: 'Our Fund' }),
      getInvesteeEntityKey({ investeeEntityId: COMPANY.id, investeeEntityName: COMPANY.name }),
    )
    .entries()
    .find(([assetKey]) => assetKey.startsWith(`${USD}:`))?.[1];

  const received = (cash?.data.fromInvestment ?? [])
    .filter((flow) => flow.numAssets > 0)
    .reduce((sum, flow) => sum + flow.numAssets, 0);
  return Math.round(received * 100) / 100;
}

const proRata = (shares: number) =>
  Math.round(((TOTAL_PAYOUT * shares) / (SEED_SHARES + SERIES_A_SHARES)) * 100) / 100;

describe('payout split across several cheques in one company', () => {
  const sharesFirst = [seedCheque, seriesACheque, shareReturn, windDownCash, laterDistribution];
  const cashFirst = [seedCheque, seriesACheque, windDownCash, shareReturn, laterDistribution];

  it.each([
    ['shares returned before the cash', sharesFirst],
    ['cash before the shares are returned', cashFirst],
  ])(
    'splits a same-day wind-down by the shares each cheque held (%s)',
    async (_, walk) => {
      expect(await realised([SEED_INVESTMENT], walk)).toBeCloseTo(proRata(SEED_SHARES), 1);
      expect(await realised([SERIES_A_INVESTMENT], walk)).toBeCloseTo(
        proRata(SERIES_A_SHARES),
        1,
      );
      expect(await realised([SEED_INVESTMENT, SERIES_A_INVESTMENT], walk)).toBeCloseTo(
        TOTAL_PAYOUT,
        2,
      );
    },
  );

  it('splits a later distribution with nothing held by the shares held before the wind-down', async () => {
    const distributionOnly = [seedCheque, seriesACheque, shareReturn, laterDistribution];
    const share = (shares: number) =>
      Math.round(((LATER_DISTRIBUTION * shares) / (SEED_SHARES + SERIES_A_SHARES)) * 100) / 100;

    expect(await realised([SEED_INVESTMENT], distributionOnly)).toBeCloseTo(share(SEED_SHARES), 1);
    expect(await realised([SERIES_A_INVESTMENT], distributionOnly)).toBeCloseTo(
      share(SERIES_A_SHARES),
      1,
    );
  });

  it('gives a lone cheque the whole payout', async () => {
    const walk = [seedCheque, shareReturn, windDownCash, laterDistribution].map((txn) =>
      txn === shareReturn
        ? { ...txn, transfers: txn.transfers.filter((t) => t.assetId === SEED) }
        : txn,
    );

    expect(await realised([SEED_INVESTMENT], walk)).toBeCloseTo(TOTAL_PAYOUT, 2);
  });
});
