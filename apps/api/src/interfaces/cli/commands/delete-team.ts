import { Command, command, metadata, option, Options } from 'clime';

import { connect } from '../../../services/team_migration/bundle';
import { deleteTeam } from '../../../services/team_migration/delete';
import { getEnvVar } from '../../../lib/utils/environment';

class DeleteTeamOptions extends Options {
  @option({ description: 'Team id to delete', required: true })
  team!: string;

  @option({
    description: 'Actually delete. Without this the command only reports what would go.',
    toggle: true,
  })
  confirm = false;

  @option({ description: 'Database to delete from; defaults to DATABASE_URL' })
  databaseUrl?: string;
}

/**
 * The other half of being able to leave.
 *
 * Dry-run is the default because this is the one command in the trio that
 * cannot be undone; `--confirm` is the whole opt-in, and the dry run prints the
 * exact table order and row counts the real run will use.
 */
@command({ description: 'Delete one team and everything belonging to it' })
export default class extends Command {
  @metadata
  async execute(options: DeleteTeamOptions): Promise<void> {
    const client = await connect(options.databaseUrl ?? getEnvVar('DATABASE_URL'));
    try {
      const result = await deleteTeam(client, {
        teamId: options.team,
        confirm: options.confirm,
      });
      const rowsOf = result.deleted ?? result.plan;
      const total = rowsOf.reduce((sum, t) => sum + t.rows, 0);
      console.warn(
        `${result.deleted ? 'Deleted' : 'Would delete'} team ${options.team}` +
          `${result.teamName ? ` (${result.teamName})` : ''} — ${total} rows across ${rowsOf.length} tables:`,
      );
      for (const t of rowsOf) console.warn(`  ${t.table}: ${t.rows}`);
      if (result.deleted) {
        const planned = result.plan.reduce((sum, t) => sum + t.rows, 0);
        if (planned !== total) {
          // Not a discrepancy to explain away: ON DELETE CASCADE takes children
          // with their parent, so rows the plan counted are already gone by the
          // time their own statement runs. Both numbers are true.
          console.warn(
            `(${planned - total} of the ${planned} planned rows were already gone when their turn came — ON DELETE CASCADE took them with their parent.)`,
          );
        }
      }
      if (result.skipped.length > 0) {
        console.warn(`Left alone (${result.skipped.length}):`);
        for (const s of result.skipped) console.warn(`  ${s.table}: ${s.because}`);
      }
      if (!result.deleted) console.warn('Dry run — pass --confirm to delete.');
    } finally {
      await client.end();
    }
  }
}
