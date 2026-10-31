#!/bin/sh
# Prints CHANGELOG.md's section for a version.
set -eu
awk -v v="## $1 " 'index($0, v) == 1 { on = 1; next } /^## / { on = 0 } on' "$(dirname "$0")/../CHANGELOG.md" | sed -e '/./,$!d'
