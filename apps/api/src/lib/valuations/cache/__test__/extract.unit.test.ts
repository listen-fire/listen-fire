// What the cache is allowed to collapse.
//
// A cached row is a SUM of lots, so the bucket key decides what the read path
// can still tell apart. Value is linear in quantity — one price, one rate per
// (date, asset) — so lots inside a bucket may be added freely. But two of the
// read path's questions are asked per lot, not per bucket:
//
//   • causal degree     — "did the company itself pay this?" (direct realised)
//   • the flow's SIGN   — money received is realised, money paid is invested
//
// so both are key columns. Collapsing across either would net away an answer
// the walk gives, and the cache would stop being a pure optimisation.

import { extractDeltasFromLots } from '../extract';
import { Lot } from '../../inventory/lots';
import { AssetKey, InvesteeEntityKey, InvestingEntityKey } from '../../inventory/types';

const FUND = 'fund-id:Our Fund' as InvestingEntityKey;
const COMPANY_A = 'company-a-id:Company A' as InvesteeEntityKey;
const USD = 'usd-id:USD:CURRENCY' as AssetKey;
const A_SHARES = 'a-shares-id:A Shares:EQUITY' as AssetKey;
const DATE = new Date('2024-01-01T00:00:00.000Z');

// Everything USD-shaped in these fixtures is cash out of Company A's bucket;
// only the axis under test varies per lot.
function cashLot(overrides: Partial<Lot> = {}): Lot {
  return {
    investingEntityKey: FUND,
    investeeEntityKey: COMPANY_A,
    assetKey: USD,
    numAssets: 1000,
    date: DATE,
    source: 'INVESTMENT',
    tense: 'fact',
    degree: 1,
    provenanceAssetId: null,
    ...overrides,
  };
}

const extract = (lots: Lot[]) =>
  extractDeltasFromLots({ lots, classifiedTransactionFlows: [], trackedEntities: new Map() });

describe('cache extraction — the bucket key', () => {
  it('sums lots that differ in nothing the read path asks about', () => {
    const [event] = extract([cashLot({ numAssets: 1000 }), cashLot({ numAssets: 250 })]);

    expect(event.holdings).toHaveLength(1);
    expect(event.holdings[0]).toMatchObject({ numAssets: 1250, degree: 1, isInflow: true });
  });

  it('keeps money in and money out apart on the same day', () => {
    const holdings = extract([
      cashLot({ numAssets: 1000 }),
      cashLot({ numAssets: -400 }),
    ])[0].holdings;

    // Netting these to +600 would report 600 realised and nothing invested,
    // where the walk reports 1000 realised and 400 invested.
    expect(
      holdings.map((h) => [h.numAssets, h.isInflow]).sort((a, b) => Number(a[0]) - Number(b[0])),
    ).toEqual([
      [-400, false],
      [1000, true],
    ]);
  });

  it('keeps cash the company paid apart from cash its acquirer paid', () => {
    const holdings = extract([
      cashLot({ numAssets: 6000, degree: 1 }),
      cashLot({ numAssets: 3000, degree: 2 }),
    ])[0].holdings;

    expect(holdings.map((h) => [h.degree, h.numAssets])).toEqual([
      [1, 6000],
      [2, 3000],
    ]);
  });

  it('keeps what is held in the company apart from what is held in its acquirer', () => {
    const trackedEntities = new Map([['a-shares-id', new Set(['company-a-id'])]]);
    const [event] = extractDeltasFromLots({
      lots: [
        cashLot({ assetKey: A_SHARES, numAssets: 20, tense: 'live', degree: 0 }),
        cashLot({ assetKey: USD, numAssets: 20, tense: 'fact', degree: 0 }),
      ],
      classifiedTransactionFlows: [],
      trackedEntities,
    });

    expect(event.holdings.map((h) => [h.assetId, h.tracksInvestee])).toEqual([
      ['a-shares-id', true],
      ['usd-id', false],
    ]);
  });

  it('ignores flows filed outside the investment, as the walk does', () => {
    expect(extract([cashLot({ source: 'OTHER' })])).toEqual([]);
  });

  it('writes no row for a quantity of nothing', () => {
    expect(extract([cashLot({ numAssets: 0 })])).toEqual([]);
  });
});
