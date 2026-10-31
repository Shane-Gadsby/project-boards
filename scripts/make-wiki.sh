#!/bin/sh
# Builds the GitHub wiki from docs/: scripts/make-wiki.sh <checkout of the .wiki.git repo>
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
OUT=${1:?usage: make-wiki.sh <wiki checkout>}
page() { # <doc> <wiki page>
	sed -E \
		-e 's/\]\(docs\//](/g' \
		-e 's/\]\(user-guide\.md/](User-Guide/g' \
		-e 's/\]\(claude-sessions\.md/](Claude-Sessions/g' \
		-e 's/\]\(api\.md/](HTTP-API/g' \
		-e 's/\]\(data-model\.md/](Data-Model/g' \
		-e 's/\]\(operations\.md/](Operations/g' \
		-e 's/\]\(architecture\.md/](Architecture/g' \
		-e 's/\]\(install-rhel\.md/](Install-on-RHEL/g' \
		-e 's#\]\(CHANGELOG\.md\)#](https://github.com/Shane-Gadsby/project-boards/blob/production/CHANGELOG.md)#g' \
		-e 's#\]\(LICENSE\)#](https://github.com/Shane-Gadsby/project-boards/blob/production/LICENSE)#g' \
		"$1" >"$OUT/$2.md"
}
page "$ROOT/README.md" Home
page "$ROOT/docs/user-guide.md" User-Guide
page "$ROOT/docs/claude-sessions.md" Claude-Sessions
page "$ROOT/docs/api.md" HTTP-API
page "$ROOT/docs/data-model.md" Data-Model
page "$ROOT/docs/operations.md" Operations
page "$ROOT/docs/architecture.md" Architecture
page "$ROOT/docs/install-rhel.md" Install-on-RHEL
cat >"$OUT/_Sidebar.md" <<'MD'
- [Home](Home)
- [User guide](User-Guide)
- [For Claude sessions](Claude-Sessions)
- [HTTP API](HTTP-API)
- [Data model](Data-Model)
- [Operations](Operations)
- [Install on RHEL](Install-on-RHEL)
- [Architecture](Architecture)
MD
