// Characterization test for `applyMarkdown` — the shared service extracted
// from the inline `addMarkdown` tRPC mutation (company.ts). It exercises the
// same row-creation + derivation math as the original handler.
//
// `.unit.test.ts` runs under `src/test/jest-unit.config.ts`, which wires up
// no test database — only `.integration.test.ts` does that (globalSetup +
// harness/env.ts). Every sibling `apps/api/src/lib/**/__test__/*.unit.test.ts`
// that touches `getQb`/`currentContext` mocks them in-memory rather than
// hitting Postgres (see `lib/slack/__test__/slack.unit.test.ts` for the
// `getQb` mock-chain pattern, and `lib/knowledge/__test__/
// orchestrator_funnel_context.unit.test.ts` for the `currentContext().prisma`
// mock pattern) — this test copies both.

const equityAssetRows = [{ id: 'asset-equity-1' }];
const equityPriceRows = [
  { asset_id: 'asset-equity-1', price: 1000, currency: 'USD', date: new Date('2026-01-01') },
];
const convertibleRows = [
  { asset_id: 'asset-conv-1', convertible_amount: 500, convertible_currency: 'USD' },
];

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
      if (from === 'asset') return fakeSelectChain(equityAssetRows);
      if (from === 'price') return fakeSelectChain(equityPriceRows);
      if (from === 'asset as a') return fakeSelectChain(convertibleRows);
      // logFundingChange's fund-linking select — no funds invested, in this test
      if (from === 'investment') return fakeSelectChain([]);
      throw new Error(`markdown.unit.test: unexpected selectFrom(${from})`);
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
      throw new Error(`markdown.unit.test: unexpected insertInto(${table})`);
    },
  });
  return { getQb: qb, getCoreQb: qb, getValuationsQb: qb };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdEvents: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdNotes: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const createdPrices: any[] = [];
let idCounter = 0;

jest.mock('../../../../services/context', () => ({
  currentContext: () => ({
    user: { id: 'user-1', teamId: 'team-1' },
    // applyMarkdown no longer opens its own transaction — the caller (the
    // tRPC procedure) does that. This mirrors the ambient transaction the
    // caller establishes with ctx.enterTransaction() before invoking it.
    inTransaction: true,
    prisma: {
      event: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `event-${++idCounter}`, ...data };
          createdEvents.push(row);
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

import { applyMarkdown } from '../markdown';

beforeEach(() => {
  createdEvents.length = 0;
  createdNotes.length = 0;
  createdPrices.length = 0;
  createdChangelogRows.length = 0;
  idCounter = 0;
});

describe('applyMarkdown', () => {
  it('creates the MARKDOWN event, its note, and derived FROM_ASSET_HOLDER prices inside one transaction', async () => {
    const result = await applyMarkdown({
      companyId: 'company-1',
      date: '2026-07-20',
      percentage: 40,
      note: 'board pack',
    });

    // event
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]).toMatchObject({
      type: 'MARKDOWN',
      legalEntityId: 'company-1',
      teamId: 'team-1',
      data: { percentage: 40 },
    });
    const eventId = createdEvents[0].id;

    // note — server persists it today; that must be preserved
    expect(createdNotes).toHaveLength(1);
    expect(createdNotes[0]).toMatchObject({
      message: 'board pack',
      referenceId: eventId,
      noteType: 'EVENT',
      createdBy: 'user-1',
      teamId: 'team-1',
    });

    // prices: one equity-level, one per convertible
    expect(createdPrices).toHaveLength(2);
    const equityPrice = createdPrices.find((p) => p.assetId === undefined);
    const convertiblePrice = createdPrices.find((p) => p.assetId === 'asset-conv-1');

    expect(equityPrice).toMatchObject({
      type: 'FROM_ASSET_HOLDER',
      price: 1000 * 0.6,
      currency: 'USD',
      legalEntityId: 'company-1',
      eventId,
    });
    expect(convertiblePrice).toMatchObject({
      type: 'FROM_ASSET_HOLDER',
      price: 500 * 0.6,
      currency: 'USD',
      legalEntityId: 'company-1',
      eventId,
    });

    // return shape carries every created id
    expect(result.eventId).toBe(eventId);
    expect(result.priceIds.slice().sort()).toEqual(
      [equityPrice.id, convertiblePrice.id].sort(),
    );

    // audit — the funding changelog entry is a property of the command itself,
    // so REST/movement callers get the same audit row a tab click does.
    expect(createdChangelogRows).toHaveLength(1);
    expect(createdChangelogRows[0]).toMatchObject({
      category: 'Add Markdown',
      description: expect.stringContaining('Added markdown of 40%'),
    });
  });

  it('does not create a note when none is provided', async () => {
    await applyMarkdown({
      companyId: 'company-1',
      date: '2026-07-20',
      percentage: 40,
    });

    expect(createdNotes).toHaveLength(0);
  });
});
