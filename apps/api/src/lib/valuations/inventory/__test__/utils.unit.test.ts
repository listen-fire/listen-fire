import { Holdings } from '../holdings';
import { getAssetKey, getInvesteeEntityKey, getInvestingEntityKey } from '../types';
import { transformHoldings, transformHoldingsForDisplay } from '../utils';

const FUND = getInvestingEntityKey({ investingEntityId: 'fund-1', investingEntityName: 'Our Fund' });
const COMPANY = getInvesteeEntityKey({
  investeeEntityId: 'company-1',
  investeeEntityName: 'Company A',
});
const DATE = new Date('2024-06-01');

const SHARES = getAssetKey({ assetId: 'asset-shares', assetName: 'A Shares', assetType: 'EQUITY' });
const USD = getAssetKey({ assetId: 'asset-usd', assetName: 'USD', assetType: 'CURRENCY' });

function holdingsWith(
  entries: { assetKey: ReturnType<typeof getAssetKey>; numAssets: number; source: 'INVESTMENT' | 'OTHER' }[],
): Holdings {
  const holdings = new Holdings();
  const investee = holdings.get(FUND, COMPANY);
  for (const { assetKey, numAssets, source } of entries) {
    investee.get(assetKey).add({ numAssets, date: DATE }, source);
  }
  return holdings;
}

describe('transformHoldingsForDisplay', () => {
  it('drops currency that only ever arrived outside the investment', () => {
    // Acquisition proceeds stapled onto the acquirer's investment: we never put
    // this cash in against the company, so it is not a position we hold.
    const holdings = holdingsWith([
      { assetKey: SHARES, numAssets: 30, source: 'INVESTMENT' },
      { assetKey: USD, numAssets: 20000, source: 'OTHER' },
    ]);

    expect(transformHoldingsForDisplay(holdings)).toEqual([
      expect.objectContaining({ assetId: 'asset-shares', assetType: 'EQUITY', numAssets: 30 }),
    ]);

    // The full inventory view still carries it — the acquisition sweep needs it.
    expect(transformHoldings(holdings)).toEqual([
      expect.objectContaining({ assetId: 'asset-shares', numAssets: 30 }),
      expect.objectContaining({ assetId: 'asset-usd', numAssets: 20000 }),
    ]);
  });

  it('keeps currency we genuinely invested through, at its investment balance', () => {
    const holdings = holdingsWith([
      { assetKey: USD, numAssets: 5000, source: 'INVESTMENT' },
      { assetKey: USD, numAssets: 20000, source: 'OTHER' },
    ]);

    expect(transformHoldingsForDisplay(holdings)).toEqual([
      expect.objectContaining({ assetId: 'asset-usd', numAssets: 5000 }),
    ]);
    expect(transformHoldings(holdings)).toEqual([
      expect.objectContaining({ assetId: 'asset-usd', numAssets: 25000 }),
    ]);
  });

  it('leaves non-currency assets netting both buckets', () => {
    const holdings = holdingsWith([
      { assetKey: SHARES, numAssets: 30, source: 'INVESTMENT' },
      { assetKey: SHARES, numAssets: 10, source: 'OTHER' },
    ]);

    expect(transformHoldingsForDisplay(holdings)).toEqual([
      expect.objectContaining({ assetId: 'asset-shares', numAssets: 40 }),
    ]);
  });
});
