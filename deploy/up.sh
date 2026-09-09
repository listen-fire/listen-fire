#!/usr/bin/env bash
# Bring up Listen-Fire with the units you name.
#
#   ./up.sh knowledge
#   ./up.sh core knowledge automations --demo
#   ./up.sh core asks valuations knowledge automations --demo
#
# The unit names are the product names the process itself knows
# (apps/api/src/products.ts). Everything else — which identity provider, which
# optional services, which compose profiles — follows from them.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DEPLOY_DIR"

# macOS ships bash 3.2, where `"${arr[@]}"` on an EMPTY array is an unbound
# variable under `set -u`. `${arr[@]+"${arr[@]}"}` expands to nothing instead,
# which is what every empty-array expansion below uses.
VALID_UNITS=(core valuations automations knowledge asks)
UNITS=()
DEMO=0
BUILD=1

for arg in "$@"; do
  case "$arg" in
    --demo) DEMO=1 ;;
    # For a caller that has just built the same images — the smoke script does
    # this between shapes. Skipping the build is only safe when the tags are
    # known to be current; a stale tag boots silently and looks like the code.
    --no-build) BUILD=0 ;;
    -h|--help)
      echo "usage: ./up.sh <unit…> [--demo] [--no-build]"
      echo "units: ${VALID_UNITS[*]}"
      exit 0
      ;;
    -*)
      echo "up.sh: unknown flag '$arg'" >&2
      exit 1
      ;;
    *)
      ok=0
      for valid in "${VALID_UNITS[@]}"; do [ "$arg" = "$valid" ] && ok=1; done
      if [ "$ok" -eq 0 ]; then
        echo "up.sh: '$arg' is not a unit. Valid: ${VALID_UNITS[*]}" >&2
        exit 1
      fi
      UNITS+=("$arg")
      ;;
  esac
done

if [ "${#UNITS[@]}" -eq 0 ]; then
  echo "up.sh: name at least one unit. Valid: ${VALID_UNITS[*]}" >&2
  exit 1
fi

if [ ! -f .env ]; then
  echo "up.sh: no deploy/.env — start with 'cp deploy/.env.example deploy/.env'." >&2
  exit 1
fi

has_unit() { for u in "${UNITS[@]}"; do [ "$u" = "$1" ] && return 0; done; return 1; }

LISTEN_FIRE_PRODUCTS="$(IFS=,; echo "${UNITS[*]}")"
export LISTEN_FIRE_PRODUCTS

# `core` in the product list and LISTEN_FIRE_PRINCIPAL=core imply each other; the
# process checks both directions at boot and refuses a half-set pair.
if has_unit core; then export LISTEN_FIRE_PRINCIPAL=core; else export LISTEN_FIRE_PRINCIPAL=static; fi

# Graph mutations go to an in-process consumer only when automations is here to
# be it; otherwise they go to registered webhooks and drain quietly to nobody.
if has_unit automations && has_unit knowledge; then
  export KNOWLEDGE_MUTATION_DELIVERY=local
else
  export KNOWLEDGE_MUTATION_DELIVERY=webhook
fi

# A settled ask nudges the movement engine in-process only when automations is
# here to BE that engine; otherwise the settle is a signed POST to whoever left
# a callback URL. Same one-path-only rule as graph mutations above: doing both
# would announce one answer twice.
if has_unit automations && has_unit asks; then
  export ASKS_SETTLE_DELIVERY=local
else
  export ASKS_SETTLE_DELIVERY=webhook
fi

# Redis is not optional and has no profile — see the compose file's header.
PROFILES=()
if has_unit core; then PROFILES+=(admin); fi
if [ "$DEMO" -eq 1 ]; then
  PROFILES+=(demo)
  export LISTEN_FIRE_DEMO=1
  export LISTEN_FIRE_NODE_ENV=development
  export MOCK_OUTPUT_ADAPTERS=true
  export FAKE_CHANNELS_URL=http://fake-channels:5556
  # The address automations receive mail on. Real deployments set their own;
  # the demo names one so an email trigger has something to route on at all.
  export INBOUND_EMAIL_ADDRESS="${INBOUND_EMAIL_ADDRESS:-inbox@listen-fire.local}"
  export RESEND_API_BASE_URL=http://fake-channels:5556/resend
