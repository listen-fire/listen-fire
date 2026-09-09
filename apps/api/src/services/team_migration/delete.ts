import type { Client } from 'pg';

import {
  TEAM_PARAM,
  assertManifestCovers,
  paramsFor,
  qualify,
  quoteIdent,
  readColumns,
  readForeignKeys,
  readTables,
  splitQualified,
  tenancyPredicate,
  topologicalOrder,
} from './catalog';
import { MANIFEST, PRODUCTS, qualified, type Product, type TableSpec } from './manifest';

export type DeleteOptions = {
  teamId: string;
  /** Nothing is written unless this is true. */
  confirm: boolean;
};

export type DeletePlanEntry = { table: string; rows: number };

export type DeleteResult = {
  teamName: string | null;
  /** In the order the deletion runs. */
  plan: DeletePlanEntry[];
  skipped: Array<{ table: string; because: string }>;
  deleted: DeletePlanEntry[] | null;
};

/**
 * The residual, discovered rather than listed.
 *
 * `public` is what is left after the five units — the wallet, the ledger, the
 * usage and ops tables, the dealflow remains (D36). It is never exported, but a
 * tenant purge has to reach it or an offboarding leaves the team's billing and
 * usage history behind. It is DISCOVERED (any `public` table carrying a
 * `team_id`) rather than enumerated, because the residual is the part of the
 * schema still moving, and a hand-written list is exactly the thing that goes
 * quietly stale between now and wind-down.
 */
async function residualTables(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT 'public.' || c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE c.relkind = 'r' AND n.nspname = 'public'
        AND a.attname = 'team_id' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY 1`,
  );
  return rows.map((r) => r.name);
}

function unitPredicate(name: string): string {
  return tenancyPredicate(name, 't', { forDelete: true });
}

/**
 * Deletes a team, everywhere.
 *
 * Two things make this work where a bare `DELETE FROM core.team` does not.
 * First, ORDER: the foreign-key graph is read from the catalog and reversed, so
 * children go before parents and the schema's RESTRICT constraints are
 * satisfied rather than fought. Second, REACH: the units' `team_id` columns
 * carry no foreign key at all (D3), so the database would happily delete the
 * team row and silently orphan every one of its rows in four other schemas —
 * the manifest is what says where they are.
 *
 * The constraints stay LIVE throughout, deliberately. The delete is the proof
 * that the order is right; disabling triggers to make it pass would delete the
 * evidence along with the rows.
 */
export async function deleteTeam(client: Client, options: DeleteOptions): Promise<DeleteResult> {
  const { teamId, confirm } = options;

  const products: Product[] = [...PRODUCTS];
  const present = await readTables(client, products);
  assertManifestCovers(products, present);

  const teamRow = await client.query<{ name: string }>(
    `SELECT name FROM core.team WHERE id = $1`,
    [teamId],
  );
  if (teamRow.rowCount === 0) throw new Error(`No team ${teamId} in core.team`);

  const skipped: Array<{ table: string; because: string }> = [];
  const unitSpecs = new Map<string, TableSpec>();
  for (const product of products) {
    for (const spec of MANIFEST[product]) {
      const name = qualified(product, spec);
      if (spec.outOfScopeBecause) {
        skipped.push({ table: name, because: spec.outOfScopeBecause });
        continue;
      }
      if (spec.tenancy.kind === 'global') {
        // Reference data belongs to the DEPLOYMENT, not to any tenant. An
        // export copies it forward because the target has none; a delete must
        // not touch it, or offboarding one team would take the FX table with
        // it — which is exactly what a `WHERE TRUE` predicate would have done.
        skipped.push({
          table: name,
          because: 'deployment-wide reference data — shared by every team, owned by none',
        });
        continue;
      }
      unitSpecs.set(name, spec);
    }
  }

  const residual = await residualTables(client);
  const allTables = [...unitSpecs.keys(), ...residual];

  // Children before parents.
  const fks = await readForeignKeys(client, [...products, 'public']);
  const order = topologicalOrder(allTables, fks).reverse();

  const columnsBySchema = await readColumns(client, [...products, 'public']);
  const predicateFor = (name: string): string =>
    residual.includes(name)
      ? // The residual has no manifest entry and needs none: a `public` table
        // that carries a team_id says what its tenancy is by carrying it.
        `t."team_id" = ${TEAM_PARAM}`
      : unitPredicate(name);

  const hasId = (name: string): boolean =>
    (columnsBySchema.get(name) ?? []).some((c) => c.name === 'id');

  // MATERIALISE FIRST, delete second — the ordering trap this tool exists to
  // avoid. Several predicates are expressed THROUGH `core.team_membership`
  // (who a user is, whose phone this is), and reverse-dependency order deletes
  // memberships before users; re-evaluating those predicates mid-run would
  // find nothing and silently leave the people behind. So every keyed table's
  // rows are identified while the graph is still whole, and the deletion runs
  // against those ids. Keyless tables (three, all CASCADE children of a keyed
  // parent) keep the live predicate — their parents are still present when
  // their turn comes.
  const keys = new Map<string, string[]>();
  const plan: DeletePlanEntry[] = [];
  for (const name of [...order].reverse()) {
    const { schema, table } = splitQualified(name);
    if (!residual.includes(name) && (columnsBySchema.get(name) ?? []).length === 0) continue;
    if (hasId(name)) {
      const { rows } = await client.query<{ id: string }>(
        `SELECT t."id"::text AS id FROM ${qualify(schema, table)} t WHERE ${predicateFor(name)}`,
        paramsFor(predicateFor(name), teamId),
      );
      if (rows.length > 0) {
        keys.set(name, rows.map((r) => r.id));
        plan.push({ table: name, rows: rows.length });
      }
    } else {
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${qualify(schema, table)} t WHERE ${predicateFor(name)}`,
        paramsFor(predicateFor(name), teamId),
      );
      const count = Number(rows[0].count);
      if (count > 0) plan.push({ table: name, rows: count });
    }
  }
  // Report in the order the deletion will run.
  plan.sort((a, b) => order.indexOf(a.table) - order.indexOf(b.table));

  if (!confirm) {
    return { teamName: teamRow.rows[0]?.name ?? null, plan, skipped, deleted: null };
  }

  const deleted: DeletePlanEntry[] = [];
  await client.query('BEGIN');
  try {
    for (const name of order) {
      const { schema, table } = splitQualified(name);
      if (!residual.includes(name) && (columnsBySchema.get(name) ?? []).length === 0) continue;
      const result = hasId(name)
        ? await client.query(
            `DELETE FROM ${qualify(schema, table)} t WHERE t."id"::text = ANY($1::text[])`,
            [keys.get(name) ?? []],
          )
        : await client.query(
            `DELETE FROM ${qualify(schema, table)} t WHERE ${predicateFor(name)}`,
            paramsFor(predicateFor(name), teamId),
          );
      if ((result.rowCount ?? 0) > 0) deleted.push({ table: name, rows: result.rowCount ?? 0 });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  return { teamName: teamRow.rows[0]?.name ?? null, plan, skipped, deleted };
}

export { quoteIdent };
