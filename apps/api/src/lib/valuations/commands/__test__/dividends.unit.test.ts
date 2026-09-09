// Characterization test for `applyDividends` — the shared service extracted
// from the inline `addDividends` tRPC mutation (company.ts). It exercises
// the DIVIDEND event, its containing transaction, the CURRENCY-asset lookup,
// the company→fund asset transfer, and the funding changelog audit row —
// VERBATIM behaviour, just normalized onto `ctx.prisma` inside the caller's
// transaction (the original wrapped these writes in its own
// `prismaClient.$transaction` and ran `logFundingChange` OUTSIDE it).
//
// `.unit.test.ts` runs under `src/test/jest-unit.config.ts`, which wires up
// no test database — only `.integration.test.ts` does that (globalSetup +
// harness/env.ts). Mocks `currentContext().prisma` in-memory rather than
// hitting Postgres (mirrors `wind_down.unit.test.ts`'s harness for the
// event/transaction/asset/assetTransfer calls), and mocks `getQb` for the
// `logFundingChange` insert (mirrors `markdown.unit.test.ts`'s /
// `investment.unit.test.ts`'s harness — see those files for the pattern this
// copies).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeSelectChain(rows: any[]) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    groupBy: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    distinct: () => chain,
    execute: async () => rows,
    executeTakeFirst: async () => rows[0],
  };
  return chain;
}

// What the investor holds when the rights lookup runs: `{assetId, balance}` net
// positions, plus the asset/issuer rows the tracked-entity resolver reads to
// decide which of them track the paying company.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let heldBalances: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let assetRows: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let issuerRows: any[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdChangelogRows: any[] = [];

jest.mock('../../../kysely', () => {
  // Keyed on the TABLE, never on WHICH accessor asked: a double that
  // branches on the accessor breaks on the next schema move.
  const qb = () => ({
    selectFrom: (from: string) => {
      // logFundingChange's fund-linking select — no funds invested, in this test
      if (from === 'investment') return fakeSelectChain([]);
      // The rights lookup: the investor's net non-currency positions at the
      // dividend date, then the tracked-entity resolution over them.
      if (from === 'asset_transfer as at') return fakeSelectChain(heldBalances);
      if (from === 'asset') return fakeSelectChain(assetRows);
      if (from === 'legal_entity') return fakeSelectChain(issuerRows);
      throw new Error(`dividends.unit.test: unexpected selectFrom(${from})`);
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
      throw new Error(`dividends.unit.test: unexpected insertInto(${table})`);
    },
  });
  return { getQb: qb, getCoreQb: qb, getValuationsQb: qb };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdEvents: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdTransactions: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdAssetTransfers: any[] = [];
let idCounter = 0;
let currencyAssetToReturn: { id: string } = { id: 'asset-usd' };

let inTransactionFlag = true;

jest.mock('../../../../services/context', () => ({
  currentContext: () => ({
    user: { id: 'user-1', teamId: 'team-1' },
    // applyDividends never opens its own transaction — the caller (the tRPC
    // procedure / REST handler) does that. This mirrors the ambient
    // transaction the caller establishes with ctx.enterTransaction() before
    // invoking it.
    get inTransaction() {
      return inTransactionFlag;
    },
    prisma: {
      event: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `event-${++idCounter}`, ...data };
          createdEvents.push(row);
          return row;
        },
      },
      transaction: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `transaction-${++idCounter}`, ...data };
          createdTransactions.push(row);
          return row;
        },
      },
      asset: {
        findFirstOrThrow: async () => currencyAssetToReturn,
      },
      assetTransfer: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `transfer-${++idCounter}`, ...data };
          createdAssetTransfers.push(row);
          return row;
        },
      },
    },
  }),
  // No ambient context here, so the per-request lookup memos hang nothing on
  // one and every call goes to the (stubbed) database.
  unsafeCurrentContext: () => undefined,
}));

import { applyDividends } from '../dividends';

beforeEach(() => {
  createdEvents.length = 0;
  createdTransactions.length = 0;
  createdAssetTransfers.length = 0;
  createdChangelogRows.length = 0;
  idCounter = 0;
  inTransactionFlag = true;
  currencyAssetToReturn = { id: 'asset-usd' };
  heldBalances = [];
  assetRows = [];
  issuerRows = [];
});

