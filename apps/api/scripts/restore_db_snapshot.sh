#!/bin/bash



if [ $# -eq 0 ]; then
  echo "Missing path to the .dump snapshot"
elif [ $# -eq 1 ]; then
  echo "Restoring snapshot to local"

  script_dir=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

  export $(grep '^DATABASE_URL' $script_dir/../.env | xargs)
  # Echo the filename to expand e.g. the `~` character, and then quote
  # the result to account for spaces in the filename.
  pg_restore -cxOv -d $DATABASE_URL -v "$(echo $1)"

  echo "Setting up readonly user permissions"
  psql -Atxv ON_ERROR_STOP=ON $DATABASE_URL <<-EOSQL
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT * FROM pg_user WHERE usename = 'readonly') THEN
        CREATE ROLE readonly LOGIN PASSWORD 'readonly';
      END IF;
    END
    \$\$;

    GRANT USAGE ON SCHEMA public TO readonly;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO readonly;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly;
EOSQL

  echo "Setting up agent user with RLS restrictions"
  echo "Note: Does NOT use BYPASSRLS (not available on managed databases)"
  echo "RLS policies in schema.sql give full access to non-agent roles"
  psql -Atxv ON_ERROR_STOP=ON $DATABASE_URL <<-EOSQL
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT * FROM pg_user WHERE usename = 'agent') THEN
        CREATE ROLE agent WITH NOLOGIN NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOSUPERUSER NOINHERIT;
      END IF;
    END
    \$\$;

    -- Prevent agent from changing session settings that could bypass security
    ALTER ROLE agent SET session_preload_libraries = '';
    ALTER ROLE agent SET search_path = '';
    ALTER ROLE agent SET statement_timeout = '30s';
    ALTER ROLE agent SET lock_timeout = '10s';
    ALTER ROLE agent SET idle_in_transaction_session_timeout = '60s';

    GRANT USAGE ON SCHEMA public TO agent;

    REVOKE CREATE ON SCHEMA public FROM agent;
    REVOKE TEMP ON DATABASE postgres FROM agent;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM agent;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM agent;

    -- Revoke ability to execute functions by default
    -- (Built-in PostgreSQL functions like COALESCE are unaffected - they're in pg_catalog)
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM agent;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM agent;

    -- Grant execute on context functions needed for RLS policies
    GRANT EXECUTE ON FUNCTION public.current_team_id() TO agent;
    GRANT EXECUTE ON FUNCTION public.current_user_id() TO agent;
    GRANT EXECUTE ON FUNCTION public.current_context_id() TO agent;

    -- IMPORTANT: Agent role needs set_current_team_id() for context setting
    -- The application sets context in a transaction before switching to agent role
    -- User's SQL executes via execute_agent_query() which cannot call set_current_team_id
    -- because it's wrapped in a subquery that prevents changing session state
    GRANT EXECUTE ON FUNCTION public.set_current_team_id(text) TO agent;
    GRANT EXECUTE ON FUNCTION public.execute_agent_query(text) TO agent;

    -- Note: Table-specific grants are in schema.sql with the RLS policies

    -- Note: We do NOT use BYPASSRLS because managed databases often don't allow it
    -- Instead, schema.sql creates permissive RLS policies for non-agent roles
    -- using: USING (current_user != 'agent')
    -- This gives full access to application roles while restricting the agent role
EOSQL
else
  pg_restore -cxOv -v "$(echo $1)" -d "$(echo $2)"
fi
