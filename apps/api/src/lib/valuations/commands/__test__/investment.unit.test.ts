// Characterization test for `applyInvestment` — the shared service extracted
// from the inline `addInvestment` tRPC mutation (company.ts). It exercises
// the EQUITY orchestration: event lookup/creation, the containing
// investment/transaction, the EQUITY-specific transfer, and the funding
// changelog audit row.
//
// `.unit.test.ts` runs under `src/test/jest-unit.config.ts`, which wires up
// no test database. This test mocks the `lib/investment` SQL helpers
// directly (`addInvestmentAndTransaction`, `getOrCreateEvent`, `addCashFlow`,
// `addEquityTransferAndPrice`) — it is testing `applyInvestment`'s
// ORCHESTRATION + return shape + transaction guard + changelog, not the
// helpers' SQL. `logFundingChange` runs for real against a mocked `getQb`,
// mirroring `markdown.unit.test.ts`'s harness (see that file for the
// `getQb`/`currentContext` mock-chain pattern this copies).

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
      throw new Error(`investment.unit.test: unexpected selectFrom(${from})`);
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
      throw new Error(`investment.unit.test: unexpected insertInto(${table})`);
    },
  });
  return { getQb: qb, getCoreQb: qb, getValuationsQb: qb };
});

let inTransactionFlag = true;

jest.mock('../../../../services/context', () => ({
  currentContext: () => ({
    user: { id: 'user-1', teamId: 'team-1' },
    // applyInvestment never opens its own transaction — the caller (the
    // tRPC procedure) does that. This mirrors the ambient transaction the
    // caller establishes with ctx.enterTransaction() before invoking it.
    get inTransaction() {
      return inTransactionFlag;
    },
  }),
}));

// applyInvestment's `'NEW'`-entity handling now lives in
// resolveInvestmentEntities (exercised below); applyInvestment itself never
// calls ProfileService.create — but it imports the module statically, so
// mock it out here so the real profile-creation module (Prisma +
// message-queue wiring) never loads under this DB-less unit test.
const mockProfileServiceCreate = jest.fn(async (args: { name: string }) => ({
  id: `created-${args.name}`,
}));
jest.mock('../../../../services/profiles/profile', () => ({
  ProfileService: { create: mockProfileServiceCreate },
}));

const mockAddInvestmentAndTransaction = jest.fn(async () => ({
  investment: { id: 'inv-1' },
  transaction: { id: 'tx-1' },
}));
jest.mock('../../../investment', () => ({
  addInvestmentAndTransaction: mockAddInvestmentAndTransaction,
}));

const mockGetOrCreateEvent = jest.fn(async () => ({ id: 'ev-1' }));
jest.mock('../../../investment/round', () => ({
  getOrCreateEvent: mockGetOrCreateEvent,
}));

const mockAddCashFlow = jest.fn(async () => undefined);
jest.mock('../../../investment/cash', () => ({
  addCashFlow: mockAddCashFlow,
}));

const mockAddEquityTransferAndPrice = jest.fn(async () => undefined);
jest.mock('../../../investment/equity', () => ({
  addEquityTransferAndPrice: mockAddEquityTransferAndPrice,
}));

import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import LegalEntityType from '../../../../generated/kysely/valuations/LegalEntityType';
import { applyInvestment, resolveInvestmentEntities } from '../investment';

beforeEach(() => {
  createdChangelogRows.length = 0;
  inTransactionFlag = true;
  mockProfileServiceCreate.mockClear();
  mockAddInvestmentAndTransaction.mockClear();
  mockGetOrCreateEvent.mockClear();
  mockAddCashFlow.mockClear();
  mockAddEquityTransferAndPrice.mockClear();
});

