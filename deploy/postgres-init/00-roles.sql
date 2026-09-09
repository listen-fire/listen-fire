-- Roles the migration set grants to. They must exist before the first
-- migration — more than a hundred `GRANT … TO agent` / `TO readonly`
-- statements across the migration set fail on a database without them, and
-- the first one is early enough that you get almost no schema at all.
--
-- Two paths run this one file, and neither needs you to:
--   * the bundled Postgres mounts this directory as docker-entrypoint-initdb.d
--     and runs it on an empty data directory;
--   * the migration runner (apps/api/src/db/migrate.sh) runs it before the
--     first migration when the roles are missing and the connecting user has
--     CREATEROLE, which a managed provider's database owner does.
--
-- Run it by hand only when the runner tells you to -- that is, when the user in
-- DATABASE_URL has neither SUPERUSER nor CREATEROLE:
--
--   psql "$DATABASE_URL" -f deploy/postgres-init/00-roles.sql
--
-- Every statement below is idempotent, because both paths may run it against a
-- database that already has the roles. Postgres has no CREATE ROLE IF NOT
-- EXISTS, hence the block.

DO $$
BEGIN
  -- A grant target, not an account. Give it LOGIN and a password only if you
  -- actually point DATABASE_URL_READONLY at a read replica user.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readonly') THEN
    CREATE ROLE readonly NOLOGIN;
  END IF;

  -- The role a knowledge-agent query runs AS. It is deliberately powerless:
  -- row-level security policies are written against `current_user != 'agent'`,
  -- so this role sees only what a policy hands it. No BYPASSRLS — managed
  -- databases often refuse to grant it, and the design does not want it.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent') THEN
    CREATE ROLE agent WITH LOGIN PASSWORD NULL
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;

-- Bounds on anything running as `agent`, which is by definition SQL somebody
-- else wrote.
ALTER ROLE agent SET search_path = '';
ALTER ROLE agent SET statement_timeout = '30s';
ALTER ROLE agent SET lock_timeout = '10s';
ALTER ROLE agent SET idle_in_transaction_session_timeout = '60s';

GRANT USAGE ON SCHEMA public TO readonly, agent;
REVOKE CREATE ON SCHEMA public FROM agent;
