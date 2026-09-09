// Characterization test for `applyWindDown` — the shared wind-down service
// (called by the tRPC addLiquidation mutation, the REST command route, and the
// AddWindDown movement action). It exercises the Wind Down event, the
// tracked-asset disposal (per-asset markdown-to-zero + void transfer back to
// each asset's issuer), the optional per-investor payout loop, and the
// DISSOLVED update — all inside the caller-owns-the-transaction guard.
//
// Disposal selection mirrors the valuation walk: a held asset is disposed iff
// it TRACKS the wound-down company (`getAssetTrackedEntities`), so an asset the
// resolution says doesn't track the company is left alone even when held.
//
// `.unit.test.ts` runs under `src/test/jest-unit.config.ts`, which wires up no
// test database — only `.integration.test.ts` does (see
// wind_down.integration.test.ts for the real-DB coverage of the SPV / void
// scenarios). So the DB seams are mocked: `currentContext().prisma` in-memory
// (mirrors markdown.unit.test.ts), `getInventoryForInvestments` with a fake
// `Holdings`-shaped return, `getAssetTrackedEntities` with a fixed
// asset→entities map, and the `getQb` issuer lookup with a canned row set.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeAssetHolding(fromInvestment: number, fromOtherTransactions = 0) {
  return { sum: () => ({ fromInvestment, fromOtherTransactions }) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeInvesteeHoldings(assets: Array<[string, number]>) {
  return { entries: () => assets.map(([key, total]) => [key, fakeAssetHolding(total)] as const) };
}

let holdingsToReturn: ReturnType<typeof fakeInvesteeHoldings>[] = [];
// Per-index holder key for holdingsToReturn; defaults to fund-1 so the
// single-holder tests stay unchanged.
let holdingEntityKeys: string[] = [];

const getInventoryForInvestments = jest.fn(
  async (_input: { investmentIds: string[]; asOfDate: Date }) => ({
    entries: () =>
      holdingsToReturn.map(
        (fundData, i) => [holdingEntityKeys[i] ?? 'fund-1:Fund One', 'co-1:Acme', fundData] as const,
      ),
  }),
);

jest.mock('../../inventory', () => ({
  getInventoryForInvestments: (input: { investmentIds: string[]; asOfDate: Date }) =>
    getInventoryForInvestments(input),
}));

// Which held assets track the wound-down company. Keyed by assetId → Set of
// tracked entity ids; anything absent (or not containing the company) is left
// undisposed.
let trackedByAsset: Record<string, string[]> = {};
jest.mock('../../valuation/data', () => ({
  getAssetTrackedEntities: async (assetIds: string[]) =>
    new Map(assetIds.map((id) => [id, new Set(trackedByAsset[id] ?? [])])),
}));

// The issuer lookup (`ctx.prisma.asset.findMany`) resolves each disposed
// asset's issuing entity. Idempotency reads (`price.findMany` /
// `assetTransfer.findMany` scoped to the event) report what's already been
// written; both empty in these fresh-run cases.
let assetIssuerRows: Array<{ id: string; issuedByLegalEntityId: string | null }> = [];
// What price.findMany reports as already written (this event's re-run marks OR
// any same-day price for a disposed asset — both mean "don't mark again").
let existingPriceRows: Array<{ assetId: string }> = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdEvents: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdPrices: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdTransactions: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdAssetTransfers: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const legalEntityUpdates: any[] = [];
let idCounter = 0;
let investmentsToReturn: Array<{ id: string }> = [{ id: 'inv-1' }];
let currencyAssetToReturn: { id: string } = { id: 'asset-usd' };

let inTransactionFlag = true;

jest.mock('../../../../services/context', () => ({
  currentContext: () => ({
    user: { id: 'user-1', teamId: 'team-1' },
    // applyWindDown never opens its own transaction — the caller (the tRPC
    // procedure) does that. This mirrors the ambient transaction the caller
    // establishes with ctx.enterTransaction() before invoking it.
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
      investment: {
        findMany: async () => investmentsToReturn,
      },
      price: {
        findMany: async () => existingPriceRows,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `price-${++idCounter}`, ...data };
          createdPrices.push(row);
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
        findMany: async () => assetIssuerRows,
        findFirstOrThrow: async () => currencyAssetToReturn,
      },
      assetTransfer: {
        findMany: async () => [] as Array<{ assetId: string; fromLegalEntityId: string }>,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `transfer-${++idCounter}`, ...data };
          createdAssetTransfers.push(row);
          return row;
        },
      },
      legalEntity: {
        update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const row = { ...where, ...data };
          legalEntityUpdates.push(row);
          return row;
        },
      },
    },
  }),
}));

import { applyWindDown } from '../wind_down';

