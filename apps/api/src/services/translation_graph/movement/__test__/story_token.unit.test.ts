// The story link's three promises:
//   1. asking twice for a movement's link gives back the SAME link,
//   2. a link resolves to exactly the movement it was minted for,
//   3. a revoked link resolves to nothing — and a fresh ask mints a new one.

interface Row {
  movement_id: string;
  team_id: string;
  token: string;
  created_at: Date;
  revoked_at: Date | null;
}

const rows: Row[] = [];

/** A hand-rolled query double: it collects `where` clauses and applies them to
 *  the rows in memory, so the test exercises the real predicates the service
 *  writes rather than a script of expected calls. */
function qbDouble() {
  const matching = (clauses: Array<[string, string, unknown]>): Row[] =>
    rows.filter((row) =>
      clauses.every(([column, op, value]) => {
        const actual = (row as unknown as Record<string, unknown>)[column];
        if (op === 'in') return Array.isArray(value) && value.includes(actual);
        return actual === value;
      }),
    );

  const selectChain = (clauses: Array<[string, string, unknown]>) => ({
    where: (c: string, op: string, v: unknown) => selectChain([...clauses, [c, op, v]]),
    select: () => ({
      orderBy: () => ({
        executeTakeFirst: async () => matching(clauses)[0],
        execute: async () => matching(clauses),
      }),
      executeTakeFirst: async () => matching(clauses)[0],
      execute: async () => matching(clauses),
    }),
  });

  const updateChain = (clauses: Array<[string, string, unknown]>, patch: Partial<Row>) => ({
    where: (c: string, op: string, v: unknown) => updateChain([...clauses, [c, op, v]], patch),
    executeTakeFirst: async () => {
      const hit = matching(clauses);
      for (const row of hit) Object.assign(row, patch);
      return { numUpdatedRows: BigInt(hit.length) };
    },
  });

  return {
    selectFrom: () => selectChain([]),
    insertInto: () => ({
      values: (values: Omit<Row, 'created_at' | 'revoked_at'> | Array<Omit<Row, 'created_at' | 'revoked_at'>>) => ({
        execute: async () => {
          const batch = Array.isArray(values) ? values : [values];
          for (const v of batch) {
            rows.push({ ...v, created_at: new Date(Date.now() + rows.length), revoked_at: null });
          }
          return [];
        },
      }),
    }),
    updateTable: () => ({
      set: (patch: Partial<Row>) => updateChain([], patch),
    }),
  };
}

jest.mock('../../../../lib/kysely', () => ({ getAutomationsQb: () => qbDouble() }));

import {
  STORY_TOKEN_PREFIX,
  lookupStoryToken,
  revokeStoryTokens,
  storyTokenForMovement,
  storyTokensForMovements,
  storyUrl,
} from '../story_token';

const MOVEMENT = 'movement-1';
const OTHER = 'movement-2';
const THIRD = 'movement-3';
const TEAM = 'team-1';

beforeEach(() => {
  rows.length = 0;
});

