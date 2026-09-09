import type { Client } from 'pg';

import {
  BUNDLE_FORMAT_VERSION,
  TOOL_VERSION,
  sha256,
  writeBundle,
  type BundleManifest,
  type DeclinedEntry,
  type TableEntry,
} from './bundle';
import {
  assertManifestCovers,
  quoteIdent,
  qualify,
  paramsFor,
  readColumns,
  readMigrationHead,
  readTables,
  tenancyPredicate,
} from './catalog';
import { MANIFEST, qualified, type Product, type TableSpec } from './manifest';

export type ExportOptions = {
  teamId: string;
  products: Product[];
  outDir: string;
  withHistory: boolean;
};

export type ExportResult = { manifest: BundleManifest };

/**
 * Which manifest entries this run will actually carry, and what each refusal
 * costs — computed before a single row is read, so the reasons appear at the
 * top of the run rather than as gaps at the bottom of it.
 */
function partition(
  products: Product[],
  withHistory: boolean,
): { carried: Array<{ product: Product; spec: TableSpec }>; declined: DeclinedEntry[] } {
  const carried: Array<{ product: Product; spec: TableSpec }> = [];
  const declined: DeclinedEntry[] = [];
  for (const product of products) {
    for (const spec of MANIFEST[product]) {
      const name = qualified(product, spec);
      if (spec.outOfScopeBecause) {
        declined.push({ table: name, because: spec.outOfScopeBecause });
      } else if (spec.exportExcludedBecause) {
        declined.push({ table: name, because: spec.exportExcludedBecause });
      } else if (spec.requiresProduct && !products.includes(spec.requiresProduct)) {
        // Declined LOUDLY rather than emitted empty: the traversal that says
        // which team these rows belong to leaves this schema, so without that
        // product in the set there is no expression that selects them — an
        // empty slice would read as "the team has none".
        declined.push({
          table: name,
          because: `its tenancy is only expressible through the ${spec.requiresProduct} schema, which is not in this export`,
        });
      } else if (spec.history && !withHistory) {
        declined.push({ table: name, because: 'history, omitted by --without-history' });
      } else {
        carried.push({ product, spec });
      }
    }
  }
  return { carried, declined };
}

/**
 * The SELECT that reads one table's slice.
 *
 * Every column is cast to text so the file carries Postgres's own
 * representation; a `rewrite` replaces the stored value with an expression the
 * export decides on (that is how a credential becomes a shell). The ORDER BY
 * is what makes two runs the same bytes — by `id` where there is one, and by
 * every column where there is not.
 */
function selectFor(schema: string, spec: TableSpec, columns: string[]): string {
  const projected = columns.map((col) => {
    const rewrite = spec.rewrite?.[col];
    const expr = rewrite ? rewrite.replace(/:team\b/g, '$1') : `t.${quoteIdent(col)}`;
    return `(${expr})::text AS ${quoteIdent(col)}`;
  });
  const order = columns.includes('id')
    ? 't."id"::text'
    : columns.map((c) => `t.${quoteIdent(c)}::text`).join(', ');
  return (
    `SELECT ${projected.join(', ')} FROM ${qualify(schema, spec.table)} t ` +
    `WHERE ${tenancyPredicate(`${schema}.${spec.table}`, 't')} ORDER BY ${order}`
  );
}

export async function exportTeam(client: Client, options: ExportOptions): Promise<ExportResult> {
  const { teamId, products, outDir, withHistory } = options;

  const present = await readTables(client, [...products]);
  assertManifestCovers(products, present);

  const teamRow = await client.query<{ name: string }>(
    `SELECT name FROM core.team WHERE id = $1`,
    [teamId],
  );
  if (teamRow.rowCount === 0 && products.includes('core')) {
    throw new Error(`No team ${teamId} in core.team`);
  }

  const migrationHead = await readMigrationHead(client);
  const columnsBySchema = await readColumns(client, [...products]);
  const { carried, declined } = partition(products, withHistory);

  // Manifest declaration order. The IMPORT loads with foreign-key triggers
  // off — the slice came out coherent, so re-checking it row by row buys
  // nothing — which leaves the file order free to be the one a person reading
  // the bundle would want, rather than one derived from a graph that contains
  // legitimate cycles (a movement points at its current version, and back).
  const order = carried.map(({ product, spec }) => qualified(product, spec));
  const byName = new Map(carried.map((c) => [qualified(c.product, c.spec), c]));

  const files = new Map<string, string>();
  const tables: TableEntry[] = [];

  for (const name of order) {
    const entry = byName.get(name);
    if (!entry) continue;
    const { product, spec } = entry;
    const columns = (columnsBySchema.get(name) ?? []).map((c) => c.name);
    if (columns.length === 0) throw new Error(`${name} has no columns — is it a table?`);

    const sql = selectFor(product, spec, columns);
    const { rows } = await client.query<Record<string, string | null>>(
      sql,
      paramsFor(sql, teamId),
    );
    // Arrays, not objects: the column order is stated once in the manifest
    // rather than repeated on every line, and a row cannot silently acquire a
    // key the manifest did not declare.
    const contents = rows
      .map((row) => `${JSON.stringify(columns.map((c) => row[c] ?? null))}\n`)
      .join('');
    const file = `data/${name}.jsonl`;
    files.set(file, contents);
    tables.push({
      table: name,
      columns,
      rows: rows.length,
      sha256: sha256(contents),
      file,
      ...(spec.referenceData ? { referenceData: true as const } : {}),
    });
  }

  const manifest: BundleManifest = {
    formatVersion: BUNDLE_FORMAT_VERSION,
    tool: { name: 'listen-fire-team-migration', version: TOOL_VERSION },
    generatedAt: new Date().toISOString(),
    teamId,
    teamName: teamRow.rows[0]?.name ?? null,
    products: [...products],
    migrationHead,
    withHistory,
    tables,
    declined,
  };

  await writeBundle(outDir, manifest, files);
  return { manifest };
}
