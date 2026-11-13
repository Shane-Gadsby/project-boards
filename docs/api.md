# HTTP API

Base URL `https://boards.example.com` (through a TLS proxy), or `http://192.0.2.10:4780` directly
on the LAN; the API is the same. JSON in and out (UTF-8), except media uploads (raw bytes), the instruction pages
(markdown) and the pb download. When logins are required, everything except the public routes ([Logins](#logins))
needs `Authorization: Bearer <app token>` or the page's session cookie.

## Conventions

- **Actor.** With logins required, a signed-in browser session acts as the user and everything else as Claude. Otherwise
  a request with header `X-PB-Actor: user` acts as the user (the page sends it). What the user does is what fills the
  inbox and wakes `wait`. Hand-off imports act as `import`. Answers and messages are refused (403) unless from the user.
- **Errors** come back as `{"error": "message"}` with 400 (bad input), 401 (login required, or a bad or revoked token),
  403 (a browser write without `X-PB-Actor`, or not the user), 404 (no such project/record/route), 409 (exists,
  version mismatch, or logins off), 413 (body over 200 MB), 429 (too many wrong passwords or sign-in requests) or 500.
- **`X-PB-CLI-Version`** on every answer: the version of pb the server publishes.
- **Versions.** Every task, hand-off and project has `version`, incremented on each write. Send `ifVersion` in a write
  to fail with 409 instead of overwriting a newer change.
- **Times** are ISO 8601 strings (UTC).
- `{p}` below is `/api/projects/{slug}`.

## Server

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{ok, app: "project-boards", version, port, projects, pid, auth: <mode>, cli: <pb version>}` |
| POST | `/api/status-of` | `{states: ["integrated", ...]}` | `{statuses: ["done", ...]}`: the column each state maps to (for `pb import-md --dry-run`) |
| GET | `/api/rules` | | `{rules: [{id, text}], updated, version, by}` |
| PUT | `/api/rules` | `{rules: ["text", ...]}` (or objects with `text`); empty ones dropped | the new rules; pushed to every open page |
| GET | `/api/format-requests` | | tasks on `project-boards` tagged `format-request` |
| POST | `/api/format-requests` | `{project, name, description, sample?}` (`name`, `description` required; `sample` kept up to 20 000 characters) | 201 `{task, project: "project-boards", url}`; also posts an `info` hand-off on that project |

## Logins

Public in every mode: `/api/health`, `/api/auth/*`, `/api/pb`, `/pb`, `/install`, `/install.ps1`, `/login`, `/login/device`,
`/login.js`, `/style.css`, `/enrol`, `/onboard`, `/deps`, and shared docs (`/s/<token>`, `/api/shared/<token>`, with
`doc.html`, `doc.js`, `render.js`). With the mode `required`, anything else without a valid
credential gets 401 (API, media, non-GET) or a redirect to `/login?next=<path>` (pages).

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/auth/me` | | `{mode, passwordSet, pinned, signedIn, kind: "session"\|"token"\|null, id, name, server, setPassword}` |
| POST | `/api/auth/login` | `{password}` (with `X-PB-Actor`) | `{ok}` and `Set-Cookie: pb_session=...`; 401 wrong password, 429 after 5 wrong per address (30 overall) in 15 min, 409 no password set or logins off |
| POST | `/api/auth/logout` | | `{ok}`; ends this browser's session |
| POST | `/api/auth/device` | `{client, machine, project}` | `{device_code, user_code, verification_uri, verification_uri_complete, expires_in: 600, interval: 3}`; 10 per address per 10 min |
| POST | `/api/auth/token` | `{device_code}` | `{token, id, name}` once approved (handed over once); else 400 `{error}`: `authorization_pending`, `slow_down` (poll less often), `access_denied`, `expired_token` |
| GET | `/api/auth/device/{user_code}` | session | `{user_code, client, machine, project, ip, created, status}` |
| POST | `/api/auth/device/{user_code}/approve`, `/deny` | session | `{status}` |
| GET | `/api/auth/tokens` | session | `{tokens: [{id, name, client, machine, project, via, created, lastUsed, lastIp, current}], sessions: [{id, created, lastUsed, lastIp, agent, current}]}` |
| POST | `/api/auth/tokens` | session; `{name}` | 201 `{token, id, name}`: a token for a script (shown once) |
| DELETE | `/api/auth/tokens/{id}` | session | `{revoked}`: a token or a browser session |
| DELETE | `/api/auth/tokens/self` | token | `{revoked}`: the calling token (`pb logout`) |
| PATCH | `/api/auth/settings` | session; `{mode}` | `{mode}`; 409 when `PB_AUTH` pins it, or `required` without a password |

An app that cannot use pb does the device flow itself: `POST /api/auth/device`, show the user
`verification_uri_complete` (or open it), poll `POST /api/auth/token` every `interval` seconds until it returns a
token, then send `Authorization: Bearer <token>`.

## The pb command line

| Method | Path | Returns |
|---|---|---|
| GET | `/api/pb` | `{version, sha256, size, url, install, installWindows}` |
| GET | `/pb` | the script (`text/javascript`), with `X-Content-SHA256` |
| GET | `/install` | a POSIX shell installer: `curl -fsSL <base>/install \| sh [-s -- <folder>]` |
| GET | `/install.ps1` | a PowerShell installer for Windows: `irm <base>/install.ps1 \| iex` (writes `pb` and `pb.cmd`, adds the folder to the user's PATH) |

## Projects

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/projects` | | every project's settings plus `counts {todo, active, done, inbox, waiting}`, sorted by name |
| POST | `/api/projects` | `{slug, name, path?, description?, lanes?, maxSubagents?}` | 201 the project; 409 if the slug exists. Slug: `^[a-z0-9][a-z0-9-]{0,62}$`. `maxSubagents` defaults to 0. |
| GET | `{p}` | | the project with counts |
| PATCH | `{p}` | any of `name`, `path`, `description`, `banner`, `maxSubagents` (clamped 0-10), `lanes` (array of names or `{id, name}`; ids are slugified), `busy` (`{"<lane>|all": "text"}`; `""` clears that lane) | the project |

| POST | `{p}/archive`, `{p}/unarchive` | | The project, hidden and read-only until restored: writes answer 409. Sessions in `/wait` are woken. |
| DELETE | `{p}` | `{confirm: "<slug>"}` | Permanently removes the project, its media and share links. A signed-in browser only. |

The board's own `project-boards` project cannot be archived or deleted.

## Updates

A signed-in browser only: never an app token, and never with logins turned off.

| | | | |
|---|---|---|---|
| GET | `/api/update` | `?force=1` skips the 10-minute cache | `{current, latest, available, notes, url, mode, status}` |
| POST | `/api/update` | `{version}` | 202 `{started}`. Only the latest release, and only forwards. |

## Tasks

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `{p}/tasks` | `?status=todo\|active\|done`; `&full=1` to include `body` and `log` | array of tasks; a task another project waits on also has `neededBy` ([Dependencies](#dependencies)) |
| POST | `{p}/tasks` | task fields; `id` optional (next number); `title` required | 201 the task; 409 if the id exists |
| POST | `{p}/tasks/import` | `{tasks: [...]}` or an array | `{created, updated, unchanged, errors: [{id, error}]}`. Upserts by `id`; a record whose given fields all equal the stored ones counts as unchanged and is not rewritten. |
| GET | `{p}/tasks/{id}` | | the task, with `body`, `log` and `neededBy` if any |
| PATCH | `{p}/tasks/{id}` | any task fields; `note` appends `{at, by, text}` to `log`; `ifVersion` | the task; 404 if missing |
| PUT | `{p}/tasks/{id}` | as PATCH, creating the task if missing | the task |
| DELETE | `{p}/tasks/{id}` | | `{deleted: id}` |

Column rules: sending `status` sets `statusLocked` and pins the column; sending `state` without `status` re-derives the
column (unless locked); `statusLocked: false` unlocks and re-derives. See [data-model.md](data-model.md#status-columns).

## Hand-offs

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `{p}/handoffs` | `?state=pending\|answered\|acted` | array, each with its derived `state`, sorted by `order` |
| POST | `{p}/handoffs` | hand-off fields; `id` optional (made from the title) | 201 the hand-off |
| POST | `{p}/handoffs/import` | `{handoffs: [...]}` or an array; may carry `answer`, `note`, `stepAnswers`, `answeredAt`, `userUpdatedAt`, `ackedAt`, `ackNote` | `{written, errors}` |
| GET | `{p}/handoffs/{id}` | | the hand-off with `state` |
| PATCH | `{p}/handoffs/{id}` | hand-off fields; `ifVersion` | the hand-off |
| DELETE | `{p}/handoffs/{id}` | | `{deleted: id}` |
| POST | `{p}/handoffs/{id}/answer` | the user's answer: `{answer?, note?}` (`answer: null` clears it), for steps `{step: <index>, state?: "good"\|"blocked"\|"work"\|null, note?}`, or `{clear: true}` for all of it. With nothing left the hand-off is `pending` again and stays in the inbox until acknowledged | the hand-off; always recorded as the user |
| POST | `{p}/handoffs/{id}/ack` | `{note?, hide?}` | the hand-off; sets `ackedAt` (and `ackNote`; `hide` sets `visible: false`) |
| POST | `{p}/message` | `{text, lane?}` | 201 a `message` hand-off from the user |
| GET | `{p}/inbox` | | hand-offs whose `userUpdatedAt` is later than their `ackedAt`, oldest first |
| GET | `{p}/wait` | `?timeout=<s>` (1-3600, default 600), `&fresh=1` | `{woke, timeout?, inbox}`. Answers at once when the inbox is not empty (unless `fresh=1`); otherwise holds the request until the user answers or writes something in this project, or the timeout passes, sending a space every 15 s meanwhile so proxies keep it open (leading whitespace is valid JSON). |

Validation: `kind` must be `choice`, `text`, `look`, `steps`, `info` or `message`; `choices` become `{label, detail}`,
`steps` `{do, expect}`, `media` `{url, kind: image|video, caption}`. A `look` needs at least one media item with a URL
(global rules), except when imported.

## Dependencies

For any project or app, on the board or not, that needs work another project owns. Checking is read-only on the tasks;
it only records who asked (when `from` is given) so the owning project sees it. The full guide, with the `pb` side, is
served at `/deps`.

A **ref** is `<project>/<task id>`, `<project>/tag:<tag>` (every task with that tag) or `<project>/*` (every task);
`#` works in place of `/`. **until** says when a ref counts as met: `done` (default: completed, not dropped), `closed`
(in Complete, dropped included), `active` (started or finished), or a state word such as `ready-for-integration` (that
first word, or completed). A ref is met when it matches at least one task and every matched task is met.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/deps` | `?ref=<ref>` (repeat, or comma-separated), `&until=<u>` (all refs), `&from=<name>` | the check (below) |
| POST | `/api/deps` | `{from?, deps: [{ref, until?, why?}, ...]}` (or a bare array, checked without `from`) | the check |
| DELETE | `/api/deps` | `?from=<name>&ref=<ref>` (repeatable) | `{removed}`: stops listing `from` as waiting on those refs |
| GET | `{p}/watchers` | | `{watchers: {<selector>: {<from>: {why, until, first, lastCheck}}}, neededBy: {<task id>: [{from, ref, why, until, first, lastCheck}]}}` |

The check:

```json
{"checked": "...", "from": "demo-app", "met": false, "deps": [
  {"ref": "engine/83", "until": "done", "why": "...", "met": false, "dropped": false,
   "tasks": [{"id": "83", "title": "...", "state": "claimed", "status": "active", "resolution": null, "met": false,
              "owner": "lead", "branch": "", "results": "", "updated": "...", "version": 4}]}]}
```

`resolution` is `completed` or `dropped` for a task in Complete, else `null`; `dropped` on a ref is true when any of its
tasks was dropped. A ref that cannot be resolved has `error` (bad ref, no such project, no such task id) and is not met;
a tag or `*` that matches nothing yet has `note` instead. Neither fails the request; only a bad `from` (letters,
digits, space `.` `_` `-`, up to 64) is a 400. Watchers that have not checked for 30 days are left out of `neededBy`.

## Docs

Per-project documents. Formats: `markdown`, `html`, `svg`, `json`, `csv`, `code` (with `language`), `text`.
Content is a string, up to 5 MB (binary files: upload as media and link them). Every save is a new `version`; the last
50 are kept with their content.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `{p}/docs` | `?tag=<t>`, `?q=<text>` (title, tags, summary, content), `?unseen=1` | docs without `content`, newest first |
| POST | `{p}/docs` | `{id?, title, format, language?, summary?, tags?, content, source?, note?}` | 201 the doc; 409 if the id exists. `id` is made from the title when missing. |
| PUT | `{p}/docs/{id}` | the same; creates the doc or updates it (fields left out are kept); `ifVersion`; `note` is kept in the history | the doc (unchanged, same version, when nothing differs) |
| PATCH | `{p}/docs/{id}` | as PUT, but 404 when missing | the doc |
| GET | `{p}/docs/{id}` | `?version=<n>` | the doc with `content`; an older version has `old: true` and `latest` |
| GET | `{p}/docs/{id}/raw` | `?version=<n>` | the content alone (text formats as `text/plain`; `html`, `svg` with `Content-Security-Policy: sandbox ...`) |
| GET | `{p}/docs/{id}/history` | | `[{version, at, by, note, title, format, language, size}]`, newest first |
| POST | `{p}/docs/{id}/seen` | | the doc's metadata: marks the user's latest edit as read (pb does this when it prints a doc) |
| DELETE | `{p}/docs/{id}` | | `{deleted}`; its history and share link go too |
| POST | `{p}/docs/{id}/share` | signed-in browser only | `{url: "<base>/s/<token>"}`: a link anyone can open without signing in |
| DELETE | `{p}/docs/{id}/share` | signed-in browser only | `{unshared}`; the link stops working |
| GET | `/api/shared/{token}` | public | `{project: {slug, name}, doc: {id, title, format, language, summary, content, version, updated}}` |

Fields: `id`, `title`, `format`, `language`, `summary`, `tags`, `content`, `size`, `source`, `created`, `createdBy`,
`updated`, `updatedBy` (`user`, `claude` or `import`), `version`, `userUpdatedAt` (the user's last edit), `seenAt`
(when Claude last read or wrote it), `share` (the token, when shared). A doc is unread by Claude when
`userUpdatedAt > seenAt`; Claude's own writes set `seenAt`.

Live events carry `{type: "doc", action, id, record}` with the record **without** `content` (fetch it when needed).

Pages: `/d/{slug}/{id}` shows a doc full page (signed in; follows changes live); `/s/{token}` shows a shared one (no
sign-in, read-only), its raw content at `/s/{token}/raw`.

**Safety.** Markdown is rendered after escaping (links and images only to http(s), mailto, `/` and `#`). HTML and SVG
never enter the board's page: they load from the raw URL into an `<iframe sandbox>` without `allow-same-origin`, and
the raw answer itself carries a CSP sandbox, so their scripts run in an opaque origin: no cookies, no access to the
board page, no authenticated requests to the API.

## Reports and ingest keys

Reports are what a build out in the world sends back: crash reports, diagnostics, a tester's notes. They arrive on
**one** endpoint with an **ingest key**, a write-only credential for one project. A key can do nothing else: any other
path with an ingest key is refused with 403, whatever the login mode.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| POST | `/api/ingest` | `Authorization: Bearer pbk_<id>_<secret>`; `{title?, kind?, summary?, app?, version?, platform?, contact?, text?, data?}` | 201 `{ok: true, id}` |
| GET | `/api/ingest` | the same header | `{ok: true}`: a build checking its key, told nothing else |
| GET | `{p}/reports` | `?status=new\|kept\|done`, `?q=<text>`, `?limit=<n>` | reports **without** `text`/`data` (with `hasText`, `hasData`), newest first |
| GET | `{p}/reports/{id}` | | the report in full |
| GET | `{p}/reports/{id}/raw` | | its `data` alone (the whole record when it has none) |
| PATCH | `{p}/reports/{id}` | `{status: "new"\|"kept"\|"done"}` | the report's metadata |
| DELETE | `{p}/reports/{id}` | | `{deleted}` |
| GET | `{p}/keys` | | `{keys: [...], url, limits, maxBytes}`; a key's secret is never returned |
| POST | `{p}/keys` | `{name}` | 201 the key, **with `key` once**: `pbk_<id>_<secret>` |
| POST | `{p}/keys/{id}/rotate` | | the key with a new secret; the old one stops working at once |
| PATCH | `{p}/keys/{id}` | `{name?, disabled?}` | the key |
| DELETE | `{p}/keys/{id}` | | `{revoked}` |

Report fields: `id` (`<yyyymmddhhmmss>-<4 hex>`, newest sorts last), `received`, `status`, `key: {id, name}`, `from`
(the address it came from), `title`, `kind`, `summary`, `app`, `version`, `platform`, `contact`, `text`, `data` (any
JSON), `size`, and `statusAt`/`statusBy` once triaged.

Limits (environment, with their defaults): `PB_INGEST_MAX` 262144 bytes a report, `PB_REPORTS_MAX` 2000 reports a
project (the oldest go, done ones first), `PB_INGEST_PER_KEY_MINUTE` 20, `PB_INGEST_PER_KEY_HOUR` 200,
`PB_INGEST_PER_IP_MINUTE` 30, `PB_INGEST_PER_IP_HOUR` 300. Over a limit: 429. Over the size: 413. An archived
project takes no reports (409).

Only the SHA-256 of a key is stored, so a lost key is rotated, never recovered. Keys are made and rotated by a
signed-in browser or an app token (`pb key new`), never by an ingest key.

## Media

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `{p}/media?name=<file name>` | raw bytes (any content type), up to 200 MB | 201 `{url: "/media/{slug}/<time>-<name>", bytes}` |
| GET | `/media/{slug}/{file}` | | the file, with a content type from its extension |

## Live events

`GET {p}/events` is a Server-Sent Events stream for the page: first `{type: "hello", seq}`, then one event per change:

```json
{"seq": 42, "at": "...", "type": "task|handoff|doc|report|key|project|rules|watchers", "action": "create|update|delete|answer|ack", "actor": "user|claude|import", "id": "...", "record": {...}}
```

A `watchers` event (`{type: "watchers", record: <neededBy map>}`) is sent when a project starts or stops waiting on
one of this project's tasks, or changes its reason. A `{"type":"ping"}` event every 15 s keeps it open through proxies with
idle timeouts. The same events (without `rules` and `watchers`) are appended to the
project's `events.jsonl`. Any app may listen; it is the push alternative to polling `/api/deps`.

## Pages

| Path | Content |
|---|---|
| `/`, `/p/...` | the page (`public/index.html`) |
| `/app.js`, `/style.css` | its script and styles |
| `/enrol`, `/enroll` | markdown: enrolling a project from scratch, formats, format requests, the current global rules |
| `/deps` | markdown: waiting on other projects' tasks (refs, `until`, `pb deps`, the HTTP check, a memory note for the depending project) |
| `/onboard`, `/onboard/{slug}` | markdown: a project's settings, daily commands, the memory note, the current global rules; points to `/enrol` if the project is not registered |

The URLs on both pages are built from the address the request came in on (`X-Forwarded-Proto` and `X-Forwarded-Host`
or `Host`), so they read `https://boards.example.com/...` through the domain and `http://192.0.2.10:4780/...`
on the LAN. The page itself uses only relative URLs.

## Examples

```bash
B=https://boards.example.com
curl -s $B/api/projects/engine/inbox
curl -s -X POST $B/api/projects/engine/handoffs -H 'Content-Type: application/json' \
  -d '{"kind":"choice","title":"Fog default","question":"Keep fog on?","choices":["Keep on","Off"],"default":"Keep on"}'
curl -s -X POST $B/api/projects/engine/handoffs/fog-default/ack -H 'Content-Type: application/json' -d '{"note":"kept on"}'
curl -s -X PATCH $B/api/projects/engine/tasks/83 -H 'Content-Type: application/json' -d '{"state":"claimed","owner":"lead","note":"starting"}'
curl -s -X POST "$B/api/projects/engine/media?name=a.png" --data-binary @a.png
curl -s "$B/api/deps?from=demo-app&ref=engine/83&ref=engine/tag:demo-app"
```

## Waking sessions

`POST {p}/notify` (a signed-in browser only) wakes every `pb wait` now with the whole inbox, and lets the answers through
to sessions running the pb hook. Answers otherwise wake them 60 seconds after the last one; messages wake them at once.
Answers `{woken, sessions, inbox}`.

`GET {p}/hook?session=<id>` is what `pb hook` calls: it marks the session as working on the project (the page counts
sessions seen in the last 5 minutes) and answers `{released, inbox, sessions}`, where answers changed at or before
`released` have been let through. The session keeps track of what it has already been told.
