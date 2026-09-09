// The team-members settings surface: who is on the team, who is invited, and
// the three acts an admin has — add an address, withdraw one, remove a member.
//
// Inviting is unlimited and sends nothing: `TeamInviteService.addInvite` writes
// a pending membership and the person joins the next time they sign in. Any
// write-access member may manage the team.

import { z } from 'zod';

import { currentContext } from '../../../services/context';
import { TeamInviteService } from '../../../services/team_invite';
import { TeamMembershipService } from '../../../services/team_membership';
import { trpc } from '../trpc';
import { getCoreQb } from '../../../lib/kysely';
import type { TeamId } from '../../../generated/kysely/core/Team';
import type { UserId } from '../../../generated/kysely/core/User';
import type { TeamInviteId } from '../../../generated/kysely/core/TeamInvite';
import { userProcedure as sharedUserProcedure } from '../procedures';
import { neverAsAny } from '../../../lib/utils/types';

/** Throw unless the acting user holds write access on the team. */
async function requireWriteAccess(teamId: TeamId, userId: UserId): Promise<void> {
  const membership = await getCoreQb(['team_membership'])
    .selectFrom('team_membership')
    .select('access')
    .where('team_id', '=', teamId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (membership?.access !== 'write') {
    throw new Error('Only members with write access can manage the team.');
  }
}

const teamMembersRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    /** Everything the /settings/team page renders in one read. */
    overview: userProcedure.query(async () => {
      const ctx = currentContext();
      const teamId = ctx.user.teamId as TeamId;

      const members = await getCoreQb(['team_membership', 'user', 'user_email'])
        .selectFrom('team_membership')
        .innerJoin('user', 'user.id', 'team_membership.user_id')
        .leftJoin('user_email', (join) =>
          join
            .onRef('user_email.user_id', '=', 'user.id')
            .on('user_email.is_primary', '=', true),
        )
        .select([
          'user.id as userId',
          'user.username as username',
          'user_email.email as email',
          'team_membership.access as access',
          'team_membership.created_at as joinedAt',
        ])
        .where('team_membership.team_id', '=', teamId)
        .orderBy('team_membership.created_at', 'asc')
        .execute();

      const invites = await TeamInviteService.listPendingInvites(teamId);

      return {
        members: members.map((m) => ({
          userId: m.userId,
          username: m.username,
          email: m.email === null ? null : String(m.email),
          access: m.access,
          joinedAt: m.joinedAt,
        })),
        invites: invites.map((i) => ({
          id: i.id,
          email: String(i.email),
          createdAt: i.created_at,
        })),
      };
    }),

    /** Add a teammate by email. They join the next time they sign in. */
    invite: userProcedure
      .input(z.object({ email: z.string().email() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        const userId = ctx.user.id as UserId;
        await requireWriteAccess(teamId, userId);

        const result = await TeamInviteService.addInvite({
          teamId,
          email: input.email,
          invitedBy: userId,
        });

        switch (result.status) {
          case 'created':
            return { invited: true as const };
          case 'already_member':
            throw new Error('That email is already a member of this team.');
          case 'already_invited':
            throw new Error('That email is already invited.');
          default:
            return neverAsAny(result);
        }
      }),

    /** Withdraw a pending invite. */
    revokeInvite: userProcedure
      .input(z.object({ inviteId: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        await requireWriteAccess(teamId, ctx.user.id as UserId);
        await TeamInviteService.revokeInvite({
          teamId,
          inviteId: input.inviteId as TeamInviteId,
        });
        return { revoked: true as const };
      }),

    /** Remove a member: their membership ends and their sessions die with it. */
    remove: userProcedure
      .input(z.object({ userId: z.string() }))
      .mutation(async ({ input }) => {
        const ctx = currentContext();
        const teamId = ctx.user.teamId as TeamId;
        await requireWriteAccess(teamId, ctx.user.id as UserId);

        const result = await TeamMembershipService.removeMember({
          teamId,
          userId: input.userId as UserId,
        });

        switch (result.status) {
          case 'removed':
            return { removed: true as const, signedOut: result.signedOut };
          case 'not_a_member':
            throw new Error('That person is not a member of this team.');
          case 'last_admin':
            throw new Error(
              'This is the team’s last admin — add another admin before removing this one.',
            );
          default:
            return neverAsAny(result);
        }
      }),
  });
};

export { teamMembersRouter };
