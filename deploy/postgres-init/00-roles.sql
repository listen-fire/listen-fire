-- Roles the migration set grants to. Run this ONCE against a new database,
-- BEFORE the first migration — 51 `GRANT … TO agent` / `TO readonly`
-- statements across the migration history fail on a database without them, and
-- the first one is early enough that you get almost no schema at all.
--
-- The compose file mounts this directory into the bundled Postgres, which runs
-- it automatically on an empty data directory. **A managed database (Neon,
-- RDS, Supabase) has no such hook: run this file by hand, as a superuser,
-- before you start the API.**
--
-- Postgres has no CREATE ROLE IF NOT EXISTS, hence the block.

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
