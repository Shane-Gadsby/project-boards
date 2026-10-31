'use strict';

// GET /install: a shell script that downloads pb from this server, checks it against the published sha256 and puts it
// in a folder (default ~/.local/share/project-boards, or the folder given as its first argument).
function installScript({ base }) {
	return `#!/bin/sh
# Installs the Project Boards command line (pb) from ${base}.
#   curl -fsSL ${base}/install | sh                     # -> ~/.local/share/project-boards/pb
#   curl -fsSL ${base}/install | sh -s -- /some/folder  # -> /some/folder/pb
# Needs Node.js 18 or newer and curl. Run it again (or \`pb upgrade\`) to update.
set -eu
BASE='${base}'
DIR="\${1:-\${PB_INSTALL_DIR:-$HOME/.local/share/project-boards}}"

command -v node >/dev/null 2>&1 || { echo "pb needs Node.js 18 or newer; node was not found" >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' \\
	|| { echo "pb needs Node.js 18 or newer; found $(node --version)" >&2; exit 1; }

mkdir -p "$DIR"
TMP="$DIR/.pb.download.$$"
trap 'rm -f "$TMP"' EXIT
curl -fsSL "$BASE/pb" -o "$TMP"
WANT=$(curl -fsSL "$BASE/api/pb" | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).sha256))')
GOT=$(node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$TMP")
if [ "$WANT" != "$GOT" ]; then
	echo "the download does not match the published checksum (got $GOT, expected $WANT); run the installer again" >&2
	exit 1
fi
chmod 755 "$TMP"
mv -f "$TMP" "$DIR/pb"
trap - EXIT

echo "Installed $("$DIR/pb" version --local) at $DIR/pb"
echo "Next: $DIR/pb login    (opens a browser tab where the board's owner approves this machine)"
`;
}

module.exports = { installScript };
