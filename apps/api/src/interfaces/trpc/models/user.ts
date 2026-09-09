import { sql } from 'kysely';

import { LegalEntityId } from '../../../generated/kysely/valuations/LegalEntity';
import { trpc } from '../trpc';
import { currentContext } from '../../../services/context';
import { getQb, jsonbAgg, jsonbBuildObject } from '../../../lib/kysely';
import { UserId } from '../../../generated/kysely/core/User';

type User = {
  id: string;
  email: string;
  secondaryEmails: Array<string>;
  phoneNumber?: string | null;
  username: string;
  isPlatformAdmin: boolean;
  hasAccess: boolean;
  hasCompletedRegistration: boolean;
  defaultTeam: {
    id: string;
    name: string;
    members: Array<{
      id: string;
      email: string;
      username: string;
      publicProfile?: { __typename?: 'Profile'; id: string; imageUrl?: string | null } | null;
      readonly: boolean;
      isHomeTeam: boolean;
    }>;
  };
  teams: Array<{
    id: string;
    name: string;
    members: Array<{
      id: string;
      email: string;
      username: string;
      publicProfile?: { __typename?: 'Profile'; id: string; imageUrl?: string | null } | null;
      readonly: boolean;
      isHomeTeam: boolean;
    }>;
  }>;
  permission: {
    readonly: boolean;
    readonlyByTeam: Array<{
      __typename?: 'ReadonlyByTeam';
      id: string;
      teamId: string;
      readonly: boolean;
    }>;
  };
  publicProfile?: {
    id: string;
    fullname: string;
    imageUrl?: string | null;
    description: string;
    linkedin?: string | null;
    descriptorsGeo: Array<string>;
    descriptorsInvestorType: Array<string>;
    descriptorsStage: Array<string>;
    descriptorsMiscTags: Array<string>;
    slug?: string | null;
    roles: Array<{
      id: string;
      description?: string | null;
      entityProfile?: {
        __typename?: 'Profile';
        id: string;
        fullname: string;
        slug?: string | null;
      } | null;
    }>;
  } | null;
};

