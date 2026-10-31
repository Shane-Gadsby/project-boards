#!/bin/sh
# Builds dist/project-boards-<version>.tar.gz, the bundle for a new server. It carries the code and the generic
# documents only, never data or logs.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(sed -n "s/^const VERSION = '\(.*\)';$/\1/p" "$ROOT/server.js")
NAME="project-boards-$VERSION"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
D="$WORK/$NAME"
mkdir -p "$D/bin" "$D/docs" "$D/packaging"
cp -r "$ROOT/server.js" "$ROOT/lib" "$ROOT/public" "$ROOT/LICENSE" "$D/"
cp "$ROOT/bin/pb" "$ROOT/bin/pb-admin" "$D/bin/"
cp "$ROOT/docs/install-rhel.md" "$D/docs/"
cp -r "$ROOT/packaging/rhel" "$D/packaging/"
cp "$ROOT/packaging/rhel/install.sh" "$D/install.sh"
printf '%s\n' "$VERSION" > "$D/VERSION"
rm -f "$D/packaging/rhel/install.sh"
# Optional local check: .dist-deny (git-ignored) lists words, one extended regex per line, that must not ship.
if [ -f "$ROOT/.dist-deny" ] && grep -rIlE -f "$ROOT/.dist-deny" "$D"; then
	echo "make-dist: the files above match .dist-deny" >&2
	exit 1
fi
mkdir -p "$ROOT/dist"
tar -C "$WORK" -czf "$ROOT/dist/$NAME.tar.gz" --owner=0 --group=0 "$NAME"
(cd "$ROOT/dist" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "$ROOT/dist/$NAME.tar.gz"
