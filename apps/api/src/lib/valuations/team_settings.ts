import { getValuationsQb } from '../kysely';
import { LegalEntityId } from '../../generated/kysely/valuations/LegalEntity';

/**
 * The per-team investing-profile pointers (D6/V-6). They used to sit on core's
 * `team` — which entity IS this team, and which of its funds a new investment
 * defaults to — but the semantics are valuations', and a self-hoster running
 * this unit alone still needs them.
 */
type TeamSettings = {
  ownEntityId: LegalEntityId | null;
  defaultInvestingEntityId: LegalEntityId | null;
};

const EMPTY: TeamSettings = { ownEntityId: null, defaultInvestingEntityId: null };

async function getTeamSettings(teamId: string): Promise<TeamSettings> {
  const row = await getValuationsQb(['team_settings'])
    .selectFrom('team_settings')
    .select(['own_entity_id', 'default_investing_entity_id'])
    .where('team_id', '=', teamId)
    .executeTakeFirst();

  if (!row) return EMPTY;

  return {
    ownEntityId: row.own_entity_id,
    defaultInvestingEntityId: row.default_investing_entity_id,
  };
}

/**
 * Called by the legal-entity merge sweeper: both pointers follow the surviving
 * entity. The FKs are in-schema now, so this is a plain update rather than the
 * two `team.updateMany` calls it replaces.
 */
async function repointTeamEntities(sourceId: string, targetId: string) {
  const qb = getValuationsQb(['team_settings']);

  await qb
    .updateTable('team_settings')
    .set({ own_entity_id: targetId as LegalEntityId })
    .where('own_entity_id', '=', sourceId as LegalEntityId)
    .execute();

  await qb
    .updateTable('team_settings')
    .set({ default_investing_entity_id: targetId as LegalEntityId })
    .where('default_investing_entity_id', '=', sourceId as LegalEntityId)
    .execute();
}

export { getTeamSettings, repointTeamEntities };
export type { TeamSettings };
