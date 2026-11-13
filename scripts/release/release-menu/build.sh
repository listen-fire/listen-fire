#!/usr/bin/env bash
# Builds ~/Applications/"lf release.app": a menu bar app for the two npm release
# steps (trust before the push, approve after CI stages). It needs only swiftc
# (Command Line Tools). The repository it runs the release scripts from is the one
# this script lives in, written into the app's Info.plist; rebuild after moving it.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
app="$HOME/Applications/lf release.app"

pkill -x lf-release 2>/dev/null || true
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$here/Info.plist" "$app/Contents/Info.plist"
plutil -insert LFRepositoryPath -string "$repo" "$app/Contents/Info.plist"
swiftc -O -swift-version 5 -framework AppKit "$here/ReleaseMenu.swift" -o "$app/Contents/MacOS/lf-release"
codesign --force --sign - "$app"
echo "built $app (scripts from $repo)"