fi

PROFILE_ARGS=()
for p in ${PROFILES[@]+"${PROFILES[@]}"}; do PROFILE_ARGS+=(--profile "$p"); done

# Host ports, so the printed URLs and the health waits agree with the mapping.
WEB_PORT="${WEB_PORT:-8080}"
API_PORT="${API_PORT:-8081}"
ADMIN_PORT="${ADMIN_PORT:-8082}"
FAKE_CHANNELS_PORT_HOST="${FAKE_CHANNELS_PORT_HOST:-8083}"
export WEB_PORT API_PORT ADMIN_PORT FAKE_CHANNELS_PORT_HOST
export API_BASE_URL="http://localhost:${API_PORT}"
export WEB_BASE_URL="http://localhost:${WEB_PORT}"

compose() { docker compose ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} "$@"; }

echo "[up] units:     $LISTEN_FIRE_PRODUCTS"
echo "[up] identity:  $LISTEN_FIRE_PRINCIPAL"
echo "[up] profiles:  ${PROFILES[*]:-none}"
echo

# ── images, ONE AT A TIME ───────────────────────────────────────────────────
#
# The api and the web app each ask their build for a 6GB node heap, and a
# single `compose up --build` hands every service to ONE BuildKit session,
# which runs them concurrently: on a stock Docker Desktop allocation that is an
# OOM kill (exit 137) partway through the build, and it reads as a broken
# repository rather than a full machine. `COMPOSE_PARALLEL_LIMIT` does not help
# — it bounds compose's own service concurrency, not BuildKit's, so the guard
# that used to live here never constrained the thing that was overlapping.
#
# So the builds happen here, in separate `docker build` invocations that cannot
# overlap, and `compose up` below runs WITHOUT `--build` against the tags they
# produce. Only the images this composition actually starts are built.
build_image() {
  local tag="$1" dockerfile="$2" target="${3:-}"
  local args=(-f "$DEPLOY_DIR/$dockerfile" -t "$tag")
  [ -n "$target" ] && args+=(--target "$target")

  echo "[up] building $tag …"
  docker build "${args[@]}" "$DEPLOY_DIR/.."
}

if [ "$BUILD" -eq 1 ]; then
  # migrate and seed share the api's image, so `api` covers all three.
  build_image listen-fire-api:local Dockerfile
  build_image listen-fire-web:local Dockerfile.web web
  # The admin app rides the `admin` profile, which only core turns on.
  if has_unit core; then build_image listen-fire-admin:local Dockerfile.web admin; fi
  # The fake third parties exist only for a demo stack.
  if [ "$DEMO" -eq 1 ]; then build_image listen-fire-fake-channels:local Dockerfile.web fake-channels; fi
  echo
else
  echo "[up] --no-build: using the existing listen-fire-*:local images"
  echo
fi

# `seed` is a normal service so a bare `docker compose up` seeds the demo, but
# HERE it must not start on its own: this script runs it explicitly below, and
# two seeds racing the same tables is not what idempotent means.
UP_ARGS=(-d --remove-orphans)
if [ "$DEMO" -eq 1 ]; then UP_ARGS+=(--scale seed=0); fi

compose up "${UP_ARGS[@]}"

echo -n "[up] waiting for the API"
for i in $(seq 1 90); do
  if curl -fsS "http://localhost:${API_PORT}/.well-known/health-check" >/dev/null 2>&1; then
    echo " ready."
    break
  fi
  echo -n "."
  sleep 2
  if [ "$i" -eq 90 ]; then
    echo
    echo "[up] the API never became healthy. Logs:" >&2
    compose logs --tail 60 init migrate api >&2
    exit 1
  fi
done

echo -n "[up] waiting for the web app"
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${WEB_PORT}/login" >/dev/null 2>&1; then
    echo " ready."
    break
  fi
  echo -n "."
  sleep 2
  if [ "$i" -eq 60 ]; then
    echo
    echo "[up] the web app never answered /login. Logs:" >&2
    compose logs --tail 60 web >&2
    exit 1
  fi
