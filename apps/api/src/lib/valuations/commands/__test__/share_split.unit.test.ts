// Characterization test for `applyShareSplit` — the shared service extracted
// from the inline `addShareSplit` tRPC mutation (company.ts). It exercises
// the Share Split event, the split equity asset + derived company price
// (`latestAssetPrice.price / multiple`), the per-holder transfer loop that
// brings each EXISTING equity holding up to `numAssets * multiple`, the
// `logFundingChange` call, and the `'No equity assets found'` /
// `'No asset price found'` throws — VERBATIM behaviour, just wrapped in the
// caller-owns-the-transaction guard (the original mutation had none).
//
// `.unit.test.ts` runs under `src/test/jest-unit.config.ts`, which wires up
// no test database — only `.integration.test.ts` does that (globalSetup +
// harness/env.ts). Mocks `currentContext().prisma` in-memory rather than
// hitting Postgres — mirrors `wind_down.unit.test.ts`'s harness, plus mocks
// `getInventoryForInvestments` (the module does real DB reads) with a fake
// `Holdings`-shaped return (see `lib/valuations/inventory/holdings.ts` for
// the real `entries()`/`sum()` shape this fakes).

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeAssetHolding(fromInvestment: number) {
  return { sum: () => ({ fromInvestment }) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeFundHoldings(assets: Array<[string, number]>) {
  return { entries: () => assets.map(([key, total]) => [key, fakeAssetHolding(total)] as const) };
}

let holdingsToReturn: Array<[string, ReturnType<typeof fakeFundHoldings>]> = [];

const getInventoryForInvestments = jest.fn(
  async (_input: { investmentIds: string[]; asOfDate: Date }) => ({
    entries: () =>
      holdingsToReturn.map(([investingEntityKey, fundData]) => [investingEntityKey, 'co-1:Acme', fundData] as const),
  }),
);

jest.mock('../../inventory', () => ({
  getInventoryForInvestments: (input: { investmentIds: string[]; asOfDate: Date }) =>
    getInventoryForInvestments(input),
}));

const logFundingChange = jest.fn(async (_input: unknown) => undefined);
jest.mock('../../../funding-changelog', () => ({
  logFundingChange: (input: unknown) => logFundingChange(input),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdEvents: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdAssets: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdPrices: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdTransactions: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdAssetTransfers: any[] = [];
let idCounter = 0;
let investmentsToReturn: Array<{ id: string }> = [{ id: 'inv-1' }];
let latestAssetPriceToReturn: { price: number; currency: string } | null = { price: 100, currency: 'USD' };

let inTransactionFlag = true;

jest.mock('../../../../services/context', () => ({
  currentContext: () => ({
    user: { id: 'user-1', teamId: 'team-1' },
    // applyShareSplit never opens its own transaction — the caller (the
    // tRPC procedure) does that. This mirrors the ambient transaction the
    // caller establishes with ctx.enterTransaction() before invoking it.
    get inTransaction() {
      return inTransactionFlag;
    },
    prisma: {
      investment: {
        findMany: async () => investmentsToReturn,
      },
      price: {
        findFirst: async () => latestAssetPriceToReturn,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `price-${++idCounter}`, ...data };
          createdPrices.push(row);
          return row;
        },
      },
      event: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `event-${++idCounter}`, ...data };
          createdEvents.push(row);
          return row;
        },
      },
      asset: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `asset-${++idCounter}`, ...data };
          createdAssets.push(row);
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
      assetTransfer: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `transfer-${++idCounter}`, ...data };
          createdAssetTransfers.push(row);
          return row;
        },
      },
    },
  }),
}));

import { applyShareSplit } from '../share_split';

beforeEach(() => {
  createdEvents.length = 0;
  createdAssets.length = 0;
  createdPrices.length = 0;
  createdTransactions.length = 0;
  createdAssetTransfers.length = 0;
  idCounter = 0;
  inTransactionFlag = true;
  investmentsToReturn = [{ id: 'inv-1' }];
  latestAssetPriceToReturn = { price: 100, currency: 'USD' };
  holdingsToReturn = [];
  getInventoryForInvestments.mockClear();
  logFundingChange.mockClear();
});

