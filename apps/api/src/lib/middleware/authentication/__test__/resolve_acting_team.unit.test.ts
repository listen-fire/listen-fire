import { resolveActingTeam } from '../resolve_acting_team';
import { PermissionService } from '../../../../services/permission';

/**
 * The auth-resolution seam membership-validates the acting team, and
 * api_key.team_id is authoritative when set. This exercises the full matrix
 * (a-g) from the brief.
 *
 * `hasAccess` is mocked to simulate the user's membership rows. Since C-6 the
 * default team is validated like every other candidate, so the mock has to
 * include HOME wherever the resolution is expected to succeed.
 */

const HOME = 'team-home';
const OTHER = 'team-other';

function mockHasAccess(memberTeams: string[]) {
  jest
    .spyOn(PermissionService, 'hasAccess')
    .mockImplementation(async (_userId: string, teamId: string) =>
      memberTeams.includes(teamId),
    );
}

afterEach(() => jest.restoreAllMocks());

describe('resolveActingTeam', () => {
  // (a) existing key with team_id = home → resolves home, allowed
  it('(a) key pinned to home team resolves to home', async () => {
    mockHasAccess([HOME]);
    const result = await resolveActingTeam({
      userId: 'u1',
      defaultTeamId: HOME,
      apiKeyTeamId: HOME,
      xRequestTeamId: null,
    });
    expect(result).toEqual({ ok: true, teamId: HOME });
  });

  // (b) null key, no header → home
  it('(b) no key pin and no header resolves to home', async () => {
    mockHasAccess([HOME]);
    const result = await resolveActingTeam({
      userId: 'u1',
      defaultTeamId: HOME,
      apiKeyTeamId: null,
      xRequestTeamId: null,
    });
    expect(result).toEqual({ ok: true, teamId: HOME });
  });

  // (c) null key + header to a team the user IS a member of → that team
  it('(c) header to a team the user is a member of resolves to that team', async () => {
    mockHasAccess([OTHER]);
    const result = await resolveActingTeam({
      userId: 'u1',
      defaultTeamId: HOME,
      apiKeyTeamId: null,
      xRequestTeamId: OTHER,
    });
    expect(result).toEqual({ ok: true, teamId: OTHER });
  });

  // (d) null key + header to a team the user is NOT a member of → REJECTED
  it('(d) header to a team the user is not a member of is rejected', async () => {
    mockHasAccess([]);
    const result = await resolveActingTeam({
      userId: 'u1',
      defaultTeamId: HOME,
      apiKeyTeamId: null,
      xRequestTeamId: OTHER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  // (e) key pinned to team T, user IS a member → T
  it('(e) key pinned to a team the user is a member of resolves to that team', async () => {
    mockHasAccess([OTHER]);
    const result = await resolveActingTeam({
      userId: 'u1',
      defaultTeamId: HOME,
      apiKeyTeamId: OTHER,
      xRequestTeamId: null,
    });
    expect(result).toEqual({ ok: true, teamId: OTHER });
  });

  // (f) key pinned to T, user NOT a member → REJECTED
  it('(f) key pinned to a team the user is not a member of is rejected', async () => {
    mockHasAccess([]);
    const result = await resolveActingTeam({
      userId: 'u1',
      defaultTeamId: HOME,
      apiKeyTeamId: OTHER,
      xRequestTeamId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  // (g) key pinned to T + header to T' (≠T) → REJECTED (key may not be escaped)
  it('(g) key pin and a divergent header are rejected without a membership lookup', async () => {
    const spy = jest.spyOn(PermissionService, 'hasAccess');
    const result = await resolveActingTeam({
      userId: 'u1',
      defaultTeamId: HOME,
      apiKeyTeamId: OTHER,
      xRequestTeamId: 'team-third',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
    // Rejected on the restriction rule before any membership lookup.
    expect(spy).not.toHaveBeenCalled();
  });

  it('key pin and a matching header are allowed when the user is a member', async () => {
    mockHasAccess([OTHER]);
    const result = await resolveActingTeam({
      userId: 'u1',
      defaultTeamId: HOME,
      apiKeyTeamId: OTHER,
      xRequestTeamId: OTHER,
    });
    expect(result).toEqual({ ok: true, teamId: OTHER });
  });

  it('the home team is membership-checked like any other candidate', async () => {
    mockHasAccess([HOME]);
    const result = await resolveActingTeam({
      userId: 'u1',
      defaultTeamId: HOME,
      apiKeyTeamId: null,
      xRequestTeamId: HOME,
    });
    expect(result).toEqual({ ok: true, teamId: HOME });
    expect(PermissionService.hasAccess).toHaveBeenCalledWith('u1', HOME);
  });

  // C-6: `default_team_id` is a preference, not a grant. A user whose default
  // team has no membership row — removed from it, or never granted — is
  // refused, where the old home-team short-circuit let them straight in.
  it('refuses the default team when no membership row backs it', async () => {
    mockHasAccess([]);
    const result = await resolveActingTeam({
      userId: 'u1',
      defaultTeamId: HOME,
      apiKeyTeamId: null,
      xRequestTeamId: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
});
