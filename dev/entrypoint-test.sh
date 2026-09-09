#!/bin/bash
set -e

echo "==> Applying schema and migrations..."
cd /app/apps/api

# Run migrations without codegen (already done at build time)
NODE_ENV=production bash src/db/migrate.sh "$DATABASE_URL"

echo "==> Starting API server..."
TZ=utc npx ts-node --project tsconfig.dev.json --transpile-only \
  -r dotenv/config -r tsconfig-paths/register src/server.ts &
API_PID=$!

echo "==> Starting web server..."
cd /app/apps/web
pnpm start &
WEB_PID=$!

echo "==> Waiting for servers..."
cd /app
npx wait-on http://localhost:3000/.well-known/health-check http://localhost:3003 --timeout 120000

echo "==> Running UI test agent..."
cd /app/apps/api
TZ=utc npx ts-node --project tsconfig.dev.json --transpile-only \
  -r dotenv/config -r tsconfig-paths/register src/scripts/ui_test_agent.ts "$@"
EXIT_CODE=$?

kill $API_PID $WEB_PID 2>/dev/null || true
exit $EXIT_CODE
