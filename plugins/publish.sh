#!/usr/bin/env bash
# Sync the generated plugins/ staging dir into the standalone PUBLIC repo
# checkout, so publishing never involves the monorepo's git history. The
# public checkout is its own repo (fresh history); commit and push there.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/src/listen-fire-claude-plugins}"

if [ ! -d "$DEST/.git" ]; then
  echo "error: $DEST is not a git checkout (pass the public repo path as \$1)" >&2
  exit 1
fi

rsync -a --delete --exclude .git --exclude publish.sh "$SRC/" "$DEST/"

echo "Synced $SRC -> $DEST"
echo "Next: cd $DEST && git add -A && git commit && git push"
git -C "$DEST" status --short
