import * as db from '@prisma/client';

import { ModelService } from '../utils';

/**
 * The by-name reads and the create below are BOOTSTRAP surface, and their lack
 * of a tenant scope is the design rather than an omission: `initialise-user`
 * asks "is there already a team called this?" before any tenant exists to scope
 * the question to, and answers by minting one. Its only caller runs under
 * `adminAbilities()`, so CASL never filtered these either — deleting the layer
 * leaves them exactly as wide as they are today.
 *
 * Reading a team by id is a different question and has a different answer: it
 * goes through `getById` → the generic loader → `TENANT_SCOPES.team`, which
 * pins it to the acting team explicitly.
 */
class Team extends ModelService<'team'> {
  protected readonly objectName = 'team';

  async create({ name }: { name: string }): Promise<db.Team> {
    return this.model.create({ data: { name } });
  }

  async getFirstByName(name: string): Promise<db.Team> {
    return this.model.findFirstOrThrow({ where: { name } });
  }

  async findFirstByName(name: string): Promise<db.Team | null> {
    return this.model.findFirst({ where: { name } });
  }

  async getFirstByNameOrCreate(name: string): Promise<db.Team> {
    try {
      return await this.getFirstByName(name);
    } catch {
      return await this.create({ name });
    }
  }

  // `updateTeamName` was DELETED here rather than scoped. It renamed a team by
  // id with no tenant condition, and it had zero callers anywhere in the repo.
  // Under CASL that was harmless — the ability grants only READ on `Team`, so
  // the write could never have succeeded for a member — but the layer was the
  // only thing saying so. Carried forward unconverted it would have become a
  // silent cross-tenant rename the moment the ability stopped answering. This
  // is D45's addendum rule applied literally: unreachable-but-unprincipled code
  // dies in the chunk that touches it.
}

const TeamService = new Team();

export { TeamService };
