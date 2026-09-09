import { executeCypher, explainCypher, MutationNotAllowedError } from './index';

describe('executeCypher readOnly guard', () => {
  it('rejects a mutation query with MutationNotAllowedError when readOnly is set', async () => {
    await expect(
      executeCypher({
        query: 'CREATE (c:Company {Name:"x"}) RETURN c',
        teamId: 'team-1',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        qb: {} as any,
        readOnly: true,
      }),
    ).rejects.toThrow(MutationNotAllowedError);

    await expect(
      executeCypher({
        query: 'CREATE (c:Company {Name:"x"}) RETURN c',
        teamId: 'team-1',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        qb: {} as any,
        readOnly: true,
      }),
    ).rejects.toThrow(/cypherWrite/);
  });
});

describe('explainCypher readOnly guard', () => {
  it('rejects a mutation query with MutationNotAllowedError before touching qb/ontology', async () => {
    await expect(
      explainCypher({
        query: 'CREATE (c:Company {Name:"x"}) RETURN c',
        teamId: 'team-1',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        qb: {} as any,
      }),
    ).rejects.toThrow(MutationNotAllowedError);
  });
});
