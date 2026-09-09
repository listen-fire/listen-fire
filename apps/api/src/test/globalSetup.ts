// W3-A2 — Real-Postgres integration-test harness, global setup.
//
// Architectural decisions (per the W3-A2 brief):
//
//   1. Dedicated test DB — `DATABASE_URL_TEST` points at a separate
//      Postgres database from the dev-loop. CI / local dev must provision
//      it; we never clobber dev-loop state from tests.
//
//   2. Migrations applied programmatically — globalSetup runs the
//      project's `migrate.sh` script against `DATABASE_URL_TEST`, which
//      executes every migration file in order. The script is idempotent
//      (a `_migrations.migrations` tracking table records applied
//      versions), so re-running globalSetup is a no-op when the test DB
//      is already up to date. This avoids the slower "drop-everything +
//      re-apply" pattern in favour of incremental migration application.
//
//   3. Schema-namespacing for tests — when `NODE_ENV === 'test'` the
//      app's `prisma/index.ts` synthesizes a per-process random schema
//      and appends `?schema=<uuid>` to the connection string. That
//      mechanism is incompatible with our "real knowledge schema + real
//      public schema" requirement, so this harness deliberately runs
//      under `NODE_ENV=integration` (set below) so the production Kysely
//      client uses `public` (and `knowledge` via `withSchema`) directly.
//      `DATABASE_URL` is overridden to point at `DATABASE_URL_TEST` so
//      the prod Kysely's module-level pool connects to the test DB
//      rather than the dev-loop DB.

import { execSync } from 'node:child_process';
import path from 'node:path';

import { Client } from 'pg';
import dotenv from 'dotenv';

import { requireEnv } from '../lib/utils/environment';

const REQUIRED_EXTENSIONS = ['btree_gin', 'citext', 'pgcrypto', 'unaccent', 'vector', 'pg_trgm'];

/**
 * Build a connection URL that points at the test DB but with the
 * dev-loop superuser's credentials. Returns null if `devUrl` is
 * undefined or unparseable.
 *
 * The `vector` extension requires superuser to install; the
 * test role doesn't have that privilege. We pre-install via the
 * superuser so subsequent `CREATE EXTENSION IF NOT EXISTS` calls in
 * migrate.sh no-op.
 */
function deriveSuperUrlForTestDb(input: {
  devUrl: string | undefined;
  testUrl: string;
}): string | null {
  if (!input.devUrl) return null;
  // postgres://user:pass@host:port/db?params — split off the db.
  const devMatch = input.devUrl.match(/^(postgres(?:ql)?:\/\/[^/]+\/)([^?]+)(\?.*)?$/);
  const testMatch = input.testUrl.match(/^postgres(?:ql)?:\/\/[^/]+\/([^?]+)(\?.*)?$/);
  if (!devMatch || !testMatch) return null;
  return `${devMatch[1]}${testMatch[1]}${devMatch[3] ?? ''}`;
}

// eslint-disable-next-line local-rules/bottom-exports
export default async function applyMigrationsToTestDb(): Promise<void> {
  dotenv.config();

  requireEnv('DATABASE_URL_TEST');
  const testUrl = process.env.DATABASE_URL_TEST!;

  // 1. Sanity-probe the connection. If the test DB doesn't exist or
  //    isn't reachable, fail loudly with an actionable message rather
  //    than letting the migrate.sh subshell die with a less useful
  //    output.
  const client = new Client({ connectionString: testUrl });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[W3-A2 harness] Cannot connect to DATABASE_URL_TEST (${testUrl}). ` +
        `Ensure the test database exists and dev-loop's Postgres is running.\n` +
        `Underlying error: ${cause}`,
    );
  } finally {
    await client.end();
  }

  // 2. Pre-create extensions as a superuser. The `vector` extension
  //    requires superuser; the test role doesn't have that privilege.
  //    `migrate.sh`'s init.sql + 000_initial.sql then see the
  //    extensions already present and the `CREATE EXTENSION IF NOT
  //    EXISTS` calls no-op.
  //
  //    Uses DATABASE_URL (the dev-loop's superuser) on the same
  //    host:port but the test DB name. Falls back gracefully if the
  //    extensions are already present.
  // Derive a superuser URL to the test DB. Manual parse of the
  // postgres:// URL because `new URL(...).origin` swallows the
  // userinfo on some Node versions.
  const superUrl = process.env.DATABASE_URL_TEST_SUPERUSER
    ?? deriveSuperUrlForTestDb({
      devUrl: process.env.DATABASE_URL,
      testUrl,
    });
  if (superUrl && superUrl !== testUrl) {
    const superClient = new Client({ connectionString: superUrl });
    try {
      await superClient.connect();
      for (const ext of REQUIRED_EXTENSIONS) {
        try {
          await superClient.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
        } catch (err) {
          // Some extensions may not be installable in this Postgres
          // build; skip and let migrate.sh surface the real failure if
          // they're actually required.
          console.warn(
            `[W3-A2 harness] CREATE EXTENSION IF NOT EXISTS ${ext} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[W3-A2 harness] Extension pre-creation skipped (${err instanceof Error ? err.message : String(err)}). ` +
          `If migrate.sh fails with a permission error, set DATABASE_URL_TEST_SUPERUSER to a superuser URL.`,
      );
    } finally {
      await superClient.end();
    }
  }

  // 3. Apply migrations via migrate.sh. The script is idempotent — it
  //    skips versions already recorded in `_migrations.migrations`.
  //    We invoke it synchronously here so any failure short-circuits
  //    globalSetup; tests should never run against an under-migrated
  //    schema.
  const apiRoot = path.resolve(__dirname, '..', '..');
  const migrateScript = path.join(apiRoot, 'src', 'db', 'migrate.sh');
  try {
    execSync(`bash "${migrateScript}" "${testUrl}"`, {
      stdio: ['ignore', 'inherit', 'inherit'],
      cwd: apiRoot,
    });
  } catch (err) {
    throw new Error(
      `[W3-A2 harness] migrate.sh failed against the test DB. ` +
        `Inspect the output above for the failing migration.\n` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
