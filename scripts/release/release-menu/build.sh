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
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$here/Info.plist" "$app/Contents/Info.plist"
plutil -insert LFRepositoryPath -string "$repo" "$app/Contents/Info.plist"
iconset="$(mktemp -d)/AppIcon.iconset"
swiftc -O -swift-version 5 -framework AppKit "$here/make-icon.swift" -o "${iconset%/*}/make-icon"
"${iconset%/*}/make-icon" "$iconset"
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
swiftc -O -swift-version 5 -framework AppKit "$here/ReleaseMenu.swift" -o "$app/Contents/MacOS/lf-release"
codesign --force --sign - "$app"
# Finder and Spotlight cache icons per bundle, so make them look again.
touch "$app"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
echo "built $app (scripts from $repo)"
