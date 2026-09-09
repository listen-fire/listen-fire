FROM pgvector/pgvector:pg15

# Build context is the repository root (dev/docker-compose*.yml build off `..`)
# so this can share the role definitions with the self-host path instead of
# carrying a second copy of them.
COPY deploy/postgres-init/00-roles.sql /docker-entrypoint-initdb.d
COPY dev/load-pg-extensions.sh /docker-entrypoint-initdb.d
COPY dev/create-test-database.sh /docker-entrypoint-initdb.d
COPY dev/readonly-user.sh /docker-entrypoint-initdb.d

CMD ["postgres", "-c", "max_locks_per_transaction=128"]
