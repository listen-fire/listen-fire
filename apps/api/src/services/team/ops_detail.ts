// How much of a run the ops feed keeps for a team. An automations setting
// (`automations.team_settings`), not an identity fact — no row means the global
// default, so a team gets one the first time an operator turns the dial.

import { getAutomationsQb } from '../../lib/kysely';
import OpsDetailLevel from '../../generated/kysely/automations/OpsDetailLevel';

export const GLOBAL_DEFAULT_OPS_DETAIL_LEVEL: OpsDetailLevel = OpsDetailLevel.low;

export async function getTeamDetailLevel(teamId: string | null): Promise<OpsDetailLevel> {
  if (!teamId) return GLOBAL_DEFAULT_OPS_DETAIL_LEVEL;
  const row = await getAutomationsQb(['team_settings'])
    .selectFrom('team_settings')
    .where('team_id', '=', teamId)
    .select('ops_detail_level')
    .executeTakeFirst();
  return row?.ops_detail_level ?? GLOBAL_DEFAULT_OPS_DETAIL_LEVEL;
}

export async function setTeamDetailLevel(teamId: string, level: OpsDetailLevel): Promise<void> {
  await getAutomationsQb(['team_settings'])
    .insertInto('team_settings')
    .values({ team_id: teamId, ops_detail_level: level })
    .onConflict((oc) =>
      oc.column('team_id').doUpdateSet({ ops_detail_level: level, updated_at: new Date() }),
    )
    .execute();
}