describe('applyDividends', () => {
  it('creates the DIVIDEND event, transaction, and company→fund transfer, and logs the changelog', async () => {
    const result = await applyDividends({
      companyId: 'co-1',
      date: '2026-07-20',
      amount: 50000,
      currency: 'USD',
      fundId: 'fund-1',
    });

    expect(result).toEqual({ eventId: 'event-1' });

    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({
      type: 'DIVIDEND',
      name: 'Dividend',
      legalEntityId: 'co-1',
      teamId: 'team-1',
    });
    const eventId = createdEvents[0].id;

    expect(createdTransactions).toHaveLength(1);
    expect(createdTransactions[0]).toMatchObject({ eventId, teamId: 'team-1' });
    const transactionId = createdTransactions[0].id;

    expect(createdAssetTransfers).toHaveLength(1);
    expect(createdAssetTransfers[0]).toMatchObject({
      assetId: 'asset-usd',
      fromLegalEntityId: 'co-1',
      toLegalEntityId: 'fund-1',
      numAssets: 50000,
      transactionId,
      teamId: 'team-1',
    });

    expect(createdChangelogRows).toHaveLength(1);
    expect(createdChangelogRows[0]).toMatchObject({
      category: 'Add Dividend',
      description: expect.stringContaining('Added dividend of'),
    });
  });

  // `due_to_rights_from_asset_id` is the causal edge the roll-up reads to tell a
  // dividend on the company we invested in apart from one on the stock we took
  // for it. The command stamps it only where the data leaves no choice.
  it('stamps the rights edge on the one holding that tracks the paying company', async () => {
    heldBalances = [
      { asset_id: 'asset-a', balance: 20 },
      { asset_id: 'asset-other', balance: 5 },
    ];
    assetRows = [
      { id: 'asset-a', type: 'EQUITY', issued_by_legal_entity_id: 'co-1', properties: {} },
      { id: 'asset-other', type: 'EQUITY', issued_by_legal_entity_id: 'co-2', properties: {} },
    ];
    issuerRows = [
      { id: 'co-1', underlying_company_id: null },
      { id: 'co-2', underlying_company_id: null },
    ];

    await applyDividends({
      companyId: 'co-1',
      date: '2026-07-20',
      amount: 50000,
      currency: 'USD',
      fundId: 'fund-1',
    });

    expect(createdTransactions[0]).toMatchObject({ dueToRightsFromAssetId: 'asset-a' });
  });

  it('leaves the edge null when two holdings track the paying company', async () => {
    heldBalances = [
      { asset_id: 'asset-a', balance: 20 },
      { asset_id: 'asset-spv', balance: 1 },
    ];
    assetRows = [
      { id: 'asset-a', type: 'EQUITY', issued_by_legal_entity_id: 'co-1', properties: {} },
      {
        id: 'asset-spv',
        type: 'SPV_INTEREST_POINT',
        issued_by_legal_entity_id: 'spv-1',
        properties: { spv_investment_target_company_id: 'co-1' },
      },
    ];
    issuerRows = [
      { id: 'co-1', underlying_company_id: null },
      { id: 'spv-1', underlying_company_id: 'co-1' },
    ];

    await applyDividends({
      companyId: 'co-1',
      date: '2026-07-20',
      amount: 50000,
      currency: 'USD',
      fundId: 'fund-1',
    });

    expect(createdTransactions[0]).toMatchObject({ dueToRightsFromAssetId: null });
  });

  it('leaves the edge null when the investor holds nothing the payer issued', async () => {
    // A position sold down to nothing is not a holding the dividend rode in on.
    heldBalances = [{ asset_id: 'asset-a', balance: 0 }];
    assetRows = [
      { id: 'asset-a', type: 'EQUITY', issued_by_legal_entity_id: 'co-1', properties: {} },
    ];
    issuerRows = [{ id: 'co-1', underlying_company_id: null }];

    await applyDividends({
      companyId: 'co-1',
      date: '2026-07-20',
      amount: 50000,
      currency: 'USD',
      fundId: 'fund-1',
    });

    expect(createdTransactions[0]).toMatchObject({ dueToRightsFromAssetId: null });
  });

  it('throws when invoked outside the caller\'s transaction', async () => {
    inTransactionFlag = false;

    await expect(
      applyDividends({ companyId: 'co-1', date: '2026-07-20', amount: 50000, currency: 'USD', fundId: 'fund-1' }),
    ).rejects.toThrow('applyDividends must run inside a transaction');

    expect(createdEvents).toHaveLength(0);
  });
});
