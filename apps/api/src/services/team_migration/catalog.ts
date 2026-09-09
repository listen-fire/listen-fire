import type { Client } from 'pg';

import {
  MANIFEST,
  PRODUCTS,
  qualified,
  type Product,
  type TableSpec,
  type Tenancy,
} from './manifest';

/**
 * Everything the DATABASE knows about a migration, asked for rather than
 * restated: which columns a table has and of what type, which table must be
 * written before which, and which migration the schema is at.
 *
 * The split with `manifest.ts` is the design: a declaration is only made by
 * hand where Postgres has no opinion. That is why adding a table to a unit
 * schema changes the ordering here automatically and fails the completeness
 * check there loudly.
 */

export type ColumnInfo = { name: string; type: string };

export type TableInfo = {
  schema: string;
  table: string;
  columns: ColumnInfo[];
};

/**
 * The team id, always `$1`, always cast. Postgres infers an untyped parameter
 * as text, which does not compare to a uuid column — so the cast is written
 * once here rather than remembered at every predicate.
 */
export const TEAM_PARAM = '$1::uuid';

/**
 * The team id is bound only when the predicate actually mentions it — a
 * `global` table's slice does not depend on which tenant is being exported, and
 * binding a parameter the statement never names is an error, not a no-op.
 */
export function paramsFor(sql: string, teamId: string): string[] {
  return sql.includes('$1') ? [teamId] : [];
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualify(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

export function splitQualified(name: string): { schema: string; table: string } {
  const [schema, table] = name.split('.');
  if (!schema || !table) throw new Error(`Not a schema-qualified table name: ${name}`);
  return { schema, table };
}

/**
 * Columns in ordinal order, with the type name a text value casts back to.
 *
 * GENERATED columns are excluded, because they are not data: Postgres computes
 * them from the row and refuses an explicit value. Dropping them here rather
 * than at each call site means the export never writes one and the import never
 * tries to insert one — the target recomputes all four (the knowledge search
 * vectors) from the rows it receives.
 */
export async function readColumns(
  client: Client,
  schemas: string[],
): Promise<Map<string, ColumnInfo[]>> {
  const { rows } = await client.query<{ schema: string; table: string; name: string; type: string }>(
    `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attgenerated = ''
        AND n.nspname = ANY($1)
      ORDER BY n.nspname, c.relname, a.attnum`,
    [schemas],
  );
  const out = new Map<string, ColumnInfo[]>();
  for (const row of rows) {
    const key = `${row.schema}.${row.table}`;
    const list = out.get(key) ?? [];
    list.push({ name: row.name, type: row.type });
    out.set(key, list);
  }
  return out;
}

/** Every base table in the given schemas. */
export async function readTables(client: Client, schemas: string[]): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = ANY($1)
      ORDER BY 1`,
    [schemas],
  );
  return rows.map((r) => r.name);
}

/**
 * child → parents for the foreign keys that actually CONSTRAIN a deletion
 * order, which is far fewer than "the foreign keys".
 *
 * A CASCADE edge imposes no ordering — deleting the parent takes the child
 * with it. Nor does SET NULL. Only RESTRICT and NO ACTION require the child to
 * go first, so those are the only edges read. Filtering to them is not an
 * optimisation: the full graph contains real cycles (a movement points at its
 * current version and the version points back at its movement; a team points
 * at its default user and the user at their default team), and a tool that
 * tried to topologically sort all of them would refuse to run on a schema that
 * is perfectly deleteable.
 *
 * Self-references are dropped; they cannot constrain an order between tables.
 */
export async function readForeignKeys(
  client: Client,
  schemas: string[],
): Promise<Map<string, Set<string>>> {
  const { rows } = await client.query<{ child: string; parent: string }>(
    `SELECT cn.nspname || '.' || c.relname AS child,
            pn.nspname || '.' || p.relname AS parent
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace cn ON cn.oid = c.relnamespace
       JOIN pg_class p ON p.oid = con.confrelid
       JOIN pg_namespace pn ON pn.oid = p.relnamespace
      WHERE con.contype = 'f' AND con.confdeltype IN ('r', 'a')
        AND cn.nspname = ANY($1) AND pn.nspname = ANY($1)`,
    [schemas],
  );
  const out = new Map<string, Set<string>>();
  for (const { child, parent } of rows) {
    if (child === parent) continue;
    const set = out.get(child) ?? new Set<string>();
    set.add(parent);
    out.set(child, set);
  }
  return out;
}

/**
 * Parents before children. Ties are broken by name so two runs of the tool
 * produce the same order — the bundle's byte-identity depends on it.
 *
 * A cycle would mean two tables that cannot be written in any order without
 * deferred constraints; it throws rather than picking arbitrarily, because a
 * cycle is a schema finding and not something a migration tool should absorb.
 */
export function topologicalOrder(tables: string[], fks: Map<string, Set<string>>): string[] {
  const remaining = new Set(tables);
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((t) => [...(fks.get(t) ?? [])].every((p) => !remaining.has(p)))
      .sort();
    if (ready.length === 0) {
      throw new Error(
        `Foreign-key cycle among: ${[...remaining].sort().join(', ')} — no write order exists`,
      );
    }
    for (const t of ready) {
      ordered.push(t);
      remaining.delete(t);
    }
  }
  return ordered;
}

/** The migration the schema is at: the last row the runner recorded. */
export async function readMigrationHead(client: Client): Promise<string> {
  const { rows } = await client.query<{ version: string }>(
    `SELECT version FROM _migrations.migrations ORDER BY id DESC LIMIT 1`,
  );
  if (rows.length === 0) throw new Error('No migrations recorded — is this an Listen-Fire database?');
  return rows[0].version;
}

/**
 * Refuses when a unit schema holds a table the manifest has no ruling on.
 *
 * This is the check that keeps the file honest as the schema moves: a new
 * table cannot join a product without someone deciding what it means to a
 * tenant, and the failure arrives at the top of a migration rather than as a
 * silently missing slice at the bottom of one.
 */
export function assertManifestCovers(products: Product[], present: string[]): void {
  const declared = new Set(
    PRODUCTS.flatMap((p) => MANIFEST[p].map((spec) => qualified(p, spec))),
  );
  const scoped = present.filter((t) => products.includes(splitQualified(t).schema as Product));
  const missing = scoped.filter((t) => !declared.has(t));
  if (missing.length > 0) {
    throw new Error(
      `The team-migration manifest has no ruling for: ${missing.sort().join(', ')}. ` +
        `Add each to apps/api/src/services/team_migration/manifest.ts with its tenancy, ` +
        `or with the reason it is not tenant data.`,
    );
  }
}

function specFor(qualifiedName: string): { product: Product; spec: TableSpec } {
  const { schema, table } = splitQualified(qualifiedName);
  const product = schema as Product;
  const spec = MANIFEST[product]?.find((s) => s.table === table);
  if (!spec) throw new Error(`No manifest entry for ${qualifiedName}`);
  return { product, spec };
}

/**
 * The SQL that selects a team's rows of one table, as a predicate over `alias`.
 *
 * `$1` is the team id, everywhere and only. A `via` hop substitutes the
 * parent's own predicate into a subquery, so the chain from a phone to the
 * membership that owns it composes out of one-line declarations instead of a
 * hand-written join nobody would re-derive when the shape moves.
 */
export function tenancyPredicate(
  qualifiedName: string,
  alias: string,
  options: { forDelete?: boolean; depth?: number } = {},
): string {
  const { forDelete = false, depth = 0 } = options;
  const { spec } = specFor(qualifiedName);
  const base = predicateForTenancy(spec.tenancy, alias, depth, forDelete);
  if (!forDelete || !spec.deleteOnlyWhere) return base;
  return `${base} AND ${spec.deleteOnlyWhere.sql.replace(/\{alias\}/g, quoteIdent(alias))}`;
}

function predicateForTenancy(
  tenancy: Tenancy,
  alias: string,
  depth: number,
  forDelete: boolean,
): string {
  const a = quoteIdent(alias);
  switch (tenancy.kind) {
    case 'team_root':
      return `${a}."id" = ${TEAM_PARAM}`;
    case 'team_column':
      // `alsoGlobalRows` is an EXPORT rule, never a delete rule: the shared
      // rows are the deployment's, so carrying a copy forward is right and
      // deleting the originals with one tenant would be catastrophic.
      return tenancy.alsoGlobalRows && !forDelete
        ? `(${a}."team_id" = ${TEAM_PARAM} OR ${a}."team_id" IS NULL)`
        : `${a}."team_id" = ${TEAM_PARAM}`;
    case 'global':
      return 'TRUE';
    case 'via': {
      const { schema, table } = splitQualified(tenancy.parent);
      const parentAlias = `p${depth}`;
      const inner = tenancyPredicate(tenancy.parent, parentAlias, { forDelete, depth: depth + 1 });
      const parentColumn = tenancy.parentColumn ?? 'id';
      return (
        `${a}.${quoteIdent(tenancy.column)} IN (` +
        `SELECT ${quoteIdent(parentAlias)}.${quoteIdent(parentColumn)} ` +
        `FROM ${qualify(schema, table)} ${quoteIdent(parentAlias)} WHERE ${inner})`
      );
    }
    default: {
      const exhaustive: never = tenancy;
      throw new Error(`Unhandled tenancy: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export { qualify };
