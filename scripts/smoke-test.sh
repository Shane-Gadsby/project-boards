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
sh -n "$ROOT/packaging/rhel/install.sh"
sh -n "$ROOT/packaging/rhel/install-server.sh"
cp "$ROOT/bin/pb" "$WORK/pb.check.js" && node --check "$WORK/pb.check.js" && rm "$WORK/pb.check.js"

PB_AUTH=off PB_HOST=127.0.0.1 PB_PORT=$PORT PB_DATA="$WORK/data" PB_PUBLIC_URL=$BASE node "$ROOT/server.js" >"$WORK/server.log" 2>&1 &
PIDS="$!"
i=0; until curl -fsS "$BASE/api/health" >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 50 ] || { cat "$WORK/server.log"; exit 1; }; sleep 0.1; done

check "install" sh -c "curl -fsSL $BASE/install | sh -s -- $WORK/bin"
PB="$WORK/bin/pb"
check "windows installer" sh -c "curl -fsSL $BASE/install.ps1 | grep -qF \"\$Base = '$BASE'\""
check "windows install command" sh -c "curl -fsSL $BASE/api/pb | grep -qF 'irm $BASE/install.ps1 | iex'"
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
# Archive and delete.
unset PB_RELEASES_URL
J='Content-Type: application/json'
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
same() { # <what> <want> <got>
	if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: wanted $2, got $3"; exit 1; fi
}
cd "$WORK/repo"
check "add a project to remove" "$PB" register gone --name Gone
same "share a doc" 201 "$(code -X POST "$BASE/api/projects/gone/docs" -H "$J" -d '{"id":"d","title":"D","format":"text","content":"x"}')"
check "archive" "$PB" archive --project gone
check "hidden from the list" sh -c "! \"$PB\" projects | grep -q '^gone'"
check "listed with --all" sh -c "\"$PB\" projects --all | grep -q 'archived.*gone'"
if "$PB" add --title nope --project gone >"$WORK/out" 2>&1; then echo "FAIL wrote to an archived project"; exit 1; fi
has "writes refused" "is archived"
same "still readable" 200 "$(code "$BASE/api/projects/gone/tasks")"
check "restore" "$PB" unarchive --project gone
check "writes work again" "$PB" add --title back --project gone
same "delete refused without the user" 403 "$(code -X DELETE "$BASE/api/projects/gone" -H "$J" -d '{"confirm":"gone"}')"
same "delete refused without the slug" 400 "$(code -X DELETE "$BASE/api/projects/gone" -H "$J" -H 'X-PB-Actor: user' -d '{"confirm":"nope"}')"
same "own project cannot go" 400 "$(code -X DELETE "$BASE/api/projects/project-boards" -H "$J" -H 'X-PB-Actor: user' -d '{"confirm":"project-boards"}')"
same "delete" 200 "$(code -X DELETE "$BASE/api/projects/gone" -H "$J" -H 'X-PB-Actor: user' -d '{"confirm":"gone"}')"
same "gone" 404 "$(code "$BASE/api/projects/gone")"
check "its folder is gone" sh -c "[ ! -e \"$WORK/data/projects/gone\" ]"
same "updates need a signed-in browser" 401 "$(code "$BASE/api/update" -H 'X-PB-Actor: user')"
same "and so does installing one" 401 "$(code -X POST "$BASE/api/update" -H "$J" -H 'X-PB-Actor: user' -d '{"version":"9.9.9"}')"

# pb hook: a working session is told about a message, once; installing it writes the project's local settings.
cd "$WORK/repo"
curl -fsS -X POST "$BASE/api/projects/demo/message" -H "$J" -H 'X-PB-Actor: user' -d '{"text":"hook test"}' >/dev/null
check "hook after a tool call" sh -c "echo '{\"session_id\":\"t1\",\"hook_event_name\":\"PostToolUse\"}' | \"$PB\" hook"
has "it passes the message on" "hook test"
check "hook again" sh -c "echo '{\"session_id\":\"t1\",\"hook_event_name\":\"Stop\"}' | \"$PB\" hook > \"$WORK/hook2\""
check "told only once" sh -c "[ ! -s \"$WORK/hook2\" ]"
# A hands-on set reaches the inbox only once every step has an answer.
check "ask a set" "$PB" ask --id set --title "Set" --question "Try" --step "one|ok" --step "two|ok"
curl -fsS -X POST "$BASE/api/projects/demo/handoffs/set/answer" -H "$J" -H 'X-PB-Actor: user' -d '{"step":0,"state":"good"}' >/dev/null
check "half a set" sh -c "\"$PB\" inbox > \"$WORK/inbox1\"; ! grep -q '] set ' \"$WORK/inbox1\""
curl -fsS -X POST "$BASE/api/projects/demo/handoffs/set/answer" -H "$J" -H 'X-PB-Actor: user' -d '{"step":1,"state":"good"}' >/dev/null
check "the whole set" "$PB" inbox
has "is in the inbox" "] set "
check "hook install" "$PB" hook install
check "settings written" grep -q '" hook"' "$WORK/repo/.claude/settings.local.json"

