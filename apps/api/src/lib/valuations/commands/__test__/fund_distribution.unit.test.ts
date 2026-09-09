// Characterization test for `applyFundDistribution` — the shared service
// extracted from the inline `addFundDistribution` tRPC mutation (company.ts).
// Unlike `applyDividends`, this delegates the event/transaction/transfer
// writes to the EXISTING `addFundDistribution` lib helper
// (`lib/import/distributions.ts`) rather than re-implementing them —
// `applyFundDistribution` is tested here purely as ORCHESTRATION (the
// fundEntityId/investorId role mapping, the transaction guard, and the
// funding changelog audit row), mirroring `investment.unit.test.ts`'s
// pattern of mocking the sibling helper module directly rather than
// `ctx.prisma`.
//
// `.unit.test.ts` runs under `src/test/jest-unit.config.ts`, which wires up
// no test database — only `.integration.test.ts` does that (globalSetup +
// harness/env.ts). Mocks `getQb` for the `logFundingChange` insert (mirrors
// `dividends.unit.test.ts`'s / `investment.unit.test.ts`'s harness — see
// those files for the pattern this copies).

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
      throw new Error(`fund_distribution.unit.test: unexpected selectFrom(${from})`);
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
      throw new Error(`fund_distribution.unit.test: unexpected insertInto(${table})`);
    },
  });
  return { getQb: qb, getCoreQb: qb, getValuationsQb: qb };
});

let inTransactionFlag = true;

jest.mock('../../../../services/context', () => ({
  currentContext: () => ({
    user: { id: 'user-1', teamId: 'team-1' },
    // applyFundDistribution never opens its own transaction — the caller
    // (the tRPC procedure / REST handler) does that. This mirrors the
    // ambient transaction the caller establishes with
    // ctx.enterTransaction() before invoking it.
    get inTransaction() {
      return inTransactionFlag;
    },
  }),
}));

const mockAddFundDistribution = jest.fn(async () => ({ id: 'ev-1' }));
jest.mock('../../../import/distributions', () => ({
  addFundDistribution: (...args: unknown[]) => mockAddFundDistribution(...(args as [])),
}));

import { applyFundDistribution } from '../fund_distribution';

beforeEach(() => {
  createdChangelogRows.length = 0;
  inTransactionFlag = true;
  mockAddFundDistribution.mockClear();
});

describe('applyFundDistribution', () => {
  it('delegates to the addFundDistribution lib helper with fund/investor roles, and logs the changelog', async () => {
    const result = await applyFundDistribution({
      companyId: 'fund-1',
      date: '2026-07-20',
      amount: 25000,
      currency: 'USD',
      fundId: 'inv-1',
    });

    expect(result).toEqual({ eventId: 'ev-1' });

    expect(mockAddFundDistribution).toHaveBeenCalledTimes(1);
    expect(mockAddFundDistribution).toHaveBeenCalledWith({
      fundEntityId: 'fund-1',
      investorId: 'inv-1',
      distribution: { date: new Date('2026-07-20'), amount: 25000, currency: 'USD' },
    });

    expect(createdChangelogRows).toHaveLength(1);
    expect(createdChangelogRows[0]).toMatchObject({
      category: 'Add Distribution',
      description: expect.stringContaining('Added fund distribution of'),
    });
  });

  it('throws when invoked outside the caller\'s transaction', async () => {
    inTransactionFlag = false;

    await expect(
      applyFundDistribution({
        companyId: 'fund-1',
        date: '2026-07-20',
        amount: 25000,
        currency: 'USD',
        fundId: 'inv-1',
      }),
    ).rejects.toThrow('applyFundDistribution must run inside a transaction');

    expect(mockAddFundDistribution).not.toHaveBeenCalled();
  });
});
