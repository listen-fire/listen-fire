#!/usr/bin/env bash
# Lets .github/workflows/npm-stage.yml stage the given packages: sets each one's
# npm trusted publisher (this repository, that workflow file, staging allowed).
# Run it in your own terminal, just before a release; the first call asks for 2FA.
#   scripts/release/trust-npm-packages.sh                  the packages whose name@version is not on npm yet
#   scripts/release/trust-npm-packages.sh <package>...     those packages
#   scripts/release/trust-npm-packages.sh --dry-run ...    pass --dry-run to npm; change nothing
# A package that already has a trusted publisher for the workflow is skipped.
# `npm trust` needs npm 11.15.0 or later, newer than most machines carry, so
# the script runs the pinned npm the workflow uses. A new trust config expires
# unless its first successful publish comes within 2 days, so run this per
# release, not once.
set -euo pipefail

cd "$(dirname "$0")/../.."

repo=listen-fire/listen-fire
workflow=npm-stage.yml
npm=(npx -y npm@11.21.2)

dry_run=()
packages=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=(--dry-run) ;;
    -*) echo "usage: $0 [--dry-run] [package...]" >&2; exit 2 ;;
    *) packages+=("$arg") ;;
  esac
done

if [ ${#packages[@]} -eq 0 ]; then
  while IFS= read -r name; do packages+=("$name"); done < <(node scripts/release/stage-npm-packages.mjs --list)
fi
if [ ${#packages[@]} -eq 0 ]; then
  echo "nothing to trust: every version is already on npm"
  exit 0
fi

for package in "${packages[@]}"; do
  if "${npm[@]}" trust list "$package" 2>/dev/null | grep -qF "$workflow"; then
    echo "skipped (already trusted): $package"
    continue
  fi
  echo "trusting: $package"
  "${npm[@]}" trust github "$package" --file "$workflow" --repo "$repo" --allow-stage-publish -y ${dry_run[@]+"${dry_run[@]}"}
  sleep 2
done
