#!/usr/bin/env bash
# Package the Builder skill: skill-src/ -> public/listen-fire-builder.skill (a zip),
# and -> plugins/listen-fire-builder/skills/listen-fire-builder/SKILL.md (the Claude Code
# plugin). One source, two consumers — never hand-edit either output.
#
# The shipped .skill artifact is a ZIP, so its contents are invisible to grep,
# to code review, and to any sweep of "what do we tell agents". That cost us:
# a mandatory rehearse-before-live instruction lived in here for weeks,
# shaping every agent's behaviour, while a search of the tree said we had no
# such guidance anywhere. The source is checked in beside it now — edit
# skill-src/, run this, commit everything it touches (including the plugin
# copy, so it stays greppable and reviewable in the same PR).
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="skill-src"
OUT="public/listen-fire-builder.skill"
PLUGIN_SKILL_SRC="$SRC/listen-fire-builder/SKILL.md"
PLUGIN_SKILL_OUT="../../plugins/listen-fire-builder/skills/listen-fire-builder/SKILL.md"

[ -d "$SRC/listen-fire-builder" ] || { echo "missing $SRC/listen-fire-builder" >&2; exit 1; }

rm -f "$OUT"
# -X drops extra file attributes so the zip is reproducible across machines.
( cd "$SRC" && zip -qrX "../$OUT" listen-fire-builder )
echo "built $OUT from $SRC/"
unzip -l "$OUT"

mkdir -p "$(dirname "$PLUGIN_SKILL_OUT")"
# Plain copy — the published plugin carries no trace of how it's generated
# (ruling 2026-08-06); THIS script is the only place that records the
# plugin SKILL.md must never be hand-edited.
cp "$PLUGIN_SKILL_SRC" "$PLUGIN_SKILL_OUT"
echo "built $PLUGIN_SKILL_OUT from $SRC/"