describe('applyShareSplit', () => {
  it('creates the Share Split event + split asset + derived price, and transfers every equity holder up to the multiple', async () => {
    holdingsToReturn = [
      ['fund-1:Fund One', fakeFundHoldings([['equity-1:Common Stock:EQUITY', 100]])],
    ];

    const result = await applyShareSplit({ companyId: 'co-1', date: '2026-07-20', multiple: 10 });

    expect(result).toEqual({ eventId: 'event-1' });

    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({
      name: 'Share Split',
      type: 'SHARE_SPLIT',
      legalEntityId: 'co-1',
      teamId: 'team-1',
      data: { multiple: 10 },
    });

    expect(createdAssets).toHaveLength(1);
    expect(createdAssets[0]).toMatchObject({ type: 'EQUITY', issuedByLegalEntityId: 'co-1', teamId: 'team-1' });

    expect(createdPrices).toHaveLength(1);
    expect(createdPrices[0]).toMatchObject({ legalEntityId: 'co-1', price: 10, currency: 'USD', teamId: 'team-1' });

    expect(createdTransactions).toHaveLength(1);
    expect(createdTransactions[0]).toMatchObject({ eventId: 'event-1', teamId: 'team-1' });

    expect(createdAssetTransfers).toHaveLength(1);
    expect(createdAssetTransfers[0]).toMatchObject({
      assetId: 'asset-2',
      fromLegalEntityId: 'co-1',
      toLegalEntityId: 'fund-1',
      numAssets: 900,
      teamId: 'team-1',
    });

    expect(logFundingChange).toHaveBeenCalledWith(
      expect.objectContaining({ legalEntityId: 'co-1', category: 'Add Share Split' }),
    );

    expect(getInventoryForInvestments).toHaveBeenCalledWith({
      investmentIds: ['inv-1'],
      asOfDate: new Date('2026-07-20'),
    });
  });

  it('transfers every equity holder — multiple funds each get their own transaction', async () => {
    holdingsToReturn = [
      ['fund-1:Fund One', fakeFundHoldings([['equity-1:Common Stock:EQUITY', 100]])],
      ['fund-2:Fund Two', fakeFundHoldings([['equity-1:Common Stock:EQUITY', 50]])],
    ];

    await applyShareSplit({ companyId: 'co-1', date: '2026-07-20', multiple: 2 });

    expect(createdTransactions).toHaveLength(2);
    expect(createdAssetTransfers).toHaveLength(2);
    const byHolder = new Map(createdAssetTransfers.map((t) => [t.toLegalEntityId, t.numAssets]));
    expect(byHolder.get('fund-1')).toBe(100);
    expect(byHolder.get('fund-2')).toBe(50);
  });

  it('ignores non-equity holdings when aggregating holders', async () => {
    holdingsToReturn = [
      [
        'fund-1:Fund One',
        fakeFundHoldings([
          ['equity-1:Common Stock:EQUITY', 100],
          ['note-1:Convertible Note:CONVERTIBLE', 50],
        ]),
      ],
    ];

    await applyShareSplit({ companyId: 'co-1', date: '2026-07-20', multiple: 2 });

    expect(createdAssetTransfers).toHaveLength(1);
    expect(createdAssetTransfers[0]).toMatchObject({ numAssets: 100 });
  });

  it("throws 'No equity assets found' when no holder has an equity holding", async () => {
    holdingsToReturn = [];

    await expect(applyShareSplit({ companyId: 'co-1', date: '2026-07-20', multiple: 2 })).rejects.toThrow(
      'No equity assets found',
    );

    expect(createdEvents).toHaveLength(0);
  });

  it("throws 'No asset price found' when the company has no priced round", async () => {
    holdingsToReturn = [
      ['fund-1:Fund One', fakeFundHoldings([['equity-1:Common Stock:EQUITY', 100]])],
    ];
    latestAssetPriceToReturn = null;

    await expect(applyShareSplit({ companyId: 'co-1', date: '2026-07-20', multiple: 2 })).rejects.toThrow(
      'No asset price found',
    );

    expect(createdEvents).toHaveLength(0);
  });

  it("throws when invoked outside the caller's transaction", async () => {
    inTransactionFlag = false;

    await expect(applyShareSplit({ companyId: 'co-1', date: '2026-07-20', multiple: 2 })).rejects.toThrow(
      'applyShareSplit must run inside a transaction',
    );

    expect(createdEvents).toHaveLength(0);
    expect(getInventoryForInvestments).not.toHaveBeenCalled();
  });
});
