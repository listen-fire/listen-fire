// The Directory's two answers say different things: `null` means nobody by
// that identity belongs to the team, `hasAccess: false` means we know them and
// they may not act. These tests hold that line, plus the email normalisation
// every other email→user resolver in the codebase already applies.

interface Row {
  [column: string]: unknown;
}

const state: { people: Row[]; teams: Row[]; wheres: unknown[][]; joins: string[] } = {
  people: [],
  teams: [],
  wheres: [],
  joins: [],
};

interface Chain {
  leftJoin(...args: unknown[]): Chain;
  innerJoin(...args: unknown[]): Chain;
  where(...args: unknown[]): Chain;
  select(...args: unknown[]): Chain;
  orderBy(...args: unknown[]): Chain;
  execute(): Promise<Row[]>;
  executeTakeFirst(): Promise<Row | undefined>;
}

function chainOver(rows: () => Row[]): Chain {
  const chain: Chain = {
    leftJoin: (table: unknown) => {
      state.joins.push(`left ${String(table)}`);
      return chain;
    },
    innerJoin: (table: unknown) => {
      state.joins.push(`inner ${String(table)}`);
      return chain;
    },
    where: (...args: unknown[]) => {
      state.wheres.push(args);
      return chain;
    },
    select: () => chain,
    orderBy: () => chain,
    execute: async () => rows(),
    executeTakeFirst: async () => rows()[0],
  };
  return chain;
}

jest.mock('../../../lib/kysely', () => ({
  getQb: () => ({
    selectFrom: (table: string) =>
      table === 'team' ? chainOver(() => state.teams) : chainOver(() => state.people),
  }),
  getCoreQb: () => ({
    selectFrom: (table: string) =>
      table === 'team' ? chainOver(() => state.teams) : chainOver(() => state.people),
  }),
}));

import { coreDirectory } from '../core_directory';

const TEAM = 'team-1';

function person(over: Row = {}): Row {
  return {
    id: 'user-1',
    name: 'Ada Lovelace',
    username: 'ada',
    granted_access_at: new Date('2026-01-01'),
    email: 'ada@example.com',
    ...over,
  };
}

beforeEach(() => {
  state.people = [];
  state.teams = [];
  state.wheres = [];
  state.joins = [];
});

describe('a person of the team', () => {
  it('carries their display name, primary email, and the right to act', async () => {
    state.people = [person()];

    await expect(coreDirectory.userById({ id: 'user-1', teamId: TEAM })).resolves.toEqual({
      id: 'user-1',
      email: 'ada@example.com',
      displayName: 'Ada Lovelace',
      hasAccess: true,
    });
  });

  it('falls back to the username when the row has no display name', async () => {
    state.people = [person({ name: null })];

    await expect(coreDirectory.userById({ id: 'user-1', teamId: TEAM })).resolves.toMatchObject({
      displayName: 'ada',
    });
  });

  it('reports an un-activated account as known but unable to act', async () => {
    state.people = [person({ granted_access_at: null })];

    await expect(coreDirectory.userById({ id: 'user-1', teamId: TEAM })).resolves.toMatchObject({
      hasAccess: false,
    });
  });

  // C-6: `default_team_id` is a landing preference, so a person whose only tie
  // to the team is that column is not of the team at all. The exclusion lives
  // in the join — nothing without a membership row can come back.
  it('is reached only through a membership row, never through the default team', async () => {
    state.people = [person()];

    await coreDirectory.userById({ id: 'user-1', teamId: TEAM });

    expect(state.joins).toContain('inner team_membership as m');
    expect(state.joins).not.toContain('left team_membership as m');
  });

  it('is absent, not access-less, when no row of the team matches', async () => {
    await expect(coreDirectory.userById({ id: 'user-1', teamId: TEAM })).resolves.toBeNull();
  });

  it('has no email at all rather than a null one', async () => {
    state.people = [person({ email: null })];

    const user = await coreDirectory.userById({ id: 'user-1', teamId: TEAM });

    expect(user?.email).toBeUndefined();
  });
});

describe('lookup by email', () => {
  it('matches on the trimmed, lower-cased address', async () => {
    state.people = [person()];

    await expect(
      coreDirectory.userByEmail({ email: '  Ada@Example.COM ', teamId: TEAM }),
    ).resolves.toMatchObject({ id: 'user-1' });
    expect(state.wheres).toContainEqual(['match.email', '=', 'ada@example.com']);
  });

  it('does not query at all for something that is not an address', async () => {
    await expect(coreDirectory.userByEmail({ email: 'ada', teamId: TEAM })).resolves.toBeNull();
    expect(state.wheres).toEqual([]);
  });
});

describe('the rest of the contract', () => {
  it('lists the team’s people', async () => {
    state.people = [person(), person({ id: 'user-2', username: 'bob', name: null, email: null })];

    await expect(coreDirectory.members(TEAM)).resolves.toEqual([
      { id: 'user-1', email: 'ada@example.com', displayName: 'Ada Lovelace', hasAccess: true },
      { id: 'user-2', email: undefined, displayName: 'bob', hasAccess: true },
    ]);
  });

  it('names a team, or reports it missing', async () => {
    state.teams = [{ id: TEAM, name: 'Analytical Engines' }];
    await expect(coreDirectory.team(TEAM)).resolves.toEqual({
      id: TEAM,
      name: 'Analytical Engines',
    });

    state.teams = [];
    await expect(coreDirectory.team(TEAM)).resolves.toBeNull();
  });
});

describe('the teams a login email belongs to', () => {
  const association = (over: Row = {}): Row => ({
    user_id: 'user-1',
    team_id: TEAM,
    ...over,
  });

  it('answers every membership, without repeating one', async () => {
    state.people = [association(), association({ team_id: 'team-2' }), association()];

    await expect(coreDirectory.teamsForEmail('ada@example.com')).resolves.toEqual([
      { userId: 'user-1', teamId: TEAM },
      { userId: 'user-1', teamId: 'team-2' },
    ]);
  });

  // C-6: the home team used to be unioned in here. After the backfill it is a
  // membership like any other, so the only thing that arm could still add is a
  // team the sender is NOT a member of.
  it('associates a sender with nothing when no membership row backs their address', async () => {
    state.people = [];

    await expect(coreDirectory.teamsForEmail('ada@example.com')).resolves.toEqual([]);
    expect(state.joins).toContain('inner team_membership as m');
    expect(state.joins).not.toContain('left team_membership as m');
  });

  it('matches on the trimmed, lower-cased address', async () => {
    state.people = [association()];

    await coreDirectory.teamsForEmail('  Ada@Example.COM ');

    expect(state.wheres).toContainEqual(['ue.email', '=', 'ada@example.com']);
  });

  it('answers nothing — not an error — for an address nobody owns', async () => {
    await expect(coreDirectory.teamsForEmail('stranger@example.com')).resolves.toEqual([]);
  });

  it('does not query at all for something that is not an address', async () => {
    await expect(coreDirectory.teamsForEmail('ada')).resolves.toEqual([]);
    expect(state.wheres).toEqual([]);
  });
});
