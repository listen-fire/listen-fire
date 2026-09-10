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
# pull | build | reuse. Pulling is the default because a release is published
# images: an installation that built from source would be running whatever the
# checkout happens to be rather than the version it named.
SOURCE=pull

for arg in "$@"; do
  case "$arg" in
    --demo) DEMO=1 ;;
    # Build from THIS tree instead of pulling. What you want when you are
    # working on the code, or on an architecture no published image covers.
    --build) SOURCE=build ;;
    # Neither pull nor build: use the images already on this machine. For a
    # caller that has just built the same tags — the smoke script does this
    # between shapes. Only safe when they are known to be current; a stale tag
    # boots silently and looks like the code.
    --no-build) SOURCE=reuse ;;
    -h|--help)
      echo "usage: ./up.sh <unit…> [--demo] [--build|--no-build]"
      echo "units: ${VALID_UNITS[*]}"
      echo
      echo "Images come from ghcr.io/listen-fire at \$LISTEN_FIRE_VERSION (default: latest)."
      echo "  --build     build them from this tree instead"
      echo "  --no-build  use the images already on this machine"
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

# A configured value, resolved the way compose resolves it: the shell wins,
# then deploy/.env. Used for anything this script has to agree with compose
# about — the image tag it builds or pulls, and which datastores are bundled.
configured() {
  local name="$1" value=""
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    value="$(sed -n "s/^[[:space:]]*$name=[\"']*//p" .env | tail -1 | tr -d '\r' | sed "s/[\"'].*\$//")"
  fi
  printf %s "$value"
}

# WHICH release this installation runs. Compose interpolates it from .env on
# its own, but the build and pull below name the tags themselves, so read the
# same file when the shell does not set it — otherwise a pinned .env and an
# unpinned shell would build one tag and start another.
LISTEN_FIRE_VERSION="$(configured LISTEN_FIRE_VERSION)"
export LISTEN_FIRE_VERSION
IMAGE_TAG="${LISTEN_FIRE_VERSION:-latest}"
REGISTRY=ghcr.io/listen-fire

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

# Each datastore is bundled unless you have named your own, and each one on its
# own: the compose file parks a service whose variable is set, and this names
# the profile for every service that is still bundled. The two readings have to
# agree, which is why both are the presence of the same variable.
PROFILES=()
STORES_REPORT=()
add_store() {
  local service="$1" variable="$2"
  if [ -n "$(configured "$variable")" ]; then
    STORES_REPORT+=("$service (yours, via $variable)")
  else
    PROFILES+=("$service")
    STORES_REPORT+=("$service (bundled)")
  fi
}
add_store postgres DATABASE_URL
add_store redis MESSAGE_QUEUE_REDIS_HOSTNAME
add_store minio AWS_S3_ENDPOINT

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

# Host ports and public URLs. deploy/.env WINS over every default here.
#
# These used to be exported unconditionally, and an exported value beats one
# compose reads from .env — so an installation behind a real hostname that ran
# up.sh republished itself at localhost, silently: every capability link it
# handed out unreachable, its session cookie no longer `Secure` and therefore
# dropped by the browser, every webhook it re-registered pointing at nowhere.
# `configured` resolves each one the way compose does (shell, then .env), so
# what this script supplies is a DEFAULT for an installation that named none.
default_from_env() {
  local name="$1" fallback="$2" value
  value="$(configured "$name")"
  eval "$name=\"\${value:-\$fallback}\""
  export "$name"
}
default_from_env WEB_PORT 8080
default_from_env API_PORT 8081
default_from_env ADMIN_PORT 8082
default_from_env FAKE_CHANNELS_PORT_HOST 8083

# WHICH address the published ports bind to. Loopback is what a deployment
# behind a reverse proxy wants — the proxy is on the box, and nothing else
# should be able to reach a plain-HTTP port. Every interface is what a trial on
# your own machine wants, and is the default.
default_from_env LISTEN_FIRE_BIND 0.0.0.0

