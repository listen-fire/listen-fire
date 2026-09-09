#!/bin/bash

# Exit immediately on failure if any of the commands fail
# https://www.gnu.org/software/bash/manual/html_node/The-Set-Builtin.html
set -e

: "${PLAYWRIGHT_BROWSERS_PATH:?Variable not set or empty}"

npm install -g pnpm@9.5.0
pnpm install
pnpm prisma generate
NODE_OPTIONS="--max-old-space-size=4096" pnpm build
pnpm -r schema:migrate
pnpm playwright install chromium