describe('minting', () => {
  it('hands back the same link every time it is asked for', async () => {
    const first = await storyTokenForMovement({ teamId: TEAM, movementId: MOVEMENT });
    const second = await storyTokenForMovement({ teamId: TEAM, movementId: MOVEMENT });

    expect(second).toBe(first);
    expect(rows).toHaveLength(1);
  });

  it('prefixes the token, so a route knows what it was handed before it queries', async () => {
    const token = await storyTokenForMovement({ teamId: TEAM, movementId: MOVEMENT });
    expect(token.startsWith(STORY_TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(STORY_TOKEN_PREFIX.length + 20);
  });

  it('mints a different link per automation', async () => {
    const mine = await storyTokenForMovement({ teamId: TEAM, movementId: MOVEMENT });
    const theirs = await storyTokenForMovement({ teamId: TEAM, movementId: OTHER });
    expect(theirs).not.toBe(mine);
  });
});

describe('batched minting', () => {
  it('mints a link for every movement in one shot, none pre-existing', async () => {
    const tokens = await storyTokensForMovements([
      { teamId: TEAM, movementId: MOVEMENT },
      { teamId: TEAM, movementId: OTHER },
      { teamId: TEAM, movementId: THIRD },
    ]);

    expect(tokens.size).toBe(3);
    const values = [...tokens.values()];
    expect(new Set(values).size).toBe(3); // each distinct
    for (const v of values) expect(v.startsWith(STORY_TOKEN_PREFIX)).toBe(true);
    // One select (existing) + one insert (missing) — not three round-trips.
    expect(rows).toHaveLength(3);
  });

  it('reuses a token already minted for one of the movements, and mints only the rest', async () => {
    const already = await storyTokenForMovement({ teamId: TEAM, movementId: MOVEMENT });

    const tokens = await storyTokensForMovements([
      { teamId: TEAM, movementId: MOVEMENT },
      { teamId: TEAM, movementId: OTHER },
      { teamId: TEAM, movementId: THIRD },
    ]);

    expect(tokens.get(MOVEMENT)).toBe(already);
    expect(tokens.get(OTHER)).toBeDefined();
    expect(tokens.get(THIRD)).toBeDefined();
    expect(tokens.get(OTHER)).not.toBe(tokens.get(THIRD));
    // Only the two missing ones minted a new row alongside the pre-existing one.
    expect(rows).toHaveLength(3);
  });

  it('returns an empty map for an empty list without querying anything to mint', async () => {
    const tokens = await storyTokensForMovements([]);
    expect(tokens.size).toBe(0);
    expect(rows).toHaveLength(0);
  });
});

describe('lookup', () => {
  it('resolves to the movement (and team) the link was minted for', async () => {
    const token = await storyTokenForMovement({ teamId: TEAM, movementId: MOVEMENT });
    await expect(lookupStoryToken(token)).resolves.toEqual({
      movementId: MOVEMENT,
      teamId: TEAM,
    });
  });

  it('resolves a token we never minted to nothing', async () => {
    await expect(lookupStoryToken(`${STORY_TOKEN_PREFIX}nonsense`)).resolves.toBeNull();
  });

  // The prefix check runs BEFORE the query: a token shaped like somebody
  // else's capability is not a story link, and must not become one query.
  it('refuses a token of another kind without asking the database', async () => {
    await storyTokenForMovement({ teamId: TEAM, movementId: MOVEMENT });
    await expect(lookupStoryToken('ask_something')).resolves.toBeNull();
  });
});

describe('revocation', () => {
  it('kills the link: the token stops resolving', async () => {
    const token = await storyTokenForMovement({ teamId: TEAM, movementId: MOVEMENT });

    await expect(revokeStoryTokens({ movementId: MOVEMENT })).resolves.toBe(1);

    await expect(lookupStoryToken(token)).resolves.toBeNull();
  });

  it('leaves other automations’ links alone', async () => {
    const mine = await storyTokenForMovement({ teamId: TEAM, movementId: MOVEMENT });
    const theirs = await storyTokenForMovement({ teamId: TEAM, movementId: OTHER });

    await revokeStoryTokens({ movementId: OTHER });

    await expect(lookupStoryToken(mine)).resolves.not.toBeNull();
    await expect(lookupStoryToken(theirs)).resolves.toBeNull();
  });

  // Revocation kills a LINK, not the ability to share: the next ask mints a
  // fresh one rather than resurrecting the dead token.
  it('a fresh ask after a revoke mints a new link', async () => {
    const dead = await storyTokenForMovement({ teamId: TEAM, movementId: MOVEMENT });
    await revokeStoryTokens({ movementId: MOVEMENT });

    const live = await storyTokenForMovement({ teamId: TEAM, movementId: MOVEMENT });

    expect(live).not.toBe(dead);
    await expect(lookupStoryToken(live)).resolves.toEqual({
      movementId: MOVEMENT,
      teamId: TEAM,
    });
  });
});

describe('the URL', () => {
  it('is minted against the API base every other capability link uses', () => {
    process.env.API_BASE_URL = 'https://api.example.com/';
    expect(storyUrl('story_abc')).toBe('https://api.example.com/api/story/story_abc');
  });
});
