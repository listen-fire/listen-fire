#!/bin/bash

# Exit immediately on failure if any of the commands fail
# https://www.gnu.org/software/bash/manual/html_node/The-Set-Builtin.html
set -e

# The api tsc emit needs >4GB heap (node's default cap). NB: `set VAR=…` is not
# bash — the old line here never exported anything.
export NODE_OPTIONS=--max-old-space-size=8192

npm install -g pnpm@9.5.0
pnpm install
pnpm prisma generate
pnpm build
pnpm -r schema:migrate