const equityInput = {
  entity: 'company-1',
  investingEntity: 'fund-1',
  investingEntityName: 'Acme Fund',
  roundName: 'Series A',
  investmentDate: '2026-07-20',
  investmentAmount: '1000000',
  investmentCurrency: CurrencyIsoCode.USD,
  investmentType: 'EQUITY' as const,
  numberOfShares: '1000',
  pricePerShare: '100',
  pricePerShareCurrency: CurrencyIsoCode.USD,
  shareClass: 'Series A Preferred',
};

describe('applyInvestment', () => {
  it('creates the round event, the investment/transaction, the EQUITY transfer, and the funding changelog entry — inside the caller\'s transaction', async () => {
    const result = await applyInvestment(equityInput);

    expect(result).toEqual({ investmentId: 'inv-1', eventId: 'ev-1', transactionId: 'tx-1' });

    expect(mockGetOrCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ targetEntityId: 'company-1', roundName: 'Series A' }),
    );
    expect(mockAddInvestmentAndTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        investingEntity: 'fund-1',
        targetEntityId: 'company-1',
        eventId: 'ev-1',
      }),
    );
    expect(mockAddCashFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'fund-1',
        to: 'company-1',
        amount: 1000000,
        transactionId: 'tx-1',
      }),
    );
    expect(mockAddEquityTransferAndPrice).toHaveBeenCalledWith(
      expect.objectContaining({
        numberOfShares: 1000,
        pricePerShare: 100,
        transactionId: 'tx-1',
        eventId: 'ev-1',
      }),
    );

    // audit — the funding changelog entry is a property of the command
    // itself, so REST/movement callers get the same audit row a tab click does.
    expect(createdChangelogRows).toHaveLength(1);
    expect(createdChangelogRows[0]).toMatchObject({
      category: 'Add Investment',
      legal_entity_id: 'company-1',
    });
  });

  it('throws when invoked outside the caller\'s transaction', async () => {
    inTransactionFlag = false;

    await expect(applyInvestment(equityInput)).rejects.toThrow(
      'applyInvestment must run inside a transaction',
    );

    expect(mockAddInvestmentAndTransaction).not.toHaveBeenCalled();
  });
});

describe('resolveInvestmentEntities', () => {
  it('mints NEW target entity, SPV, seller, and co-investor via ProfileService.create and returns a copy with real ids', async () => {
    const resolved = await resolveInvestmentEntities({
      ...equityInput,
      entity: 'NEW',
      entityName: 'BrandNewCo',
      entityType: LegalEntityType.COMPANY,
      entityWebsite: 'https://brandnew.co',
      spv: 'NEW',
      spvName: 'BrandNew SPV',
      seller: 'NEW',
      sellerName: 'BrandNew Seller',
      coInvestors: [{ id: 'NEW', name: 'BrandNew CoInvestor', type: 'FUND' }],
    });

    expect(resolved.entity).toBe('created-BrandNewCo');
    expect(resolved.spv).toBe('created-BrandNew SPV');
    expect(resolved.seller).toBe('created-BrandNew Seller');
    expect(resolved.coInvestors).toEqual([
      { id: 'created-BrandNew CoInvestor', name: 'BrandNew CoInvestor', type: 'FUND' },
    ]);

    expect(mockProfileServiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'BrandNewCo',
        type: 'COMPANY',
        personalWebsite: 'https://brandnew.co',
        isPrivate: true,
      }),
    );
    expect(mockProfileServiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'BrandNew SPV', type: 'SPV', isPrivate: true }),
    );
    expect(mockProfileServiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'BrandNew Seller', type: 'COMPANY', isPrivate: true }),
    );
    expect(mockProfileServiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'BrandNew CoInvestor', type: 'FUND', isPrivate: true }),
    );
    expect(mockProfileServiceCreate).toHaveBeenCalledTimes(4);
  });

  it('leaves already-real ids untouched and never calls ProfileService.create', async () => {
    const resolved = await resolveInvestmentEntities(equityInput);

    expect(resolved).toEqual(equityInput);
    expect(mockProfileServiceCreate).not.toHaveBeenCalled();
  });
});
