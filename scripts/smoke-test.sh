#!/bin/sh
# Starts a throwaway server and drives pb against it, including self-update from a fake release. Needs Node 18+ and curl.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK=$(mktemp -d)
PORT=${PB_TEST_PORT:-4797}
REL=$((PORT + 1))
BASE="http://127.0.0.1:$PORT"
PIDS=""
trap 'kill $PIDS 2>/dev/null || true; rm -rf "$WORK"' EXIT
export XDG_CONFIG_HOME="$WORK/config"

check() { # <what> <command...>
	what=$1; shift
	if "$@" >"$WORK/out" 2>&1; then echo "ok   $what"; else echo "FAIL $what"; cat "$WORK/out"; exit 1; fi
}
has() { # <what> <text>
	if grep -q -- "$2" "$WORK/out"; then echo "ok   $1"; else echo "FAIL $1: no \"$2\" in:"; cat "$WORK/out"; exit 1; fi
}

for f in "$ROOT"/server.js "$ROOT"/lib/*.js "$ROOT"/public/*.js; do node --check "$f"; done
cp "$ROOT/bin/pb" "$WORK/pb.check.js" && node --check "$WORK/pb.check.js" && rm "$WORK/pb.check.js"

PB_AUTH=off PB_HOST=127.0.0.1 PB_PORT=$PORT PB_DATA="$WORK/data" PB_PUBLIC_URL=$BASE node "$ROOT/server.js" >"$WORK/server.log" 2>&1 &
PIDS="$!"
i=0; until curl -fsS "$BASE/api/health" >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 50 ] || { cat "$WORK/server.log"; exit 1; }; sleep 0.1; done

check "install" sh -c "curl -fsSL $BASE/install | sh -s -- $WORK/bin"
PB="$WORK/bin/pb"
mkdir -p "$WORK/repo/sub"; cd "$WORK/repo"
check "stamped with its server" grep -q "^const DEFAULT_SERVER = '$BASE';" "$PB"
check "ensure" "$PB" ensure
check "register" "$PB" register demo --name Demo --path "$WORK/repo"
check "add a task" "$PB" add --title "first task"
check "pb use" "$PB" use "$BASE" --project demo
cd sub
check "tasks from a subfolder" "$PB" tasks
has "the task is listed" "first task"
check "where" "$PB" where
has "marker chosen" ".project-boards.json"
cd ..

# A newer pb, released with its server line empty like the real one.
NEW=9.9.9
mkdir -p "$WORK/rel"
sed "s/^const VERSION = '.*';/const VERSION = '$NEW';/" "$ROOT/bin/pb" >"$WORK/rel/pb"
(cd "$WORK/rel" && sha256sum pb >pb.sha256)
cat >"$WORK/rel/latest" <<JSON
{"tag_name":"v$NEW","html_url":"http://x/","body":"new things",
 "assets":[{"name":"pb","browser_download_url":"http://127.0.0.1:$REL/pb"},{"name":"pb.sha256","browser_download_url":"http://127.0.0.1:$REL/pb.sha256"}]}
JSON
node -e "require('http').createServer((q,r)=>{try{r.end(require('fs').readFileSync('$WORK/rel'+q.url))}catch{r.statusCode=404;r.end()}}).listen($REL,'127.0.0.1')" &
PIDS="$PIDS $!"
sleep 0.5
export PB_RELEASES_URL="http://127.0.0.1:$REL/latest"
check "self-update --check" "$PB" self-update --check
has "offers the release" "pb $NEW is available"
check "no terminal: stops" sh -c "\"$PB\" self-update </dev/null"
has "asks for approval" "Ask the user"
check "not installed yet" sh -c "\"$PB\" version --local | grep -qv $NEW"
echo tampered >>"$WORK/rel/pb"
if "$PB" self-update --yes >"$WORK/out" 2>&1; then echo "FAIL a bad checksum was accepted"; exit 1; fi
has "bad checksum refused" "does not match"
sed -i '$d' "$WORK/rel/pb"
check "self-update --yes" "$PB" self-update --yes
check "now the new version" sh -c "\"$PB\" version --local | grep -q $NEW"
check "kept its home server" grep -q "^const DEFAULT_SERVER = '$BASE';" "$PB"
check "pb still runs" "$PB" tasks
echo "all passed"
