import {
  PUBLIC_USER_VAR,
  TEAM_ID_VAR,
  TEAM_NAME_PINNED_VAR,
  TEAM_NAME_VAR,
  USER_EMAIL_VAR,
  type InstallState,
  planBootstrap,
} from '../core';

const EMPTY: InstallState = { teams: 0, users: 0, publicIdentity: false };

const CONFIGURED = {
  [TEAM_NAME_VAR]: 'Acme',
  [USER_EMAIL_VAR]: 'ops@acme.test',
  [PUBLIC_USER_VAR]: '40087837-1509-4eeb-935d-ce004ca4a5c7',
};

describe('planBootstrap — the emptiness predicate', () => {
  it('provisions a database with no teams and no users', () => {
    expect(planBootstrap(EMPTY, CONFIGURED)).toEqual({
      action: 'provision',
      teamName: 'Acme',
      email: 'ops@acme.test',
      publicUserId: CONFIGURED[PUBLIC_USER_VAR],
    });
  });

  it('still provisions when only the public identity is present — it is machinery, not people', () => {
    // The state the reader hands us already subtracts the public rows; this is
    // what makes a crash between the two halves resumable on the next boot.
    const plan = planBootstrap({ teams: 0, users: 0, publicIdentity: true }, CONFIGURED);
    expect(plan.action).toBe('provision');
  });

  it('never touches an install that has a team or a user', () => {
    for (const state of [
      { teams: 1, users: 0, publicIdentity: true },
      { teams: 0, users: 1, publicIdentity: true },
      { teams: 3, users: 5, publicIdentity: false },
    ]) {
      expect(planBootstrap(state, CONFIGURED)).toEqual({ action: 'skip', state });
    }
  });

  it('is idempotent: the state it leaves behind is one it skips', () => {
    // Provisioning creates a team and a user, so the very next boot skips.
    expect(planBootstrap(EMPTY, CONFIGURED).action).toBe('provision');
    expect(planBootstrap({ teams: 1, users: 1, publicIdentity: true }, CONFIGURED).action).toBe(
      'skip',
    );
  });
});

describe('planBootstrap — the environment', () => {
  it('provisions nothing, all or nothing, when a variable is missing', () => {
    expect(planBootstrap(EMPTY, {})).toEqual({
      action: 'unconfigured',
      missing: [TEAM_NAME_VAR, USER_EMAIL_VAR, PUBLIC_USER_VAR],
    });
    expect(planBootstrap(EMPTY, { ...CONFIGURED, [USER_EMAIL_VAR]: '   ' })).toEqual({
      action: 'unconfigured',
      missing: [USER_EMAIL_VAR],
    });
  });

  it('rejects a public identity that is not a uuid rather than failing at the insert', () => {
    expect(planBootstrap(EMPTY, { ...CONFIGURED, [PUBLIC_USER_VAR]: 'public' })).toEqual({
      action: 'unconfigured',
      missing: [PUBLIC_USER_VAR],
    });
  });

  it('does not nag a provisioned install about bootstrap variables it will never use', () => {
    const state = { teams: 1, users: 1, publicIdentity: true };
    expect(planBootstrap(state, {})).toEqual({ action: 'skip', state });
  });
});

describe('planBootstrap — the installation\u2019s own team', () => {
  const PINNED = '9a2f0b1e-5c44-4f0a-8c3d-1b6f7e2a9d10';

  it('provisions the team the installer named, rather than one of its own', () => {
    expect(planBootstrap(EMPTY, { ...CONFIGURED, [TEAM_ID_VAR]: PINNED })).toEqual({
      action: 'provision',
      teamName: 'Acme',
      teamId: PINNED,
      email: 'ops@acme.test',
      publicUserId: CONFIGURED[PUBLIC_USER_VAR],
    });
  });

  it('mints an id when the installation names none — the older shape still works', () => {
    const plan = planBootstrap(EMPTY, CONFIGURED);
    expect(plan.action).toBe('provision');
    expect(plan).toMatchObject({ teamId: undefined });
  });

  it('rejects a pinned team that is not a uuid rather than failing at the insert', () => {
    expect(planBootstrap(EMPTY, { ...CONFIGURED, [TEAM_ID_VAR]: 'the-team' })).toEqual({
      action: 'unconfigured',
      missing: [TEAM_ID_VAR],
    });
  });

  it('prefers the name every unit reads over the bootstrap-only one', () => {
    const plan = planBootstrap(EMPTY, { ...CONFIGURED, [TEAM_NAME_PINNED_VAR]: 'Northwind' });
    expect(plan).toMatchObject({ action: 'provision', teamName: 'Northwind' });
  });

  it('falls back to the bootstrap-only name when the installer named none', () => {
    const plan = planBootstrap(EMPTY, { ...CONFIGURED, [TEAM_NAME_PINNED_VAR]: '   ' });
    expect(plan).toMatchObject({ action: 'provision', teamName: CONFIGURED[TEAM_NAME_VAR] });
  });
});