# A port variable used to be able to carry its own bind address
# (`API_PORT=127.0.0.1:8081`), because compose interpolates the value whole.
# LISTEN_FIRE_BIND is now the place that lives, and the two forms cannot both be
# right — `0.0.0.0:127.0.0.1:8081:3000` is not a mapping. Say so here rather
# than let compose fail on a string it cannot explain.
for _port_var in WEB_PORT API_PORT ADMIN_PORT FAKE_CHANNELS_PORT_HOST; do
  eval "_port_value=\$$_port_var"
  case "$_port_value" in
    *:*)
      echo "up.sh: $_port_var is '$_port_value' — a port number, not an address." >&2
      echo "up.sh: set LISTEN_FIRE_BIND=${_port_value%:*} in deploy/.env instead." >&2
      exit 1
      ;;
  esac
done

# Where THIS machine reaches the stack, whatever the world reaches it on: the
# health waits below run on the box, and on a hostname deployment the public
# URL goes through a proxy that may not be up yet (or at all, on first boot).
API_LOCAL="http://localhost:${API_PORT}"
WEB_LOCAL="http://localhost:${WEB_PORT}"
ADMIN_LOCAL="http://localhost:${ADMIN_PORT}"

default_from_env API_BASE_URL "$API_LOCAL"
default_from_env WEB_BASE_URL "$WEB_LOCAL"

compose() { docker compose ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} "$@"; }

echo "[up] units:     $LISTEN_FIRE_PRODUCTS"
echo "[up] identity:  $LISTEN_FIRE_PRINCIPAL"
echo "[up] stores:    ${STORES_REPORT[*]}"
echo "[up] profiles:  ${PROFILES[*]:-none}"
echo "[up] images:    $REGISTRY/*:$IMAGE_TAG ($SOURCE)"
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
  local name="$1" dockerfile="$2" target="${3:-}"
  # The tag compose will start, so a build and a pull are interchangeable.
  local args=(-f "$DEPLOY_DIR/$dockerfile" -t "$REGISTRY/$name:$IMAGE_TAG")
  [ -n "$target" ] && args+=(--target "$target")
  # Only the api declares it; passing it to the others is a warning per build.
  [ "$name" = "api" ] && args+=(--build-arg "LISTEN_FIRE_VERSION=${LISTEN_FIRE_VERSION:-dev}")

  echo "[up] building $REGISTRY/$name:$IMAGE_TAG …"
  docker build "${args[@]}" "$DEPLOY_DIR/.."
}

case "$SOURCE" in
  build)
    # migrate and seed share the api's image, so `api` covers all three.
    build_image api Dockerfile
    build_image web Dockerfile.web web
    # The admin app rides the `admin` profile, which only core turns on.
    if has_unit core; then build_image admin Dockerfile.web admin; fi
    # The fake third parties exist only for a demo stack.
    if [ "$DEMO" -eq 1 ]; then build_image fake-channels Dockerfile.web fake-channels; fi
    echo
    ;;
  pull)
    echo "[up] pulling $REGISTRY/*:$IMAGE_TAG …"
    # Only the services this composition starts, and only the ones whose image
    # is ours — postgres and redis come down with `up` anyway.
    PULL_SERVICES=(api web)
    if has_unit core; then PULL_SERVICES+=(admin); fi
    if [ "$DEMO" -eq 1 ]; then PULL_SERVICES+=(fake-channels); fi
    if ! docker compose ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} pull "${PULL_SERVICES[@]}"; then
      echo "[up] could not pull $REGISTRY/*:$IMAGE_TAG." >&2
      echo "[up] Check LISTEN_FIRE_VERSION names a published release, or use --build." >&2
      exit 1
    fi
    echo
    ;;
  reuse)
    echo "[up] --no-build: using the $REGISTRY/*:$IMAGE_TAG images already on this machine"
    echo
    ;;
esac

