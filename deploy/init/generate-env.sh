#!/bin/sh
# First boot: mint every secret this installation will ever use.
#
# Runs ONCE. If /config/generated.env already exists this script rewrites
# nothing and exits 0 — a rotated ENCRYPTION_MASTER_KEY makes every stored
# credential unreadable, and a rotated TOKEN_SECRET signs everybody out. Back the
# volume up; do not regenerate it.
set -eu

CONFIG_DIR="${CONFIG_DIR:-/config}"
TARGET="$CONFIG_DIR/generated.env"
PGPASS_FILE="$CONFIG_DIR/postgres_password"

# Governs every file/dir this script creates below, including CONFIG_DIR
# itself on a from-scratch volume.
umask 077
mkdir -p "$CONFIG_DIR"

# A crash between writing the .tmp and the rename leaves a stale partial
# write; it is safe to discard because the finished generated.env (below) is
# the only thing that gates re-generation.
rm -f "$TARGET.tmp" "$PGPASS_FILE.tmp"

if [ -f "$TARGET" ]; then
  echo "[init] $TARGET exists — leaving every secret exactly as it is."
  exit 0
fi

# A deployment with no model key has no agents, no property arbitration and no
# extraction. That is a supported DEMO (the sample data is already there) and a
# broken real install, so the refusal is conditional on --demo.
if [ "${LISTEN_FIRE_DEMO:-0}" != "1" ]; then
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${KNOWLEDGE_LLM_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
    echo "[init] REFUSING TO START: deploy/.env names no model key." >&2
    echo "[init]   Set ANTHROPIC_API_KEY (or KNOWLEDGE_LLM_API_KEY, or OPENAI_API_KEY)" >&2
    echo "[init]   in deploy/.env, or start with --demo to run without one." >&2
    exit 1
  fi
fi

# The dev-loop harness ids (TEST_HARNESS_TEAM_ID / TEST_HARNESS_USER_ID) are
# deliberately NOT written here. They are not identity — they are a switch:
# `isTestHarnessTeam` compares a team against them with no NODE_ENV gate, and a
# match rewrites every outbound integration credential to the fake-channels URL.
# Baked into the permanent secrets file they would make a real self-host talk to
# nothing, silently. `with-generated-env` derives them at run time, and only
# when LISTEN_FIRE_DEMO=1.

# node, not openssl: node:22-slim carries no openssl CLI.
rand_base64() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))'; }
rand_url()    { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))'; }
new_uuid()    { node -e 'process.stdout.write(require("crypto").randomUUID())'; }

# Escapes a value for embedding inside single quotes in POSIX sh: ' -> '\''
# Only operator-supplied values (team name, admin email) ever need this —
# every other field here is this script's own hex/base64/uuid output.
sq() { printf '%s' "$1" | sed "s/'/'\\\\''/g"; }

POSTGRES_PASSWORD="$(rand_url)"
TOKEN_SECRET="$(rand_url)"
# Signs the settle POSTs a `webhook`-delivery asks deployment sends. Without it
# the delivery worker holds every settle rather than sending one a receiver
# cannot authenticate, so a standalone asks install needs it from boot.
ASKS_WEBHOOK_SIGNING_SECRET="$(rand_url)"
# Signs the public document links handed to the outside world (a CRM field, a
# chat message). The signature is the ONLY thing authorising the download.
DOCUMENT_LINK_SECRET="$(rand_url)"
ENCRYPTION_MASTER_KEY="$(rand_base64)"
ENCRYPTION_SALT_BASE64="$(rand_base64)"
LISTEN_FIRE_TEAM_ID="$(new_uuid)"
LISTEN_FIRE_USER_ID="$(new_uuid)"
PUBLIC_USER_ID="$(new_uuid)"
LISTEN_FIRE_API_KEY="lf_$(rand_url)"
TEAM_NAME="$(sq "${LISTEN_FIRE_TEAM_NAME:-Acme}")"
ADMIN_EMAIL="$(sq "${LISTEN_FIRE_ADMIN_EMAIL:-admin@listen-fire.local}")"
DB="postgresql://listenfire:${POSTGRES_PASSWORD}@postgres:5432/listenfire"

# postgres_password first: DATABASE_URL above already has the raw password
# baked in, so writing this file's existence has no bearing on the
# idempotency gate — generated.env, written last, is that gate.
printf '%s' "$POSTGRES_PASSWORD" > "$PGPASS_FILE.tmp"
mv "$PGPASS_FILE.tmp" "$PGPASS_FILE"

cat > "$TARGET.tmp" <<EOF
# Generated on first boot. NEVER edit or regenerate these — rotating
# ENCRYPTION_MASTER_KEY or ENCRYPTION_SALT_BASE64 makes every stored credential
# unreadable, and rotating TOKEN_SECRET signs everybody out. Back this volume up.
POSTGRES_PASSWORD='${POSTGRES_PASSWORD}'
DATABASE_URL='${DB}'
DATABASE_URL_READONLY='${DB}'
TOKEN_SECRET='${TOKEN_SECRET}'
SESSION_JWT_AUDIENCE='listen-fire-self-host'
ASKS_WEBHOOK_SIGNING_SECRET='${ASKS_WEBHOOK_SIGNING_SECRET}'
DOCUMENT_LINK_SECRET='${DOCUMENT_LINK_SECRET}'
ENCRYPTION_MASTER_KEY='${ENCRYPTION_MASTER_KEY}'
ENCRYPTION_SALT_BASE64='${ENCRYPTION_SALT_BASE64}'
LISTEN_FIRE_TEAM_ID='${LISTEN_FIRE_TEAM_ID}'
LISTEN_FIRE_TEAM_NAME='${TEAM_NAME}'
LISTEN_FIRE_USER_ID='${LISTEN_FIRE_USER_ID}'
LISTEN_FIRE_API_KEY='${LISTEN_FIRE_API_KEY}'
PUBLIC_USER_ID='${PUBLIC_USER_ID}'
LISTEN_FIRE_BOOTSTRAP_TEAM_NAME='${TEAM_NAME}'
LISTEN_FIRE_BOOTSTRAP_USER_EMAIL='${ADMIN_EMAIL}'
EOF
mv "$TARGET.tmp" "$TARGET"

echo "[init] wrote $TARGET (team ${LISTEN_FIRE_TEAM_ID})"
