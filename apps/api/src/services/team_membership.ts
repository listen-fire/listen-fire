// Ending a membership.
//
// Sessions here are stateless bearer tokens (a signed JWT, 180 days) — there is
// no session table to delete rows from. What every authenticated request DOES
// re-read is the user row, and it only resolves a user whose access is granted
// (`identify_user.ts`). So withdrawing `granted_access_at` is what invalidates
// the live sessions: the next request on an outstanding token fails to resolve
// a user and the caller is signed out. It closes the sign-in door by the same
// stroke, and `resolveSignInForVerifiedEmail` re-opens it if an admin writes the
// address down again.
//
// Access is withdrawn only when the person has no team left. Somebody removed
// from one of two teams is still a member of the other, and their session must
// survive.

import { getCoreQb } from '../lib/kysely';
import { logger } from './logger';
import type { TeamId } from '../generated/kysely/core/Team';
import type { UserId } from '../generated/kysely/core/User';

type RemoveMemberResult =
  | { status: 'removed'; signedOut: boolean }
  | { status: 'not_a_member' }
  | { status: 'last_admin' };

/**
 * Remove someone from a team. Refuses to take the LAST write-access member off
 * a team — a team nobody can administer cannot invite anybody back, so this is
 * the one removal that has no undo.
 */
async function removeMember(input: {
  teamId: TeamId;
  userId: UserId;
}): Promise<RemoveMemberResult> {
  const memberships = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select(['user_id', 'access'])
    .where('team_id', '=', input.teamId)
    .execute();

  const target = memberships.find((m) => m.user_id === input.userId);
  if (!target) return { status: 'not_a_member' };

  const admins = memberships.filter((m) => m.access === 'write');
  if (target.access === 'write' && admins.length === 1) return { status: 'last_admin' };

  await getCoreQb(['team_membership'])
    .deleteFrom('team_membership')
    .where('team_id', '=', input.teamId)
    .where('user_id', '=', input.userId)
    .execute();

  // A pending invite for the same address on this team would silently re-admit
  // them at their next sign-in, so removing a member withdraws that too.
  await getCoreQb(['team_invite', 'user_email'])
    .deleteFrom('team_invite')
    .where('team_id', '=', input.teamId)
    .where((eb) =>
      eb(
        'email',
        'in',
        eb
          .selectFrom('user_email')
          .select('email')
          .where('user_id', '=', input.userId),
      ),
    )
    .execute();

  const remaining = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select('id')
    .where('user_id', '=', input.userId)
    .executeTakeFirst();
  if (remaining) {
    logger.info('[team-membership] removed from one team, still a member elsewhere', {
      teamId: input.teamId,
      userId: input.userId,
    });
    return { status: 'removed', signedOut: false };
  }

  await getCoreQb(['user'])
    .updateTable('user')
    .set({ granted_access_at: null })
    .where('id', '=', input.userId)
    .execute();

  logger.info('[team-membership] removed and signed out', {
    teamId: input.teamId,
    userId: input.userId,
  });
  return { status: 'removed', signedOut: true };
}

export const TeamMembershipService = { removeMember };
export type { RemoveMemberResult };
