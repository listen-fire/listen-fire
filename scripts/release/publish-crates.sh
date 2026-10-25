#!/usr/bin/env bash
# Publishes each workspace crate whose name@version is not on crates.io yet, in
# dependency order, waiting for the index to carry each before the next (a
# crate that depends on it would otherwise fail to resolve it).
#   scripts/release/publish-crates.sh            publish
#   scripts/release/publish-crates.sh --dry-run  print what it would publish; publish nothing
# A crate already on crates.io is skipped, so a release that moved only
# module-wire or module-kit publishes just those.
set -euo pipefail

cd "$(dirname "$0")/../.."

dry_run=false
case "${1:-}" in
  --dry-run) dry_run=true ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

# Dependency order (RELEASING.md): module-wire before listen-fire, which uses it.
crates=(
  listen-fire-parser
  listen-fire-checker
  listen-fire-language
  listen-fire-engine
  listen-fire-module-wire
  listen-fire
  listen-fire-module-kit
)

# crates.io refuses requests without a User-Agent that says who is asking.
user_agent="listen-fire-release-script (https://github.com/listen-fire/listen-fire)"

on_index() {
  curl -fs -o /dev/null -A "$user_agent" "https://crates.io/api/v1/crates/$1/$2"
}

version_of() {
  cargo metadata --no-deps --format-version 1 |
    node -e 'const m = JSON.parse(require("fs").readFileSync(0, "utf8")); const p = m.packages.find((p) => p.name === process.argv[1]); if (!p) process.exit(1); console.log(p.version)' "$1"
}

for crate in "${crates[@]}"; do
  version=$(version_of "$crate")
  if on_index "$crate" "$version"; then
    echo "skip $crate@$version (on crates.io)"
    continue
  fi
  if $dry_run; then
    echo "would publish $crate@$version"
    continue
  fi
  echo "publish $crate@$version"
  cargo publish -p "$crate"
  # cargo publish returns before the index serves the version.
  for _ in $(seq 1 30); do
    on_index "$crate" "$version" && break
    sleep 10
  done
  on_index "$crate" "$version" || { echo "$crate@$version did not reach the index in 5 minutes" >&2; exit 1; }
done
