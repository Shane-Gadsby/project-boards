# Data model and storage

Everything is plain JSON files under `data/` on the server (`the configured data folder`). Only the
server process writes them; it loads them all at start and keeps them in memory.

```
data/
  rules.json                      the global rules
  watchers.json                   who is waiting on which tasks (dependency checks with a `from`)
  auth-admin.json                 the password hash and the login mode (written by bin/pb-admin and the Access dialog)
  auth.json                       browser sessions and app tokens (hashes only; written by the server)
  shares.json                     docs' public share links: {token: {slug, id, created}}
  projects/<slug>/
    project.json                  settings
    tasks/<id>.json               one file per task
    handoffs/<id>.json            one file per hand-off
    docs/<id>.json                one file per doc: its current version, content included
    docs/<id>.history.jsonl       the doc's last 50 versions, one JSON line each (content included)
    media/<time>-<name>           uploaded screenshots and videos
    events.jsonl                  every change, one JSON object per line, append-only
```

Each write goes to `<file>.tmp-<pid>` and is renamed over the target, so a crash never leaves half a file. A file that
does not parse at start is skipped with a message in the log, and the rest load. Ids are used as file names with any
character outside `A-Za-z0-9._-` replaced by `_`.

## Project

`project.json`:

| Field | Type | Meaning |
|---|---|---|
| `slug` | string | Id, `^[a-z0-9][a-z0-9-]{0,62}$`; the folder name. |
| `name`, `description` | string | Shown on the page. |
| `path` | string | The project's folder on the client machines; `pb` matches it against the current directory. |
| `maxSubagents` | 0-10 | Sub-agents a session may run at once (default 0). |
| `lanes` | `[{id, name}]` | Hand-off columns; empty for one list. |
| `banner` | string | One line under the top bar. |
| `busy` | `{"<lane>|all": {text, since}}` | "Claude is using this" strips. |
| `created`, `updated`, `version` | | Bookkeeping. |

`project-boards` is created at start if missing: the board's own project (format requests).

## Task

`tasks/<id>.json`:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Assigned as the next number after the highest numeric prefix when omitted. |
| `title` | string | One line. |
| `state` | string | Free text from the project ("ready-for-integration (results in ...)"). Its first word picks the column. |
| `status` | `todo` \| `active` \| `done` | The column: Not started, Being worked on, Complete. |
| `statusLocked` | bool | `status` was set explicitly and no longer follows `state`. |
| `owner`, `claimed`, `branch`, `results`, `needs`, `priority`, `source`, `summary` | string | Shown on the card or in the drawer. |
| `file` | string | Path of the task's spec file (set by `import-md`). |
| `body` | string | Markdown details (for `import-md`: the file without its title and header lines). |
| `tags` | string[] | e.g. `format-request`. |
| `log` | `[{at, by, text}]` | Notes appended with `note`. |
| `created`, `updated`, `version` | | Bookkeeping. |