beforeEach(() => {
  createdEvents.length = 0;
  createdPrices.length = 0;
  createdTransactions.length = 0;
  createdAssetTransfers.length = 0;
  legalEntityUpdates.length = 0;
  idCounter = 0;
  inTransactionFlag = true;
  investmentsToReturn = [{ id: 'inv-1' }];
  currencyAssetToReturn = { id: 'asset-usd' };
  holdingsToReturn = [];
  holdingEntityKeys = [];
  trackedByAsset = {};
  assetIssuerRows = [];
  existingPriceRows = [];
  getInventoryForInvestments.mockClear();
});

describe('applyWindDown', () => {
  it('creates the event, marks every tracked asset to zero, transfers them to the void, and dissolves the company', async () => {
    holdingsToReturn = [
      fakeInvesteeHoldings([
        ['equity-1:Common Stock:EQUITY', 100],
        ['note-1:Convertible Note:CONVERTIBLE', 50],
        ['usd:Dollars:CURRENCY', 10],
      ]),
    ];
    // Both the equity and the note track the wound-down company.
    trackedByAsset = { 'equity-1': ['co-1'], 'note-1': ['co-1'] };
    assetIssuerRows = [
      { id: 'equity-1', issuedByLegalEntityId: 'co-1' },
      { id: 'note-1', issuedByLegalEntityId: 'co-1' },
    ];

    const result = await applyWindDown({ companyId: 'co-1', date: '2026-07-20' });

    expect(result).toEqual({ eventId: 'event-1' });

    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({
      name: 'Wind Down',
      type: 'LIQUIDATION',
      legalEntityId: 'co-1',
      teamId: 'team-1',
    });

    // A per-asset markdown for EACH tracked asset (equity included now), keyed
    // to the asset AND its issuer; CURRENCY is never disposed.
    expect(createdPrices).toHaveLength(2);
    const equityPrice = createdPrices.find((p) => p.assetId === 'equity-1');
    const notePrice = createdPrices.find((p) => p.assetId === 'note-1');
    expect(equityPrice).toMatchObject({ legalEntityId: 'co-1', price: 0, currency: 'USD', eventId: 'event-1' });
    expect(notePrice).toMatchObject({ legalEntityId: 'co-1', price: 0, currency: 'USD', eventId: 'event-1' });
    expect(createdPrices.some((p) => p.assetId === 'usd')).toBe(false);

    // One disposal transaction; one void transfer per tracked position, out of
    // the holder (fund-1) to the asset's issuer, no currency counter-leg.
    expect(createdTransactions).toHaveLength(1);
    expect(createdAssetTransfers).toHaveLength(2);
    expect(createdAssetTransfers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assetId: 'equity-1', fromLegalEntityId: 'fund-1', toLegalEntityId: 'co-1', numAssets: 100 }),
        expect.objectContaining({ assetId: 'note-1', fromLegalEntityId: 'fund-1', toLegalEntityId: 'co-1', numAssets: 50 }),
      ]),
    );
    expect(createdAssetTransfers.every((t) => t.assetId !== 'usd')).toBe(true);

    expect(legalEntityUpdates).toHaveLength(1);
    expect(legalEntityUpdates[0]).toMatchObject({ id: 'co-1', legalStatus: 'DISSOLVED' });

    expect(getInventoryForInvestments).toHaveBeenCalledWith({
      investmentIds: ['inv-1'],
      asOfDate: new Date('2026-07-20'),
    });
  });

  it('leaves a held asset alone when the resolution says it does not track the company', async () => {
    holdingsToReturn = [
      fakeInvesteeHoldings([
        ['equity-1:Common Stock:EQUITY', 100],
        ['acquirer-1:Acquirer Shares:EQUITY', 40],
      ]),
    ];
    // Only equity-1 tracks the company; acquirer-1 has become a claim on
    // something else and must NOT be disposed by the wind-down.
    trackedByAsset = { 'equity-1': ['co-1'], 'acquirer-1': ['other-co'] };
    assetIssuerRows = [{ id: 'equity-1', issuedByLegalEntityId: 'co-1' }];

    await applyWindDown({ companyId: 'co-1', date: '2026-07-20' });

    expect(createdPrices).toHaveLength(1);
    expect(createdPrices[0]).toMatchObject({ assetId: 'equity-1', price: 0 });
    expect(createdAssetTransfers).toEqual([
      expect.objectContaining({ assetId: 'equity-1', numAssets: 100 }),
    ]);
  });

  it('ignores a zero/negative-balance holding — no markdown, no transfer for it', async () => {
    holdingsToReturn = [
      fakeInvesteeHoldings([
        ['equity-1:Common Stock:EQUITY', 0],
        ['note-1:Convertible Note:CONVERTIBLE', -5],
      ]),
    ];
    trackedByAsset = { 'equity-1': ['co-1'], 'note-1': ['co-1'] };

    await applyWindDown({ companyId: 'co-1', date: '2026-07-20' });

    expect(createdPrices).toHaveLength(0);
    expect(createdTransactions).toHaveLength(0);
    expect(createdAssetTransfers).toHaveLength(0);
  });

  it('marks a shared asset once when several entities hold it — one price, one transfer per holder', async () => {
    holdingsToReturn = [
      fakeInvesteeHoldings([['equity-1:Common Stock:EQUITY', 100]]),
      fakeInvesteeHoldings([['equity-1:Common Stock:EQUITY', 40]]),
    ];
    holdingEntityKeys = ['fund-1:Fund One', 'fund-2:Fund Two'];
    trackedByAsset = { 'equity-1': ['co-1'] };
    assetIssuerRows = [{ id: 'equity-1', issuedByLegalEntityId: 'co-1' }];

    await applyWindDown({ companyId: 'co-1', date: '2026-07-20' });

    // One markdown for the asset — a second create would trip the
    // `price (asset_id, date)` unique.
    expect(createdPrices).toHaveLength(1);
    expect(createdPrices[0]).toMatchObject({ assetId: 'equity-1', price: 0 });

    // But BOTH holders' positions are still disposed.
    expect(createdAssetTransfers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ assetId: 'equity-1', fromLegalEntityId: 'fund-1', numAssets: 100 }),
        expect.objectContaining({ assetId: 'equity-1', fromLegalEntityId: 'fund-2', numAssets: 40 }),
      ]),
    );
    expect(createdAssetTransfers).toHaveLength(2);
  });

  it('keeps an existing same-day price instead of writing a second mark', async () => {
    holdingsToReturn = [fakeInvesteeHoldings([['equity-1:Common Stock:EQUITY', 100]])];
    trackedByAsset = { 'equity-1': ['co-1'] };
    assetIssuerRows = [{ id: 'equity-1', issuedByLegalEntityId: 'co-1' }];
    existingPriceRows = [{ assetId: 'equity-1' }];

    await applyWindDown({ companyId: 'co-1', date: '2026-07-20' });

    expect(createdPrices).toHaveLength(0);
    // The disposal transfer still happens — only the markdown is skipped.
    expect(createdAssetTransfers).toEqual([
      expect.objectContaining({ assetId: 'equity-1', numAssets: 100 }),
    ]);
  });

  it('a call with nothing held succeeds — event + dissolve, no disposal or payout', async () => {
    holdingsToReturn = [];

    const result = await applyWindDown({ companyId: 'co-1', date: '2026-07-20' });

    expect(result).toEqual({ eventId: 'event-1' });
    expect(createdTransactions).toHaveLength(0);
    expect(createdAssetTransfers).toHaveLength(0);
    expect(legalEntityUpdates).toHaveLength(1);
  });

  it('runs the optional per-investor payout loop when transactions are given', async () => {
    holdingsToReturn = [];

    const result = await applyWindDown({
      companyId: 'co-1',
      date: '2026-07-20',
      transactions: [{ numAssets: 100, currency: 'USD', investorId: 'investor-1' }],
    });

    expect(result).toEqual({ eventId: 'event-1' });
    expect(createdTransactions).toHaveLength(1);
    expect(createdTransactions[0]).toMatchObject({ eventId: 'event-1', teamId: 'team-1' });

    expect(createdAssetTransfers).toHaveLength(1);
    expect(createdAssetTransfers[0]).toMatchObject({
      assetId: 'asset-usd',
      fromLegalEntityId: 'co-1',
      toLegalEntityId: 'investor-1',
      numAssets: 100,
      teamId: 'team-1',
    });
  });

  it('skips zero-proceeds payout rows — no empty cash transfer, no empty transaction', async () => {
    holdingsToReturn = [];

    await applyWindDown({
      companyId: 'co-1',
      date: '2026-07-20',
      transactions: [
        { numAssets: 0, currency: 'USD', investorId: 'investor-1' },
        { numAssets: 250, currency: 'USD', investorId: 'investor-2' },
      ],
    });

    expect(createdTransactions).toHaveLength(1);
    expect(createdAssetTransfers).toHaveLength(1);
    expect(createdAssetTransfers[0]).toMatchObject({
      assetId: 'asset-usd',
      toLegalEntityId: 'investor-2',
      numAssets: 250,
    });
  });

  it('throws when invoked outside the caller\'s transaction', async () => {
    inTransactionFlag = false;

    await expect(applyWindDown({ companyId: 'co-1', date: '2026-07-20' })).rejects.toThrow(
      'applyWindDown must run inside a transaction',
    );

    expect(createdEvents).toHaveLength(0);
  });
});