# Reports and ingest keys: a key can only add reports, to its own project, and nothing else.
cd "$WORK/repo"
check "make an ingest key" sh -c "\"$PB\" key new --name 'beta build' > \"$WORK/key.out\""
KEY=$(grep -o 'pbk_[A-Za-z0-9_-]*' "$WORK/key.out" | head -1)
check "the key is printed once" sh -c "[ -n \"$KEY\" ]"
check "listed without its secret" sh -c "\"$PB\" keys | grep -q 'beta build'; ! \"$PB\" keys | grep -q \"$KEY\""
same "the key checks out" 200 "$(code "$BASE/api/ingest" -H "Authorization: Bearer $KEY")"
same "a report arrives" 201 "$(code -X POST "$BASE/api/ingest" -H "$J" -H "Authorization: Bearer $KEY" -d '{"title":"Crash","kind":"crash","app":"Demo","data":{"a":1}}')"
same "a made-up key is refused" 401 "$(code -X POST "$BASE/api/ingest" -H "$J" -H 'Authorization: Bearer pbk_0000000000000000_aaaaaaaaaaaaaaaaaaaaaa' -d '{}')"
same "a key cannot read tasks" 403 "$(code "$BASE/api/projects/demo/tasks" -H "Authorization: Bearer $KEY")"
same "a key cannot read reports" 403 "$(code "$BASE/api/projects/demo/reports" -H "Authorization: Bearer $KEY")"
same "a key cannot make keys" 403 "$(code -X POST "$BASE/api/projects/demo/keys" -H "$J" -H "Authorization: Bearer $KEY" -d '{"name":"no"}')"
check "the report is listed" "$PB" reports
has "with its title" "Crash"
RID=$(sed -n '1s/ .*//p' "$WORK/out")
check "read it in full" sh -c "\"$PB\" report $RID"
has "with its payload" '"a": 1'
check "triage it" sh -c "\"$PB\" report done $RID"
check "and it is done" sh -c "! \"$PB\" reports --status new | grep -q $RID"
KID=$("$PB" keys | sed -n '1s/ .*//p')
check "rotate the key" sh -c "\"$PB\" key rotate $KID > \"$WORK/key2.out\""
same "the old key stops working" 401 "$(code -X POST "$BASE/api/ingest" -H "$J" -H "Authorization: Bearer $KEY" -d '{"title":"no"}')"
KEY2=$(grep -o 'pbk_[A-Za-z0-9_-]*' "$WORK/key2.out" | head -1)
same "the new one works" 201 "$(code -X POST "$BASE/api/ingest" -H "$J" -H "Authorization: Bearer $KEY2" -d '{"title":"after rotating"}')"
check "revoke it" "$PB" key revoke "$KID"
same "and it is refused" 401 "$(code -X POST "$BASE/api/ingest" -H "$J" -H "Authorization: Bearer $KEY2" -d '{"title":"no"}')"
check "what's new reads" sh -c "curl -fsS $BASE/whatsnew | grep -q 'ingest key'"

# A sub-path, alongside the root.
SUB=$((PORT + 2))
PB_AUTH=off PB_HOST=127.0.0.1 PB_PORT=$SUB PB_DATA="$WORK/data2" PB_BASE_PATH=/projects node "$ROOT/server.js" >"$WORK/sub.log" 2>&1 &
PIDS="$PIDS $!"
i=0; until curl -fsS "http://127.0.0.1:$SUB/projects/api/health" >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 50 ] || exit 1; sleep 0.1; done
check "page under the sub-path" sh -c "curl -fsS http://127.0.0.1:$SUB/projects/ | grep -q 'src=\"/projects/app.js\"'"
check "page at the root" sh -c "curl -fsS http://127.0.0.1:$SUB/ | grep -q 'src=\"/app.js\"'"
check "assets under the sub-path" curl -fsS "http://127.0.0.1:$SUB/projects/app.js"
mkdir -p "$WORK/subrepo"; cd "$WORK/subrepo"
check "pb use with a sub-path" "$PB" use "http://127.0.0.1:$SUB/projects" --project sub
check "register there" "$PB" register sub --name Sub --path "$WORK/subrepo"
check "add a task there" "$PB" add --title "sub task"
check "list it" "$PB" tasks
has "the task is listed" "sub task"
echo "all passed"
