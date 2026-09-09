// The MCP surface's team-scoping vocabulary, now a thin adapter over the
// Principal contract. The RULES it used to own (pinned keys, membership gates,
// the refusal that hands back the team list) are the provider's and are pinned
// by `services/principal/__test__/core_teams.unit.test.ts`; what is left to
// check here is that this surface asks the provider rather than deciding
// anything itself, plus the one question that is only asked here —
// `teamSetForReads`, whose empty-membership fallback has no provider analogue.

import { TeamScopeError, type Principal, type TeamRef } from 'principal';

let principal: Principal;
const listTeams = jest.fn<Promise<TeamRef[]>, [Principal]>();
const resolveTeam = jest.fn<Promise<TeamRef>, [Principal, string | undefined]>();

jest.mock('principal', () => {
  const actual = jest.requireActual('principal');
  return { ...actual, currentPrincipal: () => principal };
});

jest.mock('../../../../services/principal', () => ({
  principalProvider: () => ({ listTeams, resolveTeam }),
}));

import {
  listAccessibleTeams,
  resolveToolTeam,
  teamSetForReads,
  ToolTeamError,
} from '../team_scope';

const team = (teamId: string, over: Partial<TeamRef> = {}): TeamRef => ({
  teamId,
  name: teamId.toUpperCase(),
  access: 'write',
  isPersonal: false,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  principal = {
    teamId: 'team-a',
    userId: 'user-1',
    access: 'write',
    scopes: ['*'],
    pinnedTeamId: null,
  };
});

describe('the surface asks the provider', () => {
  it('lists the principal’s teams, verbatim', async () => {
    listTeams.mockResolvedValue([team('team-a', { isPersonal: true }), team('team-b')]);

    await expect(listAccessibleTeams()).resolves.toEqual([
      team('team-a', { isPersonal: true }),
      team('team-b'),
    ]);
    expect(listTeams).toHaveBeenCalledWith(principal);
  });

  it('resolves a team through the provider and returns its id', async () => {
    resolveTeam.mockResolvedValue(team('team-b'));

    await expect(resolveToolTeam('team-b')).resolves.toBe('team-b');
    expect(resolveTeam).toHaveBeenCalledWith(principal, 'team-b');
  });

  it('lets the provider’s refusal through as the error this surface maps to 400', async () => {
    const teams = [team('team-a'), team('team-b')];
    resolveTeam.mockRejectedValue(new TeamScopeError('pick one', teams));

    const error = await resolveToolTeam().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolTeamError);
    expect((error as ToolTeamError).teams).toEqual(teams);
  });
});

describe('teamSetForReads', () => {
  it('covers every team the connection can act in', async () => {
    listTeams.mockResolvedValue([team('team-a'), team('team-b')]);

    await expect(teamSetForReads()).resolves.toEqual(['team-a', 'team-b']);
  });

  it('falls back to the acting team when the connection spans nothing', async () => {
    listTeams.mockResolvedValue([]);

    await expect(teamSetForReads()).resolves.toEqual(['team-a']);
  });
});