done

if has_unit core; then
  echo -n "[up] waiting for the admin app"
  for i in $(seq 1 30); do
    if curl -fsS "http://localhost:${ADMIN_PORT}/login" >/dev/null 2>&1; then
      echo " ready."
      break
    fi
    echo -n "."
    sleep 2
    if [ "$i" -eq 30 ]; then
      echo
      echo "[up] the admin app never answered /login. Logs:" >&2
      compose logs --tail 60 admin >&2
      exit 1
    fi
  done
fi

if [ "$DEMO" -eq 1 ]; then
  echo "[up] seeding the demo dataset…"
  compose run --rm seed
fi

# Every caller assigns the result, so `exit 1` in this subshell is the whole
# script's exit status under `set -e` — the failure cannot be printed and then
# walked past.
read_generated() {
  local name="$1" value
  if ! value="$(compose run --rm --no-deps --entrypoint sh init \
      -c ". /config/generated.env; printf %s \"\$$name\"" 2>/dev/null)"; then
    echo "[up] could not read /config/generated.env — is the listen-fire-config volume intact?" >&2
    exit 1
  fi
  value="$(printf %s "$value" | tr -d '\r')"
  if [ -z "$value" ]; then
    echo "[up] /config/generated.env names no $name — is the listen-fire-config volume intact?" >&2
    exit 1
  fi
  printf %s "$value"
}

# Asks has no pages of its own — its answer link is served by the API, and the
# surface that watches and answers questions belongs to automations. So an
# asks-only install has nothing to open at the web port.
ASKS_ONLY=0
if [ "${#UNITS[@]}" -eq 1 ] && has_unit asks; then ASKS_ONLY=1; fi

echo
echo "──────────────────────────────────────────────────────────────"
if [ "$ASKS_ONLY" -eq 1 ]; then
  echo " Listen-Fire is up:  http://localhost:${API_PORT}"
else
  echo " Listen-Fire is up:  http://localhost:${WEB_PORT}"
fi
echo "──────────────────────────────────────────────────────────────"
if [ "$ASKS_ONLY" -eq 1 ]; then
  echo " An asks-only installation is API-only: asks have no pages of their own, and their UI ships with automations."
fi

if [ "$LISTEN_FIRE_PRINCIPAL" = "static" ]; then
  API_KEY="$(read_generated LISTEN_FIRE_API_KEY)"
  echo " Sign in with this API key:"
  echo
  echo "   $API_KEY"
  echo
  echo " (it is also the Bearer token for the REST and MCP surfaces)"
else
  ADMIN_EMAIL="$(read_generated LISTEN_FIRE_BOOTSTRAP_USER_EMAIL)"
  if [ "$DEMO" -eq 1 ]; then
    curl -fsS -X POST "http://localhost:${API_PORT}/api/public/auth/requestMagicLink" \
      -H 'content-type: application/json' \
      -d "{\"email\":\"${ADMIN_EMAIL}\"}" >/dev/null
    # The send is queued, so the outbox is a moment behind the request.
    LINK=""
    for _ in 1 2 3; do
      sleep 2
      LINK="$(curl -fsS "http://localhost:${FAKE_CHANNELS_PORT_HOST}/email/outbox" \
        | node -e '
          let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{
            const msgs=JSON.parse(raw).data ?? [];
            const hit=[...msgs].reverse().map(m=>/https?:\/\/\S*\/magic\?token=[A-Za-z0-9._-]+/.exec(m.data ?? ""))
              .find(Boolean);
            process.stdout.write(hit ? hit[0] : "");
          });')"
      [ -n "$LINK" ] && break
    done
    echo " Sign in for ${ADMIN_EMAIL} with this one-time link:"
    echo
    echo "   ${LINK:-<no link in the fake outbox — check: docker compose logs api>}"
  else
    echo " Sign in at http://localhost:${WEB_PORT}/login as ${ADMIN_EMAIL}."
    echo " The magic link is emailed, so a working MAILGUN_* config is required."
  fi
fi
echo
