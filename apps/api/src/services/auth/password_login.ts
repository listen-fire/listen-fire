// Password login — verify an email + password against the stored scrypt hash.
//
// Deliberately non-enumerating: an unknown email, a social-only user (no
// `password_hash`), a removed member (access withdrawn) and a wrong password all
// resolve to the SAME `null`. The REST caller turns that single null into one
// generic "invalid email or password" so an attacker can't probe which emails
// exist.

import { getCoreQb } from '../../lib/kysely';
import { TeamInviteService } from '../team_invite';
import { verifyPassword } from './password';

/**
 * Resolve email → user and verify the password, then go through the same
 * invite door every other sign-in path uses. Returns the user identity on a
 * match, or `null` for every failure mode (unknown email / no password set /
 * no team / wrong password) — the caller must not distinguish them.
 */
async function loginWithPassword({
  email,
  password,
}: {
  email: string;
  password: string;
}): Promise<{ userId: string; teamId: string; email: string } | null> {
  const lower = email.toLowerCase();

  const userEmail = await getCoreQb(['user_email'])
    .selectFrom('user_email')
    .select('user_id')
    .where('email', '=', lower)
    .executeTakeFirst();
  if (!userEmail) return null;

  const user = await getCoreQb(['user'])
    .selectFrom('user')
    .select(['id', 'password_hash'])
    .where('id', '=', userEmail.user_id)
    .executeTakeFirst();
  if (!user || !user.password_hash) return null;

  if (!(await verifyPassword(password, user.password_hash))) return null;

  // The shared door: it claims pending invites, restores a re-added member's
  // access, and refuses somebody with no team — which is what a removed member
  // is until an admin writes their address down again.
  const resolution = await TeamInviteService.resolveSignInForVerifiedEmail({ email: lower });
  if (resolution.status === 'not_invited') return null;

  return { userId: resolution.userId, teamId: resolution.teamId, email: lower };
}

export { loginWithPassword };
