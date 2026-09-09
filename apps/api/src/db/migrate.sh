#!/bin/bash
set -e

# Usage: ./migrate.sh [DATABASE_URL]
# Defaults to DATABASE_URL in .env if not provided

HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$HERE/migrations}"
SCHEMA_FILE="$HERE/schema.sql"
# The two roles the migration set grants to. ONE definition, shared: this is the
# same file the bundled Postgres runs out of docker-entrypoint-initdb.d, so a
# compose database has the roles before this script looks, and a managed one
# (which has no init hook) gets them from here.
ROLES_FILE="${ROLES_FILE:-$HERE/../../../../deploy/postgres-init/00-roles.sql}"

if [ -z "$1" ]; then
  if [ -f "$HERE/../../.env" ]; then
    export $(grep DATABASE_URL "$HERE/../../.env" | xargs)
  fi
  DB_URL="$DATABASE_URL"
else
  DB_URL="$1"
fi

if [ -z "$DB_URL" ]; then
  echo "DATABASE_URL must be set in .env or passed as an argument"
  exit 1
fi

# Parse connection info
url="${DB_URL#postgres://}"
PGUSER="${url%%:*}"
rest="${url#*:}"
PGPASSWORD="${rest%%@*}"
rest="${rest#*@}"
PGHOST="${rest%%:*}"
rest="${rest#*:}"
PGPORT="${rest%%/*}"
PGDATABASE="${rest#*/}"

# On Mac, Docker needs host.docker.internal
if [[ "$PGHOST" == "localhost" ]]; then
  PGHOST="host.docker.internal"
fi

# One scalar, no noise: every probe below asks a question that is legal against
# an empty database, so a clean first run logs nothing.
query() {
  PGPASSWORD="$PGPASSWORD" psql "$DB_URL" -w -v ON_ERROR_STOP=1 -tAc "$1"
}

# The file and the ledger row it earns commit together, so a failure anywhere in
# the file leaves neither. Nothing in the migration set may open its own
# transaction or contain a psql meta-command: --single-transaction wraps the -f
# and the -c below in one BEGIN/COMMIT, and an inner COMMIT would end it early.
apply() {
  local file="$1"
  local version="$2"
  PGPASSWORD="$PGPASSWORD" psql "$DB_URL" -w -v ON_ERROR_STOP=1 --single-transaction \
    -f "$file" \
    -c "INSERT INTO _migrations.migrations (version) VALUES ('$version')"
}

# to_regclass answers NULL rather than raising when the schema itself is absent,
# which is the state of every fresh database before init.sql runs.
already_applied() {
  if [ "$(query "SELECT to_regclass('_migrations.migrations') IS NOT NULL")" != "t" ]; then
    return 1
  fi
  [ "$(query "SELECT 1 FROM _migrations.migrations WHERE version = '$1'")" = "1" ]
}

# ---- Roles, before any schema exists.
#
# 51 `GRANT … TO agent` / `TO readonly` statements are spread through the
# migration set, and the first is early enough that a database missing the roles
# dies having built most of a schema and recorded none of it. Managed providers
# hand the operator a database owner with CREATEROLE, so create them here; when
# the connecting user cannot, stop now — before touching the schema — and say
# what to run.
ROLES_PRESENT="$(query "SELECT count(*) FROM pg_roles WHERE rolname IN ('agent', 'readonly')")"
if [ "$ROLES_PRESENT" = "2" ]; then
  echo "Roles agent and readonly already exist"
else
  CAN_CREATE_ROLE="$(query "SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user")"
  if [ "$CAN_CREATE_ROLE" != "t" ]; then
    CURRENT_USER="$(query "SELECT current_user")"
    cat >&2 <<EOF

The migration set grants to two roles, agent and readonly, and this database is
missing at least one of them. The connecting user ($CURRENT_USER) has neither
SUPERUSER nor CREATEROLE, so this script cannot create them for you.

Nothing has been applied. Run the roles file as a superuser, then run this
again:

  psql "\$DATABASE_URL" -f deploy/postgres-init/00-roles.sql

EOF
    exit 1
  fi
  if [ ! -f "$ROLES_FILE" ]; then
    echo "Roles agent and readonly are missing and the roles file is not at $ROLES_FILE" >&2
    echo "Run deploy/postgres-init/00-roles.sql against the database, then run this again." >&2
    exit 1
  fi
  echo "Creating the agent and readonly roles from $(basename "$ROLES_FILE")"
  PGPASSWORD="$PGPASSWORD" psql "$DB_URL" -w -v ON_ERROR_STOP=1 --single-transaction -f "$ROLES_FILE"
fi

# Always apply init.sql first, but record and skip if already applied
INIT_MIGRATION="$MIGRATIONS_DIR/init.sql"
INIT_VERSION="init.sql"
if [ -f "$INIT_MIGRATION" ]; then
  if already_applied "$INIT_VERSION"; then
    echo "Skipping already applied migration: $INIT_VERSION"
  else
    echo "Applying init.sql (migration tracking table)"
    apply "$INIT_MIGRATION" "$INIT_VERSION"
    echo "Recorded migration: $INIT_VERSION"
  fi
fi

# Apply all migration files in order, tracking in _migrations.migrations
for f in "$MIGRATIONS_DIR"/*.sql; do
  VERSION=$(basename "$f")
  # Skip init.sql (already applied)
  if [[ "$VERSION" == "init.sql" ]]; then
    continue
  fi
  if already_applied "$VERSION"; then
    echo "Skipping already applied migration: $VERSION"
    continue
  fi
  echo "Applying migration: $f"
  apply "$f" "$VERSION"
  echo "Recorded migration: $VERSION"
done

echo "All migrations applied."

# Optionally, update schema.sql.txt to reflect current schema
# pg_dump --schema-only --no-owner --no-privileges "$DB_URL" > "$SCHEMA_FILE"

# Optionally generate Kysely types after migrations (dev only)
if [ "$NODE_ENV" = "development" ]; then
  bun run prisma db pull --force
  bun run prisma-case-format -f "$HERE/../prisma/schema.autogenerated.prisma" -p
  # remove all lines in the autogenerated prisma schema that list the Gin indexes
  # (a temp file rather than `sed -i`, whose in-place flag differs on BSD and GNU)
  gin_stripped="$HERE/../prisma/schema.autogenerated.prisma"
  sed '/type: Gin/d' "$gin_stripped" > "$gin_stripped.tmp" && mv "$gin_stripped.tmp" "$gin_stripped"
  pnpm prisma generate
  echo "Generating Kysely types with Kanel..."
  bun run --cwd "$HERE/../../" generate:kysely
fi
