#!/bin/sh
# Load the generated secrets, then become the real command.
#
# `env_file` cannot reach into a named volume (the docker CLI reads it on the
# host), so the volume is mounted at /config and sourced HERE instead. Values are
# single-quoted by the generator, so `.` is safe for base64 and for URLs.
set -e

if [ -f /config/generated.env ]; then
  set -a
  . /config/generated.env
  set +a
fi

# The dev-loop harness ids are a SWITCH, not identity. `isTestHarnessTeam` is a
# bare comparison against them — no NODE_ENV gate — and a match rewrites every
# outbound integration credential to the fake-channels URL, so a real install
# that carried them would talk to nothing and say nothing about it. They are
# therefore derived here, per boot, and only when this IS the demo.
#
# The `unset` is not belt-and-braces: an installation whose generated.env was
# written by an older version of the generator still HAS the two lines in it,
# and the `.` above just sourced them. This is what makes those volumes safe.
if [ "${LISTEN_FIRE_DEMO:-0}" = "1" ]; then
  export TEST_HARNESS_TEAM_ID="${LISTEN_FIRE_TEAM_ID:-}"
  export TEST_HARNESS_USER_ID="${LISTEN_FIRE_USER_ID:-}"
else
  unset TEST_HARNESS_TEAM_ID TEST_HARNESS_USER_ID
fi

exec "$@"
