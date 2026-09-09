// Backend password flows — login, signup-start, signup-confirm. We exercise
// BEHAVIOUR against an in-memory store that interprets the Kysely chains the
// services build; the crypto (scrypt hash + sha256 token) is REAL (no mocks),
// only the DB + provisioning + email + user-lookup seams are doubled.

import { createHash } from 'node:crypto';

type Row = Record<string, unknown>;

const store: { user: Row[]; user_email: Row[]; pending_signup: Row[] } = {
  user: [],
  user_email: [],
  pending_signup: [],
};

function rowsFor(table: string): Row[] {
  if (table in store) return store[table as keyof typeof store];
  throw new Error(`unexpected table ${table}`);
}

// A chain double: records select columns / where filters / insert values / update
// set, then resolves a terminal against `store`. Supports the '=' and '>'
// operators the services use (the latter for the token-expiry check).
function makeChain(table: string, op: 'select' | 'insert' | 'delete' | 'update') {
  const rows = rowsFor(table);
  const where: { col: string; cmp: string; val: unknown }[] = [];
  let insertValues: Row | null = null;
  let updateSet: Row | null = null;

  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.returning = () => chain;
  chain.set = (v: Row) => {
    updateSet = v;
    return chain;
  };
  chain.values = (v: Row) => {
    insertValues = v;
    return chain;
  };
  chain.where = (col: string, cmp: string, val: unknown) => {
    where.push({ col, cmp, val });
    return chain;
  };

  const match = (r: Row) =>
    where.every((w) => {
      if (w.cmp === '=') return r[w.col] === w.val;
      if (w.cmp === '>') return (r[w.col] as Date) > (w.val as Date);
      throw new Error(`unexpected operator ${w.cmp}`);
    });

  chain.executeTakeFirst = async () => rows.find(match);
  chain.execute = async () => {
    if (op === 'insert' && insertValues) {
      rows.push({ ...insertValues });
      return [];
    }
    if (op === 'delete') {
      for (let i = rows.length - 1; i >= 0; i--) if (match(rows[i])) rows.splice(i, 1);
      return [];
    }
    if (op === 'update' && updateSet) {
      for (const r of rows) if (match(r)) Object.assign(r, updateSet);
      return [];
    }
    return rows.filter(match);
  };
  return chain;
}

function makeQb() {
  return {
    selectFrom: (t: string) => makeChain(t, 'select'),
    insertInto: (t: string) => makeChain(t, 'insert'),
    deleteFrom: (t: string) => makeChain(t, 'delete'),
    updateTable: (t: string) => makeChain(t, 'update'),
  };
}

// The invite door: `pendingInvitesFor` gates who may START a signup, and
// `resolveSignInForVerifiedEmail` is what login/confirm go through. Its own
// behaviour is covered against a real DB in
// `services/__test__/team_invite.integration.test.ts`.
const pendingInvitesFor = jest.fn(async () => [] as { id: string; team_id: string }[]);
const resolveSignIn = jest.fn(
  async () =>
    ({ status: 'ok', userId: 'user-1', teamId: 'team-1', email: 'confirm@x.com', created: true }) as
      | { status: 'ok'; userId: string; teamId: string; email: string; created: boolean }
      | { status: 'not_invited' },
);
const findByEmail = jest.fn(async () => null as unknown);
const signupConfirmEmail = jest.fn(
  async (_props: { recipientEmail: string; confirmLink: string; expiryMinutes: number }) => {},
);

jest.mock('../../../lib/kysely', () => ({ getQb: () => makeQb() , getCoreQb: () => makeQb()}));
jest.mock('../../../email/signupConfirmEmail', () => ({ signupConfirmEmail }));
jest.mock('../../team_invite', () => ({
  TeamInviteService: {
    pendingInvitesFor: (...a: unknown[]) => pendingInvitesFor(...(a as [])),
    resolveSignInForVerifiedEmail: (...a: unknown[]) => resolveSignIn(...(a as [])),
  },
}));
jest.mock('../../../lib/middleware/authentication/identify_user', () => ({
  unauthorisedFindUserByEmail: findByEmail,
}));

import { hashPassword } from '../password';
import { loginWithPassword } from '../password_login';
import { startPasswordSignup, confirmPasswordSignup } from '../password_signup';

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

function reset() {
  store.user = [];
  store.user_email = [];
  store.pending_signup = [];
  jest.clearAllMocks();
  pendingInvitesFor.mockResolvedValue([{ id: 'invite-1', team_id: 'team-1' }]);
  resolveSignIn.mockResolvedValue({
    status: 'ok',
    userId: 'user-1',
    teamId: 'team-1',
    email: 'confirm@x.com',
    created: true,
  });
  findByEmail.mockResolvedValue(null);
}

describe('loginWithPassword', () => {
  beforeEach(reset);

  async function seedUser(email: string, password: string | null) {
    store.user_email.push({ email, user_id: 'u1' });
    store.user.push({
      id: 'u1',
      default_team_id: 't1',
      password_hash: password ? await hashPassword(password) : null,
    });
    resolveSignIn.mockResolvedValue({
      status: 'ok',
      userId: 'u1',
      teamId: 't1',
      email: email.toLowerCase(),
      created: false,
    });
  }

  it('returns null for an unknown email (no enumeration)', async () => {
    expect(await loginWithPassword({ email: 'nobody@x.com', password: 'whatever12' })).toBeNull();
  });

  it('returns null when the user has no password set (social-only)', async () => {
    await seedUser('social@x.com', null);
    expect(await loginWithPassword({ email: 'social@x.com', password: 'whatever12' })).toBeNull();
  });

  it('returns null for a wrong password', async () => {
    await seedUser('a@x.com', 'correct-horse-battery');
    expect(await loginWithPassword({ email: 'a@x.com', password: 'wrong-password' })).toBeNull();
  });

  it('returns the user identity for the right password (case-insensitive email)', async () => {
    await seedUser('a@x.com', 'correct-horse-battery');
    expect(await loginWithPassword({ email: 'A@X.com', password: 'correct-horse-battery' })).toEqual(
      { userId: 'u1', teamId: 't1', email: 'a@x.com' },
    );
  });

  it('returns null for a removed member — the right password, but no team left', async () => {
    await seedUser('gone@x.com', 'correct-horse-battery');
    resolveSignIn.mockResolvedValue({ status: 'not_invited' });
    expect(
      await loginWithPassword({ email: 'gone@x.com', password: 'correct-horse-battery' }),
    ).toBeNull();
  });
});