# `seed` is a normal service so a bare `docker compose up` seeds the demo, but
# HERE it must not start on its own: this script runs it explicitly below, and
# two seeds racing the same tables is not what idempotent means.
UP_ARGS=(-d --remove-orphans)
if [ "$DEMO" -eq 1 ]; then UP_ARGS+=(--scale seed=0); fi

compose up "${UP_ARGS[@]}"

echo -n "[up] waiting for the API"
for i in $(seq 1 90); do
  if curl -fsS "${API_LOCAL}/.well-known/health-check" >/dev/null 2>&1; then
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
  if curl -fsS "${WEB_LOCAL}/login" >/dev/null 2>&1; then
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
    if curl -fsS "${ADMIN_LOCAL}/login" >/dev/null 2>&1; then
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
  echo " Listen-Fire is up:  ${API_BASE_URL}"
else
  echo " Listen-Fire is up:  ${WEB_BASE_URL}"
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
    curl -fsS -X POST "${API_LOCAL}/api/public/auth/requestMagicLink" \
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
    # Day one on a real installation, nobody can sign in: the link is emailed
    # and no mail provider is configured yet, which is the thing you would sign
    # in to configure. The link is MINTED either way, and it is stored in the
    # clear, so ask for one and read back the row rather than leave an operator
    # to find the recipe in a guide. (gcp-vm.md keeps it, for a stack that was
    # not started through this script.)
    curl -fsS -X POST "${API_LOCAL}/api/public/auth/requestMagicLink" \
      -H 'content-type: application/json' \
      -d "{\"email\":\"${ADMIN_EMAIL}\"}" >/dev/null 2>&1 || true

    # Read through the api image, which is what makes this work against a
    # database the operator named in DATABASE_URL as well as the bundled one:
    # `with-generated-env` resolves the same URL the api itself connects to,
    # and psql is in that image for the migration runner's sake. Bounded in
    # time so a token left over from an earlier run can never be mistaken for
    # the one just asked for — and so an address that is not this
    # installation's bootstrap user, which mints nothing and says nothing,
    # comes back empty rather than stale.
    RECENT_LINK_SQL="select token from core.magic_link_token where created_at > now() - interval '2 minutes' order by created_at desc limit 1"
    if ! TOKEN="$(compose run --rm --no-deps -e RECENT_LINK_SQL="$RECENT_LINK_SQL" \
        --entrypoint /usr/local/bin/with-generated-env api \
        sh -c 'psql "$DATABASE_URL" -tAc "$RECENT_LINK_SQL"' 2>/dev/null)"; then
      TOKEN=""
    fi
    TOKEN="$(printf %s "$TOKEN" | tr -d '[:space:]')"

    if [ -n "$TOKEN" ]; then
      echo " Sign in for ${ADMIN_EMAIL} with this one-time link:"
      echo
      echo "   ${WEB_BASE_URL}/magic?token=${TOKEN}"
      echo
      echo " It is single-use and good for an hour. Treat it as a live session:"
      echo " anyone who reads it is signed in as that admin."
      echo
      echo " Every link after this one is emailed, so set OUTBOUND_EMAIL_FROM plus"
      echo " either RESEND_API_KEY (preferred; it wins when both are set) or"
      echo " MAILGUN_API_KEY + MAILGUN_SENDING_DOMAIN — a half-set Mailgun pair"
      echo " is the same as no provider at all."
    else
      echo " Sign in at ${WEB_BASE_URL}/login as ${ADMIN_EMAIL}."
      echo " The magic link is emailed, so this needs OUTBOUND_EMAIL_FROM plus"
      echo " either RESEND_API_KEY (preferred) or MAILGUN_API_KEY +"
      echo " MAILGUN_SENDING_DOMAIN."
    fi
  fi
fi
echo
# The matching `down`, printed rather than left to be remembered: a `down` stops
# only what its profiles name, and these are the profiles THIS shape started.
echo " Stop it with:     docker compose ${PROFILE_ARGS[*]} down"
echo " Throw it away:    docker compose ${PROFILE_ARGS[*]} down -v   (destroys the data AND the keys)"
echo
