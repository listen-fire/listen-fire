#!/bin/bash
set -e

# 00-roles.sql (shared with the self-host image) already created the
# 'readonly' role as NOLOGIN with no password. Dev connects as it directly
# (no separate read replica), so give it LOGIN + a known password here, then
# grant read permissions on '$POSTGRES_DB'.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	ALTER ROLE readonly WITH LOGIN PASSWORD 'readonly';
  GRANT USAGE ON SCHEMA public TO readonly;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO readonly;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly;
EOSQL