const userRouter = (procedure: typeof trpc.procedure) => {
  return trpc.router({
    context: procedure.query(async (): Promise<User> => {
      const ctx = currentContext();

      const query = getQb([
        'core.user',
        'core.user_email',
        'valuations.legal_entity',
        'profile_role',
        'core.team',
        'core.team_membership',
        'automations.phone_number',
      ])
        .selectFrom('core.user as u')
        .select(($) => [
          'u.id',
          $.selectFrom('core.user_email as primary')
            .select('primary.email')
            .where('primary.user_id', '=', $.ref('u.id'))
            .where('primary.is_primary', '=', true)
            .limit(1)
            .as('email'),
          $.selectFrom('core.user_email as secondary')
            .select(($) => $.fn.agg<string[]>('ARRAY_AGG', ['secondary.email']).as('emails'))
            .where('secondary.user_id', '=', $.ref('u.id'))
            .where('secondary.is_primary', '=', false)
            .as('secondaryEmails'),
          $.selectFrom('automations.phone_number as upn')
            .select('upn.phone_number')
            .where('upn.user_id', '=', $.ref('u.id'))
            .limit(1)
            .as('phoneNumber'),
          'u.username',
          'u.is_platform_admin as isPlatformAdmin',
          $('u.granted_access_at', 'is not', null).as('hasAccess'),
          $('u.completed_registration_at', 'is not', null).as('hasCompletedRegistration'),
          $.selectFrom('core.team as team')
            .select(($) =>
              jsonbBuildObject($, {
                id: 'team.id',
                name: 'team.name',
                members: $.selectFrom('core.user as user')
                  .innerJoin('core.user_email as user_email', 'user_email.user_id', 'user.id')
                  .innerJoinLateral(
                    ($) =>
                      $.selectFrom('core.team_membership as team_membership')
                        .select(($) => [
                          'team_membership.user_id',
                          $('team_membership.access', '=', 'read').$castTo<boolean>().as('readonly'),
                        ])
                        .where('team_membership.team_id', '=', $.ref('team.id'))
                        .where('team_membership.user_id', '=', $.ref('user.id'))
                        .as('r'),
                    (join) => join.onTrue(),
                  )
                  .select(($) =>
                    jsonbAgg($, {
                      id: 'user.id',
                      email: 'user_email.email',
                      username: 'user.username',
                      publicProfile: $.selectFrom('valuations.legal_entity as legal_entity')
                        .select(($) =>
                          jsonbBuildObject($, {
                            id: 'legal_entity.id',
                            imageUrl: 'legal_entity.image_url',
                          }).as('publicProfile'),
                        )
                        .where('legal_entity.id', '=', $.ref('user.public_profile_id').$castTo<LegalEntityId>()),
                      isHomeTeam: $('team.id', '=', $.ref('user.default_team_id')).$castTo<boolean>(),
                      readonly: 'r.readonly',
                    }).as('users'),
                  ),
              }).as('defaultTeam'),
            )
            .where('team.id', '=', $.ref('u.default_team_id'))
            .as('defaultTeam'),
          $.selectFrom('core.team as t')
            .select(($) =>
              jsonbAgg($, {
                id: 't.id',
                name: 't.name',
                members: $.selectFrom('core.user as user')
                  .innerJoin('core.user_email as user_email', 'user_email.user_id', 'user.id')
                  .innerJoinLateral(
                    ($) =>
                      $.selectFrom('core.team_membership as team_membership')
                        .select(($) => [
                          'team_membership.user_id',
                          $('team_membership.access', '=', 'read').$castTo<boolean>().as('readonly'),
                        ])
                        .where('team_membership.team_id', '=', $.ref('t.id'))
                        .where('team_membership.user_id', '=', $.ref('user.id'))
                        .as('r'),
                    (join) => join.onTrue(),
                  )
                  .select(($) =>
                    jsonbAgg($, {
                      id: 'user.id',
                      email: 'user_email.email',
                      username: 'user.username',
                      publicProfile: $.selectFrom('valuations.legal_entity as legal_entity')
                        .select(($) =>
                          jsonbBuildObject($, {
                            id: 'legal_entity.id',
                            imageUrl: 'legal_entity.image_url',
                          }).as('publicProfile'),
                        )
                        .where('legal_entity.id', '=', $.ref('user.public_profile_id').$castTo<LegalEntityId>()),
                      isHomeTeam: $('t.id', '=', $.ref('user.default_team_id')).$castTo<boolean>(),
                      readonly: 'r.readonly',
                    }).as('users'),
                  )
                  .where('user_email.is_primary', '=', true),
              }).as('teams'),
            )
            .where(($) =>
              $.exists(
                $.selectFrom('core.team_membership as tm')
                  .where('tm.user_id', '=', $.ref('u.id'))
                  .where('tm.team_id', '=', $.ref('t.id')),
              ),
            )
            .as('teams'),
          $.selectFrom('core.team_membership as tm')
            .where('tm.user_id', '=', $.ref('u.id'))
            .select(($) =>
              jsonbAgg($, {
                id: 'tm.id',
                teamId: 'tm.team_id',
                readonly: $('tm.access', '=', 'read').$castTo<boolean>(),
              }).as('permission'),
            )
            .as('permission'),
          $.selectFrom('valuations.legal_entity as le')
            .select(($) =>
              jsonbBuildObject($, {
                id: 'le.id',
                fullname: 'le.name',
                imageUrl: 'le.image_url',
                description: 'le.description',
                linkedin: 'le.linkedin',
                descriptorsGeo: 'le.descriptors_geo',
                descriptorsInvestorType: 'le.descriptors_investor_type',
                descriptorsStage: 'le.descriptors_stage',
                descriptorsMiscTags: 'le.descriptors_misc_tags',
                slug: 'le.slug',
                roles: $.selectFrom('profile_role as pr')
                  .innerJoin('valuations.legal_entity as entity', 'pr.entity_id', 'entity.id')
                  .where('pr.profile_id', '=', $.ref('le.id'))
                  .select(($) =>
                    jsonbAgg($, {
                      id: 'pr.id',
                      description: 'pr.description',
                      entityProfile: jsonbBuildObject($, {
                        id: 'entity.id',
                        fullname: 'entity.name',
                        slug: 'entity.slug',
                      }),
                    }).as('roles'),
                  ),
              }).as('publicProfile'),
            )
            .where('le.id', '=', $.ref('u.public_profile_id').$castTo<LegalEntityId>())
            .groupBy('le.id')
            .as('publicProfile'),
        ])
        .where('u.id', '=', ctx.user.id as UserId)
        .groupBy('u.id');

      const user = await query.executeTakeFirstOrThrow();

      if (!user.email) {
        throw new Error('User has no email');
      }
      const email = user.email;

      if (!user.defaultTeam) {
        throw new Error('User has no default team');
      }
      const defaultTeam = {
        ...user.defaultTeam,
        members: user.defaultTeam.members ?? [],
      };

      const teams =
        user.teams?.map((team) => ({
          ...team,
          members: team.members ?? [],
        })) ?? [];

      return {
        ...user,
        email,
        secondaryEmails: user.secondaryEmails ?? [],
        hasAccess: !!user.hasAccess,
        hasCompletedRegistration: !!user.hasCompletedRegistration,
        defaultTeam,
        teams,
        publicProfile: user.publicProfile
          ? {
              ...user.publicProfile,
              descriptorsGeo: user.publicProfile.descriptorsGeo ?? [],
              descriptorsInvestorType: user.publicProfile.descriptorsInvestorType ?? [],
              descriptorsStage: user.publicProfile.descriptorsStage ?? [],
              descriptorsMiscTags: user.publicProfile.descriptorsMiscTags ?? [],
              description: user.publicProfile.description ?? '',
              roles: user.publicProfile.roles ?? [],
            }
          : undefined,
        permission: {
          readonly: !!(
            user.permission?.find((p) => p.teamId === ctx.user.teamId)?.readonly ?? true
          ),
          readonlyByTeam: user.permission ?? [],
        },
      };
    }),
  });
};

export { userRouter };
