import { Command, command, metadata, option, Options } from 'clime';

import { connect } from '../../../services/team_migration/bundle';
import { exportTeam } from '../../../services/team_migration/export';
import { isProduct, PRODUCTS, type Product } from '../../../services/team_migration/manifest';
import { getEnvVar } from '../../../lib/utils/environment';

class ExportTeamOptions extends Options {
  @option({ description: 'Team id to export', required: true })
  team!: string;

  @option({
    description: `Comma-separated products to export (${PRODUCTS.join(', ')}); default all`,
  })
  products?: string;

  @option({ flag: 'o', description: 'Directory to write the bundle into', required: true })
  out!: string;

  @option({
    description:
      'Omit run/message/delivery history (doc 10 §2d recommends leaving it behind)',
    toggle: true,
  })
  withoutHistory = false;

  @option({ description: 'Database to read from; defaults to DATABASE_URL' })
  databaseUrl?: string;
}

/**
 * A tenant's data, as files, per product.
 *
 * The tool is deliberately independent of the application it exports: it takes
 * a database URL and talks to Postgres, so it works against a deployment whose
 * app cannot boot — which is exactly the situation an offboarding tends to
 * find.
 */
@command({ description: "Export one team's data as a portable bundle" })
export default class extends Command {
  @metadata
  async execute(options: ExportTeamOptions): Promise<void> {
    const products: Product[] = options.products
      ? options.products.split(',').map((p) => p.trim()).filter((p) => p.length > 0).map((p) => {
          if (!isProduct(p)) throw new Error(`Unknown product '${p}' — known: ${PRODUCTS.join(', ')}`);
          return p;
        })
      : [...PRODUCTS];

    const client = await connect(options.databaseUrl ?? getEnvVar('DATABASE_URL'));
    try {
      const { manifest } = await exportTeam(client, {
        teamId: options.team,
        products,
        outDir: options.out,
        withHistory: !options.withoutHistory,
      });

      const total = manifest.tables.reduce((sum, t) => sum + t.rows, 0);
      console.warn(
        `Exported team ${manifest.teamId}${manifest.teamName ? ` (${manifest.teamName})` : ''} ` +
          `— ${total} rows across ${manifest.tables.length} tables, at ${manifest.migrationHead}`,
      );
      for (const t of manifest.tables.filter((t) => t.rows > 0)) {
        console.warn(`  ${t.table}: ${t.rows}`);
      }
      if (manifest.declined.length > 0) {
        console.warn(`Not carried (${manifest.declined.length}):`);
        for (const d of manifest.declined) console.warn(`  ${d.table}: ${d.because}`);
      }
      console.warn(`Bundle written to ${options.out}`);
    } finally {
      await client.end();
    }
  }
}
