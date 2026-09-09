// Gap #1 — team-aware KG reads. A KG read tool now accepts an optional `team`
// and resolves it via resolveToolTeam, threading the resolved team id into the
// underlying (team-scoped) read instead of the session's default team. This
// pins that wiring for `getNodeDetail`; the other reads (query/schema/cypher/
// getOntology/getRecipe) share the same resolveToolTeam path and are exercised
// through the real MCP path in the dev loop.

const getNodeDetailMock = jest.fn(async () => ({ id: 'n1', properties: {} }));
const resolveToolTeamMock = jest.fn(async (team?: string) => team ?? 'home');

jest.mock('../../../../lib/knowledge/knowledge_query', () => ({
  getNodeDetail: (...args: unknown[]) => getNodeDetailMock(...(args as [])),
}));

jest.mock('../team_scope', () => {
  class ToolTeamError extends Error {}
  return {
    ToolTeamError,
    resolveToolTeam: (team?: string) => resolveToolTeamMock(team),
    // unused by getNodeDetailHandler but imported at module load
    listAccessibleTeams: jest.fn(),
    teamSetForReads: jest.fn(),
    teamNames: jest.fn(),
  };
});

import { getNodeDetailHandler } from '../knowledge_agent_tools';

function fakeRes() {
  const res: {
    statusCode?: number;
    body?: unknown;
    status: (n: number) => typeof res;
    json: (b: unknown) => typeof res;
  } = {
    status(n: number) {
      res.statusCode = n;
      return res;
    },
    json(b: unknown) {
      res.body = b;
      return res;
    },
  };
  return res;
}

beforeEach(() => {
  getNodeDetailMock.mockClear();
  resolveToolTeamMock.mockClear();
});

describe('getNodeDetail — team resolution', () => {
  it('threads the resolved `team` into the underlying read', async () => {
    const req = { params: { id: 'n1' }, query: { team: 'B' } } as never;
    const res = fakeRes();
    await getNodeDetailHandler(req, res as never, (() => {}) as never);

    expect(resolveToolTeamMock).toHaveBeenCalledWith('B');
    // getNodeDetail(id, resolvedTeam, mode)
    expect(getNodeDetailMock).toHaveBeenCalledWith('n1', 'B', 'full');
    expect(res.statusCode).toBe(200);
  });

  it('omitting `team` resolves through resolveToolTeam (default team)', async () => {
    const req = { params: { id: 'n1' }, query: {} } as never;
    const res = fakeRes();
    await getNodeDetailHandler(req, res as never, (() => {}) as never);

    expect(resolveToolTeamMock).toHaveBeenCalledWith(undefined);
    expect(getNodeDetailMock).toHaveBeenCalledWith('n1', 'home', 'full');
  });
});
