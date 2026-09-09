// Characterization test for `applyFundDrawdown` — the shared service
// extracted from the inline `addFundDrawdown` tRPC mutation (company.ts). It
// exercises the currency-asset lookup, the transaction (NO event — a
// drawdown just records the transaction + transfer + markdown), the
// investor→fund asset transfer, the reduced commitment price, and the
// funding changelog audit row — VERBATIM behaviour, just normalized onto
// `ctx.prisma` inside the caller's transaction (the original mutation never
// wrapped these writes in a transaction at all — this ADDS the atomicity
// guard) and onto the FLATTENED input shape (the tab's nested
// `outstandingCommitment` object, split into top-level `assetId` /
// `investorId` / `price` / `currency`).
//
// `.unit.test.ts` runs under `src/test/jest-unit.config.ts`, which wires up
// no test database — only `.integration.test.ts` does that (globalSetup +
// harness/env.ts). Mocks `currentContext().prisma` in-memory rather than
// hitting Postgres (mirrors `dividends.unit.test.ts`'s / `wind_down.unit.test.ts`'s
// harness for the transaction/asset/assetTransfer/price calls), and mocks
// `getQb` for the `logFundingChange` insert (mirrors those same files' — see
// them for the pattern this copies).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeSelectChain(rows: any[]) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    distinct: () => chain,
    execute: async () => rows,
    executeTakeFirst: async () => rows[0],
  };
  return chain;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdChangelogRows: any[] = [];

jest.mock('../../../kysely', () => {
  // Keyed on the TABLE, never on WHICH accessor asked: a double that
  // branches on the accessor breaks on the next schema move.
  const qb = () => ({
    selectFrom: (from: string) => {
      // logFundingChange's fund-linking select — no funds invested, in this test
      if (from === 'investment') return fakeSelectChain([]);
      throw new Error(`fund_drawdown.unit.test: unexpected selectFrom(${from})`);
    },
    insertInto: (table: string) => {
      if (table === 'funding_changelog') {
        return {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          values: (row: any) => {
            createdChangelogRows.push(row);
            return {
              returning: () => ({
                execute: async () => [{ id: 'changelog-1' }],
              }),
            };
          },
        };
      }
      if (table === 'funding_changelog_fund') {
        return { values: () => ({ execute: async () => [] }) };
      }
      throw new Error(`fund_drawdown.unit.test: unexpected insertInto(${table})`);
    },
  });
  return { getQb: qb, getCoreQb: qb, getValuationsQb: qb };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdTransactions: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdAssetTransfers: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdPrices: any[] = [];
let idCounter = 0;
let currencyAssetToReturn: { id: string } | null = { id: 'asset-usd' };

let inTransactionFlag = true;

jest.mock('../../../../services/context', () => ({
  currentContext: () => ({
    user: { id: 'user-1', teamId: 'team-1' },
    // applyFundDrawdown never opens its own transaction — the caller (the
    // tRPC procedure / REST handler) does that. This mirrors the ambient
    // transaction the caller establishes with ctx.enterTransaction() before
    // invoking it.
    get inTransaction() {
      return inTransactionFlag;
    },
    prisma: {
      asset: {
        // getCurrencyAsset reads *OrThrow — absence is a throw, not a null,
        // which is what lets it promise a non-null asset to its callers.
        findFirstOrThrow: async () => {
          if (!currencyAssetToReturn) {
            throw new Error('No Asset found');
          }
          return currencyAssetToReturn;
        },
      },
      transaction: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `transaction-${++idCounter}`, ...data };
          createdTransactions.push(row);
          return row;
        },
      },
      assetTransfer: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `transfer-${++idCounter}`, ...data };
          createdAssetTransfers.push(row);
          return row;
        },
      },
      price: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `price-${++idCounter}`, ...data };
          createdPrices.push(row);
          return row;
        },
      },
    },
  }),
}));

import { applyFundDrawdown } from '../fund_drawdown';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';

beforeEach(() => {
  createdTransactions.length = 0;
  createdAssetTransfers.length = 0;
  createdPrices.length = 0;
  createdChangelogRows.length = 0;
  idCounter = 0;
  inTransactionFlag = true;
  currencyAssetToReturn = { id: 'asset-usd' };
});

describe('applyFundDrawdown', () => {
  it('creates the transaction (no event), the investor→fund transfer, the reduced price, and logs the changelog', async () => {
    const result = await applyFundDrawdown({
      fundId: 'fund-1',
      drawdownAmount: 100000,
      date: '2026-07-20',
      assetId: 'asset-1',
      investorId: 'inv-1',
      price: 500000,
      currency: CurrencyIsoCode.USD,
    });

    expect(result).toEqual({ transactionId: 'transaction-1', priceId: expect.any(String) });

    expect(createdTransactions).toHaveLength(1);
    expect(createdTransactions[0]).toMatchObject({
      teamId: 'team-1',
      dueToRightsFromAssetId: 'asset-1',
    });
    expect(createdTransactions[0].eventId).toBeUndefined();
    const transactionId = createdTransactions[0].id;

    expect(createdAssetTransfers).toHaveLength(1);
    expect(createdAssetTransfers[0]).toMatchObject({
      assetId: 'asset-usd',
      fromLegalEntityId: 'inv-1',
      toLegalEntityId: 'fund-1',
      numAssets: 100000,
      transactionId,
      teamId: 'team-1',
    });

    expect(createdPrices).toHaveLength(1);
    expect(createdPrices[0]).toMatchObject({
      assetId: 'asset-1',
      price: 400000, // max(0, 500000 - 100000)
      currency: CurrencyIsoCode.USD,
      teamId: 'team-1',
      type: 'FROM_PRICED_ROUND',
    });
    expect(result.priceId).toBe(createdPrices[0].id);

    expect(createdChangelogRows).toHaveLength(1);
    expect(createdChangelogRows[0]).toMatchObject({
      category: 'Add Drawdown',
      description: expect.stringContaining('Added fund drawdown of'),
    });
  });

  it('floors the reduced price at zero when the drawdown exceeds the prior commitment price', async () => {
    await applyFundDrawdown({
      fundId: 'fund-1',
      drawdownAmount: 600000,
      date: '2026-07-20',
      assetId: 'asset-1',
      investorId: 'inv-1',
      price: 500000,
      currency: CurrencyIsoCode.USD,
    });

    expect(createdPrices[0]).toMatchObject({ price: 0 });
  });

  it('throws when the currency asset cannot be found', async () => {
    currencyAssetToReturn = null;

    await expect(
      applyFundDrawdown({
        fundId: 'fund-1',
        drawdownAmount: 100000,
        date: '2026-07-20',
        assetId: 'asset-1',
        investorId: 'inv-1',
        price: 500000,
        currency: CurrencyIsoCode.USD,
      }),
    ).rejects.toThrow('No Asset found');

    expect(createdTransactions).toHaveLength(0);
  });

  it('throws when invoked outside the caller\'s transaction', async () => {
    inTransactionFlag = false;

    await expect(
      applyFundDrawdown({
        fundId: 'fund-1',
        drawdownAmount: 100000,
        date: '2026-07-20',
        assetId: 'asset-1',
        investorId: 'inv-1',
        price: 500000,
        currency: CurrencyIsoCode.USD,
      }),
    ).rejects.toThrow('applyFundDrawdown must run inside a transaction');

    expect(createdTransactions).toHaveLength(0);
  });
});
