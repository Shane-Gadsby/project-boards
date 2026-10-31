#!/bin/sh
# Installs or upgrades a Project Boards server from the latest GitHub release, as root:
#   curl -fsSL https://github.com/Shane-Gadsby/project-boards/releases/latest/download/install-server.sh | sh
# PB_VERSION picks a version. NODE picks the Node.js to use. Safe to run again.
set -eu

main() {
	REPO=${PB_REPO_URL:-https://github.com/Shane-Gadsby/project-boards}
	[ "$(id -u)" = 0 ] || { echo "run this as root" >&2; exit 1; }
	for tool in curl tar sha256sum; do
		command -v "$tool" >/dev/null 2>&1 || { echo "$tool is needed" >&2; exit 1; }
	done

	if [ -n "${PB_VERSION:-}" ]; then
		VERSION=${PB_VERSION#v}
	else
		LATEST=$(curl -fsSIL -o /dev/null -w '%{url_effective}' "$REPO/releases/latest")
		VERSION=${LATEST##*/v}
	fi
	case "$VERSION" in
		[0-9]*.[0-9]*.[0-9]*) ;;
		*) echo "could not find the latest release at $REPO" >&2; exit 1 ;;
	esac

	NAME="project-boards-$VERSION"
	WORK=$(mktemp -d)
	trap 'rm -rf "$WORK"' EXIT
	echo "Downloading Project Boards $VERSION"
	curl -fsSL "$REPO/releases/download/v$VERSION/$NAME.tar.gz" -o "$WORK/$NAME.tar.gz"
	curl -fsSL "$REPO/releases/download/v$VERSION/$NAME.tar.gz.sha256" -o "$WORK/$NAME.tar.gz.sha256"
	(cd "$WORK" && sha256sum -c --quiet "$NAME.tar.gz.sha256")
	tar -xzf "$WORK/$NAME.tar.gz" -C "$WORK"
	sh "$WORK/$NAME/install.sh"
}

# In a function, so a download cut short cannot run half a script.
main "$@"
