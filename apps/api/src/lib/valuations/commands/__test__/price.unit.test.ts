// Characterization test for `applyPrice` — the shared service extracted
// from the inline `addPrice` tRPC mutation (company.ts). It exercises the
// same row-creation logic as the original handler.
//
// `.unit.test.ts` runs under `src/test/jest-unit.config.ts`, which wires up
// no test database — only `.integration.test.ts` does that (globalSetup +
// harness/env.ts). Mocks `getQb`/`currentContext` in-memory rather than
// hitting Postgres — mirrors `markdown.unit.test.ts`.

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
      throw new Error(`price.unit.test: unexpected selectFrom(${from})`);
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
      throw new Error(`price.unit.test: unexpected insertInto(${table})`);
    },
  });
  return { getQb: qb, getCoreQb: qb, getValuationsQb: qb };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdPrices: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdNotes: any[] = [];
let idCounter = 0;
let inTransaction = true;

jest.mock('../../../../services/context', () => ({
  currentContext: () => ({
    user: { id: 'user-1', teamId: 'team-1' },
    // applyPrice does not open its own transaction — the caller (the tRPC
    // procedure) does that. This mirrors the ambient transaction the caller
    // establishes with ctx.enterTransaction() before invoking it.
    inTransaction,
    prisma: {
      price: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `price-${++idCounter}`, ...data };
          createdPrices.push(row);
          return row;
        },
      },
      note: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `note-${++idCounter}`, ...data };
          createdNotes.push(row);
          return row;
        },
      },
    },
  }),
}));

import { applyPrice } from '../price';
import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';

beforeEach(() => {
  createdPrices.length = 0;
  createdNotes.length = 0;
  createdChangelogRows.length = 0;
  idCounter = 0;
  inTransaction = true;
});

describe('applyPrice', () => {
  it('creates the Price row and logs the funding change inside one transaction', async () => {
    const result = await applyPrice({
      companyId: 'company-1',
      price: 1000,
      currency: CurrencyIsoCode.USD,
      date: '2026-07-20',
      note: 'board pack',
    });

    expect(createdPrices).toHaveLength(1);
    expect(createdPrices[0]).toMatchObject({
      legalEntityId: 'company-1',
      price: 1000,
      currency: CurrencyIsoCode.USD,
      type: 'FROM_PRICED_ROUND',
      teamId: 'team-1',
    });
    const priceId = createdPrices[0].id;

    expect(result).toEqual({ priceId });

    // note — server persists it today; that must be preserved
    expect(createdNotes).toHaveLength(1);
    expect(createdNotes[0]).toMatchObject({
      message: 'board pack',
      referenceId: priceId,
      noteType: 'PRICE',
      createdBy: 'user-1',
      teamId: 'team-1',
    });

    // audit — the funding changelog entry is a property of the command
    // itself, so REST/movement callers get the same audit row a tab click does.
    expect(createdChangelogRows).toHaveLength(1);
    expect(createdChangelogRows[0]).toMatchObject({
      category: 'Add Price',
      description: expect.stringContaining('Added price of USD 1K'),
    });
  });

  it('does not create a note when none is provided', async () => {
    await applyPrice({
      companyId: 'company-1',
      price: 500,
      currency: CurrencyIsoCode.USD,
    });

    expect(createdNotes).toHaveLength(0);
  });

  it('defaults the date to now when none is provided', async () => {
    await applyPrice({
      companyId: 'company-1',
      price: 500,
      currency: CurrencyIsoCode.USD,
    });

    expect(createdPrices[0].date).toBeInstanceOf(Date);
  });

  it('throws when called outside a transaction', async () => {
    inTransaction = false;
    await expect(
      applyPrice({ companyId: 'company-1', price: 500, currency: CurrencyIsoCode.USD }),
    ).rejects.toThrow(/applyPrice must run inside a transaction/);
  });
});
