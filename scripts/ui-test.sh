#!/bin/bash
# Containerized UI test agent
#
# Usage:
#   ./scripts/ui-test.sh "Navigate to ontology and verify nodes render"
#   ./scripts/ui-test.sh --headless "Take a screenshot of the homepage"
#
# Requires ANTHROPIC_API_KEY and OPENAI_API_KEY in your environment.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR/dev"

docker compose -f docker-compose.test.yml build app
docker compose -f docker-compose.test.yml run --rm app "$@"
EXIT_CODE=$?

docker compose -f docker-compose.test.yml down --volumes
exit $EXIT_CODE