Not stored, added when tasks are read: `neededBy` (`[{from, ref, why, until, first, lastCheck}]`, only when another
project is waiting on the task; see [Watchers](#watchers)).

### Status (columns)

`lib/status.js` lower-cases the state, takes its first word (split at spaces, commas, semicolons, colons and `(`), and
strips markdown characters:

| First word | Column |
|---|---|
| done, integrated, merged, closed, complete, completed, finished, resolved, shipped, wontfix, won't-fix, cancelled, canceled, superseded, abandoned, retired, dropped, duplicate | `done` (Complete) |
| claimed, in-progress, inprogress, in, working, active, ready-for-integration, ready, review, in-review, integrating, verifying, testing, started, wip, doing, running | `active` (Being worked on) |
| anything else (open, todo, blocked, deferred, reopened, ...) | `todo` (Not started) |

A task in Complete also has a **resolution** (`resolutionOf` in `lib/status.js`, reported by dependency checks):
`dropped` when the first word is wontfix, won't-fix, cancelled, canceled, superseded, abandoned, retired, dropped or
duplicate, else `completed`. A project waiting on a dropped task is told so instead of being told it is done.

## Hand-off

`handoffs/<id>.json`:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Made from the title when omitted (`fog-default`, `fog-default-2`...). |
| `kind` | `choice` \| `text` \| `look` \| `steps` \| `info` \| `message` | See below. |
| `title`, `question`, `context` | string | What is asked and why. |
| `choices` | `[{label, detail}]` | Buttons (`choice`, `look`). |
| `default` | string | The label Claude will go with if the user accepts defaults. |
| `media` | `[{url, kind: image|video, caption}]` | Screenshots and videos (`look`). URLs are usually `/media/<slug>/<file>`; imported history may have an empty URL. |
| `steps` | `[{do, expect}]` | The checklist (`steps`). |
| `lane` | string | Lane id, if the project has lanes. |
| `order` | number | Sort key (creation time by default). |
| `visible` | bool | `false` hides it from Waiting (Dismiss, `ack --hide`). |
| `source`, `ref`, `tags` | | Where it came from. |
| `answer` | string | The user's choice or typed answer. For `steps`, set to `all good` or `needs attention` once every step is answered. |
| `note` | string | The user's note. |
| `stepAnswers` | `{"<index>": {state: good|blocked|work|null, note, at}}` | Per-step answers (`steps`). |
| `answeredAt`, `userUpdatedAt` | time | When the user last answered or edited a note. Clearing everything removes `answeredAt` and moves `userUpdatedAt`. |
| `ackedAt`, `ackNote` | time, string | When Claude acknowledged it, and what it said. |
| `created`, `updated`, `version` | | Bookkeeping. |

Kinds: `choice` (buttons + note), `text` (typed answer + note), `look` (media + buttons + note; must have media),
`steps` (hands-on checklist, each step good / blocked / needs work + note), `info` (a notice; Dismiss hides it),
`message` (written by the user from the page's message box).

### Derived state and the inbox

| State | When | Where on the page |
|---|---|---|
| `pending` | the user has not answered, or has cleared everything they said (for `info`: not acknowledged) | Waiting for you |
| `answered` | `userUpdatedAt` is set and later than `ackedAt` (or there is no `ackedAt`); a `message` until acknowledged | Answered: Claude has not picked these up yet |
| `acted` | `ackedAt` is at or after `userUpdatedAt` | Done |

**Inbox** = every hand-off with `userUpdatedAt` later than `ackedAt`. An answer changed after Claude acknowledged it
re-enters the inbox, and so does one the user cleared: the hand-off is `pending` again but stays in the inbox, with
nothing in it, until acknowledged, because the session may be acting on the old answer. `pb` prints these as
`[withdrawn]`. (This replaced a `told` flag that the old artifact pages set when the user answered, which hid new
answers from sessions that filtered on it.)

## Rules

`data/rules.json`: `{rules: [{id, text}], updated, version, by}`. Created with the two default rules (screenshots for
visual A/B, videos for anything over time) when missing.

## Watchers

`data/watchers.json`: `{"<project>": {"<selector>": {"<from>": {why, until, first, lastCheck}}}}`, where the selector is
a task id, `tag:<tag>` or `*`. A dependency check (`/api/deps`) with a `from` adds or refreshes an entry; the file is
rewritten when an entry is new or its `why`/`until` changed, and otherwise at most every 10 minutes (so `lastCheck` can
lag by that much after a restart). Entries not checked for 30 days stop showing in `neededBy`; `DELETE /api/deps`
removes one. Watchers of `*` never show on a task. Losing the file loses only who is waiting, and the next checks
rebuild it.

## Doc

`docs/<id>.json`: `{id, title, format, language, summary, tags, content, size, source, created, createdBy, updated,
updatedBy, version, userUpdatedAt?, seenAt?, share?}` (fields in [api.md](api.md#docs)). `<id>.history.jsonl` lines:
`{version, at, by, note, title, format, language, content}`, appended on every save and trimmed to the last 50.

## Logins

`auth-admin.json`: `{password: {algo: "scrypt", N, r, p, salt, hash, set}, mode: "off"|"optional"|"required"}`. `set`
is when the password last changed; sessions created before it are invalid.

`auth.json`: `{sessions: {<id>: {hash, created, lastUsed, lastIp, agent}}, tokens: {<id>: {hash, name, client, machine,
project, via: "device"|"page", created, lastUsed, lastIp}}}`. `id` is 16 hex characters, `hash` the SHA-256 of the
secret part (`<id>.<secret>` in the cookie, `pbt_<id>_<secret>` as a token). Deleting the file signs everything out;
deleting `auth-admin.json` removes the password and returns the mode to `optional`.

## Events

`events.jsonl` lines: `{seq, at, type, action, actor, id?, record?}`, the same objects the page receives live.
`seq` restarts at 0 when the server restarts. The file grows forever; it is history, not state, and can be truncated or
rotated while the server runs.

## Backup and restore

Copy `data/` (with the server running is fine: every file is written whole by rename). To restore, stop the app
(`systemctl stop project-boards`, or however you run it), put the folder back, start it again.
