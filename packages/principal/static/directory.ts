// The static Directory (D16/D28): the same team-scoped contract core implements
// from `user`/`user_email`/`team_membership`, answered from config instead.
// Scoping is enforced here rather than assumed, so a product built against the
// stub cannot pass a foreign team id and get an answer it would not get from
// core.

import type { Directory, DirectoryTeamAssociation, DirectoryUser } from '../directory';
import type { StaticDirectoryConfig } from './config';

function createStaticDirectory(config: StaticDirectoryConfig): Directory {
  const inTeam = (teamId: string): boolean => teamId === config.team.id;

  const find = (predicate: (user: DirectoryUser) => boolean): DirectoryUser | null =>
    config.users.find(predicate) ?? null;

  return {
    async userById({ id, teamId }): Promise<DirectoryUser | null> {
      return inTeam(teamId) ? find((user) => user.id === id) : null;
    },

    async userByEmail({ email, teamId }): Promise<DirectoryUser | null> {
      if (!inTeam(teamId)) return null;
      const wanted = email.trim().toLowerCase();
      return find((user) => user.email?.toLowerCase() === wanted);
    },

    async members(teamId): Promise<DirectoryUser[]> {
      return inTeam(teamId) ? [...config.users] : [];
    },

    async team(id): Promise<{ id: string; name: string } | null> {
      return inTeam(id) ? { ...config.team } : null;
    },

    async teamsForEmail(email): Promise<DirectoryTeamAssociation[]> {
      // Single-tenant by construction: the one association a configured user
      // can have is the one team. The access flag is deliberately not applied
      // — this lookup reports ties, and the caller decides who may act.
      const wanted = email.trim().toLowerCase();
      return config.users
        .filter((user) => user.email?.toLowerCase() === wanted)
        .map((user) => ({ teamId: config.team.id, userId: user.id }));
    },
  };
}

export { createStaticDirectory };
