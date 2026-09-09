// Characterization test for `applyRound` — the shared service extracted
// from the inline `addRound` tRPC mutation (company.ts). It exercises the
// get-or-create INVESTMENT_ROUND event, the optional price-per-share Price
// row, and the funding changelog audit row.
//
// `.unit.test.ts` runs under `src/test/jest-unit.config.ts`, which wires up
// no test database — only `.integration.test.ts` does that (globalSetup +
// harness/env.ts). Mocks `getQb`/`currentContext` in-memory rather than
// hitting Postgres — mirrors `investment.unit.test.ts`'s harness (see that
// file for the `getQb`/`currentContext` mock-chain pattern this copies).

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdEvents: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdPrices: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdCoInvestorRows: any[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let existingEventRows: any[] = [];
let priceRowToReturn: { id: string } | undefined = { id: 'pr-1' };

jest.mock('../../../kysely', () => {
  // Keyed on the TABLE, never on WHICH accessor asked: a double that
  // branches on the accessor breaks on the next schema move.
  const qb = () => ({
    selectFrom: (from: string) => {
      // The event get-or-create lookup.
      if (from === 'event') return fakeSelectChain(existingEventRows);
      // logFundingChange's fund-linking select — no funds invested, in this test
      if (from === 'investment') return fakeSelectChain([]);
      throw new Error(`round.unit.test: unexpected selectFrom(${from})`);
    },
    insertInto: (table: string) => {
      if (table === 'event') {
        return {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          values: (row: any) => {
            createdEvents.push(row);
            return {
              returning: () => ({
                executeTakeFirstOrThrow: async () => ({ id: 'ev-1' }),
              }),
            };
          },
        };
      }
      if (table === 'price') {
        return {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          values: (row: any) => {
            createdPrices.push(row);
            return {
              returning: () => ({
                executeTakeFirst: async () => priceRowToReturn,
              }),
            };
          },
        };
      }
      if (table === 'investment') {
        return {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          values: (row: any) => {
            createdCoInvestorRows.push(row);
            return { execute: async () => undefined };
          },
        };
      }
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
      throw new Error(`round.unit.test: unexpected insertInto(${table})`);
    },
  });
  return { getQb: qb, getCoreQb: qb, getValuationsQb: qb };
});

let inTransactionFlag = true;

jest.mock('../../../../services/context', () => ({
  currentContext: () => ({
    user: { id: 'user-1', teamId: 'team-1' },
    // applyRound never opens its own transaction — the caller (the tRPC
    // procedure) does that. This mirrors the ambient transaction the
    // caller establishes with ctx.enterTransaction() before invoking it.
    get inTransaction() {
      return inTransactionFlag;
    },
  }),
}));

// applyRound's `'NEW'`-co-investor handling now lives in
// resolveRoundEntities (exercised below); applyRound itself never calls
// ProfileService.create — but it imports the module statically, so mock it
// out here so the real profile-creation module (Prisma + message-queue
// wiring) never loads under this DB-less unit test.
const mockProfileServiceCreate = jest.fn(async (args: { name: string }) => ({
  id: `created-${args.name}`,
}));
jest.mock('../../../../services/profiles/profile', () => ({
  ProfileService: { create: mockProfileServiceCreate },
}));

import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import ValuationType from '../../../../generated/kysely/valuations/ValuationType';
import { applyRound, resolveRoundEntities } from '../round';

beforeEach(() => {
  createdChangelogRows.length = 0;
  createdEvents.length = 0;
  createdPrices.length = 0;
  createdCoInvestorRows.length = 0;
  existingEventRows = [];
  priceRowToReturn = { id: 'pr-1' };
  inTransactionFlag = true;
  mockProfileServiceCreate.mockClear();
});

describe('applyRound', () => {
  it('creates the round event and the price, and logs the funding change — inside the caller\'s transaction', async () => {
    const result = await applyRound({
      entity: 'company-1',
      roundName: 'Series B',
      date: '2026-07-20',
      currency: CurrencyIsoCode.USD,
      pricePerShare: '10',
      valuationAmount: '5000000',
      valuationType: ValuationType.POST_MONEY,
      totalRaisedAmount: '1000000',
    });

    expect(result).toEqual({ eventId: 'ev-1', priceId: 'pr-1' });

    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({
      legal_entity_id: 'company-1',
      name: 'Series B',
      type: 'INVESTMENT_ROUND',
      team_id: 'team-1',
      raised_amount: 1000000,
      valuation: 5000000,
      valuation_type: 'POST_MONEY',
    });

    expect(createdPrices).toHaveLength(1);
    expect(createdPrices[0]).toMatchObject({
      legal_entity_id: 'company-1',
      price: 10,
      currency: CurrencyIsoCode.USD,
      event_id: 'ev-1',
      type: 'FROM_PRICED_ROUND',
      team_id: 'team-1',
    });

    // audit — the funding changelog entry is a property of the command
    // itself, so REST/movement callers get the same audit row a tab click does.
    expect(createdChangelogRows).toHaveLength(1);
    expect(createdChangelogRows[0]).toMatchObject({
      category: 'Add Round',
      legal_entity_id: 'company-1',
      description: expect.stringContaining('Added round: Series B'),
    });
  });

  it('reuses an existing event with the same name/date/type/entity instead of creating a new one', async () => {
    existingEventRows = [{ id: 'ev-existing' }];

    const result = await applyRound({
      entity: 'company-1',
      roundName: 'Series B',
      date: '2026-07-20',
    });

    expect(result).toEqual({ eventId: 'ev-existing', priceId: null });
    expect(createdEvents).toHaveLength(0);
  });

  it('does not create a price when pricePerShare is omitted', async () => {
    const result = await applyRound({
      entity: 'company-1',
      roundName: 'Series B',
      date: '2026-07-20',
    });

    expect(result.priceId).toBeNull();
    expect(createdPrices).toHaveLength(0);
  });

  it('throws when invoked outside the caller\'s transaction', async () => {
    inTransactionFlag = false;

    await expect(
      applyRound({ entity: 'company-1', roundName: 'Series B', date: '2026-07-20' }),
    ).rejects.toThrow('applyRound must run inside a transaction');

    expect(createdEvents).toHaveLength(0);
  });
});

describe('resolveRoundEntities', () => {
  it('mints a NEW co-investor via ProfileService.create and returns a copy with the real id', async () => {
    const resolved = await resolveRoundEntities({
      entity: 'company-1',
      roundName: 'Series B',
      date: '2026-07-20',
      coInvestors: [{ id: 'NEW', name: 'BrandNew CoInvestor', type: 'FUND' }],
    });

    expect(resolved.coInvestors).toEqual([
      { id: 'created-BrandNew CoInvestor', name: 'BrandNew CoInvestor', type: 'FUND' },
    ]);
    expect(mockProfileServiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'BrandNew CoInvestor', type: 'FUND', isPrivate: true }),
    );
    expect(mockProfileServiceCreate).toHaveBeenCalledTimes(1);
  });

  it('leaves already-real co-investor ids untouched and never calls ProfileService.create', async () => {
    const input = {
      entity: 'company-1',
      roundName: 'Series B',
      date: '2026-07-20',
      coInvestors: [{ id: 'coinvestor-1', name: 'Existing Fund', type: 'FUND' as const }],
    };

    const resolved = await resolveRoundEntities(input);

    expect(resolved).toEqual(input);
    expect(mockProfileServiceCreate).not.toHaveBeenCalled();
  });

  it('is a no-op when there are no co-investors', async () => {
    const input = { entity: 'company-1', roundName: 'Series B', date: '2026-07-20' };

    const resolved = await resolveRoundEntities(input);

    expect(resolved).toEqual(input);
    expect(mockProfileServiceCreate).not.toHaveBeenCalled();
  });
});