describe('startPasswordSignup', () => {
  beforeEach(reset);

  it('rejects a weak password before looking at the invite', async () => {
    const result = await startPasswordSignup({ email: 'a@x.com', password: 'short' });
    expect(result.status).toBe('weak_password');
    expect(pendingInvitesFor).not.toHaveBeenCalled();
  });

  it('refuses an address nobody invited — no email, no pending row', async () => {
    pendingInvitesFor.mockResolvedValue([]);
    const result = await startPasswordSignup({ email: 'a@x.com', password: 'acceptable-pw' });
    expect(result).toEqual({ status: 'not_invited' });
    expect(signupConfirmEmail).not.toHaveBeenCalled();
    expect(store.pending_signup).toHaveLength(0);
  });

  it('short-circuits to exists when an account already exists (no email, no pending row)', async () => {
    findByEmail.mockResolvedValue({ id: 'u1' });
    const result = await startPasswordSignup({ email: 'a@x.com', password: 'acceptable-pw' });
    expect(result).toEqual({ status: 'exists' });
    expect(signupConfirmEmail).not.toHaveBeenCalled();
    expect(store.pending_signup).toHaveLength(0);
  });

  it('happy path stashes a pending_signup (hashed password, hashed token) and emails a link', async () => {
    const result = await startPasswordSignup({
      email: 'New@X.com',
      password: 'acceptable-pw',
      source: 'password',
    });
    expect(result).toEqual({ status: 'check_email' });
    expect(store.pending_signup).toHaveLength(1);

    const row = store.pending_signup[0];
    expect(row.email).toBe('new@x.com');
    expect(row.terms_accepted).toBe(true);
    expect(String(row.password_hash)).toMatch(/^scrypt\$/); // hashed, not plaintext
    expect(String(row.token_hash)).toHaveLength(64); // sha256 hex

    expect(signupConfirmEmail).toHaveBeenCalledTimes(1);
    const emailArg = signupConfirmEmail.mock.calls[0][0];
    expect(emailArg.recipientEmail).toBe('new@x.com');
    expect(emailArg.confirmLink).toContain('/signup/confirm?token=');
    // The raw token in the link is NOT the stored hash.
    const rawToken = emailArg.confirmLink.split('token=')[1];
    expect(sha256(rawToken)).toBe(row.token_hash);
  });

  it('replaces a prior pending_signup for the same email (resend)', async () => {
    store.pending_signup.push({ email: 'new@x.com', token_hash: 'old', expires_at: new Date() });
    await startPasswordSignup({ email: 'new@x.com', password: 'acceptable-pw' });
    expect(store.pending_signup).toHaveLength(1);
    expect(store.pending_signup[0].token_hash).not.toBe('old');
  });
});

describe('confirmPasswordSignup', () => {
  beforeEach(reset);

  function seedPending(token: string, expiresAt: Date, passwordHash = 'scrypt$stored') {
    store.pending_signup.push({
      email: 'confirm@x.com',
      password_hash: passwordHash,
      token_hash: sha256(token),
      expires_at: expiresAt,
    });
  }

  it('signs in through the invite door, sets the password, and burns the pending row', async () => {
    store.user.push({ id: 'user-1', team_id: 'team-1', password_hash: null });
    seedPending('good-token', new Date(Date.now() + 60_000), 'scrypt$the-stored-hash');

    const result = await confirmPasswordSignup({ token: 'good-token' });

    expect(result).toEqual({ email: 'confirm@x.com', teamId: 'team-1', userId: 'user-1' });
    expect(resolveSignIn).toHaveBeenCalledTimes(1);
    expect(store.user[0].password_hash).toBe('scrypt$the-stored-hash');
    expect(store.pending_signup).toHaveLength(0); // single-use
  });

  it('returns null when the invite was withdrawn between start and confirm', async () => {
    seedPending('good-token', new Date(Date.now() + 60_000));
    resolveSignIn.mockResolvedValue({ status: 'not_invited' });
    expect(await confirmPasswordSignup({ token: 'good-token' })).toBeNull();
    expect(store.pending_signup).toHaveLength(1); // untouched
  });

  it('returns null for an expired token (and signs nobody in)', async () => {
    seedPending('stale-token', new Date(Date.now() - 60_000));
    expect(await confirmPasswordSignup({ token: 'stale-token' })).toBeNull();
    expect(resolveSignIn).not.toHaveBeenCalled();
    expect(store.pending_signup).toHaveLength(1); // untouched
  });

  it('returns null for an unknown token', async () => {
    seedPending('good-token', new Date(Date.now() + 60_000));
    expect(await confirmPasswordSignup({ token: 'not-the-token' })).toBeNull();
    expect(resolveSignIn).not.toHaveBeenCalled();
  });
});
