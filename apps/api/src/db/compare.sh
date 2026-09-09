#!/bin/bash
set -e

# Usage: ./compare.sh
# Compares the current database state against schema.sql
# Shows what SQL would need to run to bring the database back to the official schema

MIGRATIONS_DIR="$(dirname "$0")/migrations"
SCHEMA_FILE="$(dirname "$0")/schema.sql"
TMP_DIR="$(dirname "$0")/tmp"

# Load DATABASE_URL from .env
if [ -f "$(dirname "$0")/../../.env" ]; then
  export $(grep DATABASE_URL "$(dirname "$0")/../../.env" | xargs)
fi
DB_URL="$DATABASE_URL"
if [ -z "$DB_URL" ]; then
  echo "DATABASE_URL must be set in .env"
  exit 1
fi

# Parse connection info from DB_URL
url="${DB_URL#postgresql://}"
url="${url#postgres://}"
PGUSER="${url%%:*}"
rest="${url#*:}"
PGPASSWORD="${rest%%@*}"
rest="${rest#*@}"
PGHOST="${rest%%:*}"
rest="${rest#*:}"
PGPORT="${rest%%/*}"
PGDATABASE="${rest#*/}"

# On Mac, Docker needs host.docker.internal instead of localhost
DOCKER_PGHOST="$PGHOST"
if [[ "$PGHOST" == "localhost" ]]; then
  DOCKER_PGHOST="host.docker.internal"
fi

mkdir -p "$TMP_DIR"

CURRENT_DUMP="$TMP_DIR/current_db.sql"
SCHEMA_DUMP="$TMP_DIR/schema_db.sql"

echo "Dumping current database schema..."
PGPASSWORD="$PGPASSWORD" docker run --rm --network=host -e PGPASSWORD="$PGPASSWORD" pgvector/pgvector:pg16 \
  pg_dump --schema-only --no-owner --no-privileges -h "$DOCKER_PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -w \
  > "$CURRENT_DUMP"

echo "Creating temp database from schema.sql..."
BASE_URL="$(echo "$DB_URL" | sed -E 's|/[^/]+$||')/postgres"
SCHEMA_TMP_DB="listenfire_compare_tmp"
PGPASSWORD="$PGPASSWORD" psql "$BASE_URL" -c "DROP DATABASE IF EXISTS \"$SCHEMA_TMP_DB\";" -w
PGPASSWORD="$PGPASSWORD" psql "$BASE_URL" -c "CREATE DATABASE \"$SCHEMA_TMP_DB\";" -w
SCHEMA_TMP_URL="$(echo "$DB_URL" | sed -E "s|/[^/]+$|/$SCHEMA_TMP_DB|")"

# Apply migrations/init.sql if it exists (sets up _migrations schema)
INIT_MIGRATION="$MIGRATIONS_DIR/init.sql"
if [ -f "$INIT_MIGRATION" ]; then
  PGPASSWORD="$PGPASSWORD" psql "$SCHEMA_TMP_URL" -v ON_ERROR_STOP=1 -w -f "$INIT_MIGRATION" > /dev/null 2>&1
fi

# Apply schema.sql
PGPASSWORD="$PGPASSWORD" psql "$SCHEMA_TMP_URL" -v ON_ERROR_STOP=1 -w -f "$SCHEMA_FILE" > /dev/null 2>&1

echo "Dumping schema.sql database..."
PGPASSWORD="$PGPASSWORD" docker run --rm --network=host -e PGPASSWORD="$PGPASSWORD" pgvector/pgvector:pg16 \
  pg_dump --schema-only --no-owner --no-privileges -h "$DOCKER_PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$SCHEMA_TMP_DB" -w \
  > "$SCHEMA_DUMP"

echo ""
echo "Comparing current database to schema.sql..."
echo "============================================"
echo ""

DIFF_OUTPUT=$(docker run --rm -v "$(pwd)":/workspace lovelysystems/apgdiff:dev \
  /workspace/$CURRENT_DUMP /workspace/$SCHEMA_DUMP 2>&1) || true

if [ -z "$DIFF_OUTPUT" ] || [ "$DIFF_OUTPUT" = "" ]; then
  echo "No differences found. Database matches schema.sql."
else
  echo "To reset your database to match schema.sql, run the following SQL:"
  echo ""
  echo "$DIFF_OUTPUT"
fi

# Clean up
PGPASSWORD="$PGPASSWORD" psql "$BASE_URL" -c "DROP DATABASE IF EXISTS \"$SCHEMA_TMP_DB\";" -w > /dev/null 2>&1
rm -rf "$TMP_DIR"
