/**
 * Unit-tests for `triggers.ts`. The router procedures are DB-bound
 * (covered by integration tests); `renameTriggerImpl` is factored out so
 * its team-scoped UPDATE shape can be locked down here. The TG-body /
 * orchestration helpers the detail page used were removed with the
 * translation-graph kill (phase 6).
 */

import { triggersRouter } from '../triggers';

describe('triggers router — sanity', () => {
  it('exports the router factory', () => {
    expect(typeof triggersRouter).toBe('function');
  });
});

// renameTrigger — DB-bound mutation, factored into `renameTriggerImpl`
// so the team-scoped UPDATE shape can be locked down here without
// standing up a real tRPC router or DB. The procedure body itself is a
// thin wrapper that pulls `teamId` from `currentContext()` and delegates.
//
// Two cases worth pinning:
//   (1) happy path — emits the correct UPDATE … WHERE id = ? AND
//       team_id = ? RETURNING id, name and surfaces the new name;
//   (2) unauthorized / not-found — when the team-scoped WHERE matches
//       zero rows (wrong team OR missing id), throw the same shape so
//       a stolen id from another tenant can't be distinguished from a
//       genuine 404.
describe('renameTrigger (C2)', () => {
  const TEAM_ID = 'team-1' as never;
  const OTHER_TEAM_ID = 'team-2' as never;
  const TRIGGER_ID = 'trig-1';

  let lastUpdate: {
    table?: string;
    set?: Record<string, unknown>;
    wheres: Array<[string, string, unknown]>;
    returning?: string[];
  };
  let executeReturn: { id: string; name: string } | undefined;

  function makeQbStub() {
    const stub: any = {
      updateTable: (table: string) => {
        lastUpdate = { table, wheres: [] };
        return stub;
      },
      set: (values: Record<string, unknown>) => {
        lastUpdate.set = values;
        return stub;
      },
      where: (col: string, op: string, val: unknown) => {
        lastUpdate.wheres.push([col, op, val]);
        return stub;
      },
      returning: (cols: string[]) => {
        lastUpdate.returning = cols;
        return stub;
      },
      executeTakeFirst: async () => executeReturn,
    };
    return stub;
  }

  beforeEach(() => {
    jest.resetModules();
    lastUpdate = { wheres: [] };
    executeReturn = { id: TRIGGER_ID, name: 'New Name' };

    jest.doMock('../../../../lib/kysely', () => ({
      getKnowledgeQb: jest.fn(() => makeQbStub()),
      getAutomationsQb: jest.fn(() => makeQbStub()),
      getQb: jest.fn(() => makeQbStub()),
      getCoreQb: jest.fn(() => makeQbStub()),
    }));
  });

  afterEach(() => {
    jest.dontMock('../../../../lib/kysely');
  });

  it('happy path: scopes UPDATE to (id, team_id) and returns the new name', async () => {
    const { renameTriggerImpl } = await import('../triggers');
    const result = await renameTriggerImpl({
      triggerId: TRIGGER_ID,
      name: 'New Name',
      teamId: TEAM_ID,
    });
    expect(result).toEqual({ id: TRIGGER_ID, name: 'New Name' });
    expect(lastUpdate.table).toBe('trigger');
    expect(lastUpdate.set?.name).toBe('New Name');
    expect(lastUpdate.wheres).toEqual(
      expect.arrayContaining([
        ['id', '=', TRIGGER_ID],
        ['team_id', '=', TEAM_ID],
      ]),
    );
    expect(lastUpdate.returning).toEqual(['id', 'name']);
  });

  it('rejects (throws not-found) when no row matches — stolen-id / wrong-team', async () => {
    executeReturn = undefined; // team-scoped WHERE matches 0 rows
    const { renameTriggerImpl } = await import('../triggers');
    await expect(
      renameTriggerImpl({
        triggerId: TRIGGER_ID,
        name: 'Hijack',
        teamId: OTHER_TEAM_ID,
      }),
    ).rejects.toThrow(`Automation ${TRIGGER_ID} not found`);
  });
});
