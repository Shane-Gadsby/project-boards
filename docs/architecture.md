# Architecture

## Pieces

```
browser (the user)          Claude Code sessions
   |  page, SSE (cookie)        |  pb (HTTP + app token; installed from /install), pb ensure (HTTP)
   v                            v
   https://boards.example.com  ->  a TLS proxy (nginx, for example)
   http://192.0.2.10:4780 (LAN, direct; pb's optional fallback)     |
                                                                    v
        server.js on port 4780
                  |
                  v
        data/ (flat JSON files, one per record)
```

| File | Role |
|---|---|
| `server.js` | The whole server: store, routes, live updates. Node's `http` module only. |
| `lib/status.js` | A task's free-text state to its column (`todo`/`active`/`done`), and a finished task's resolution (`completed`/`dropped`). Shared by the server and `pb --dry-run`. |
| `lib/onboarding.js` | The `/onboard[/<slug>]` page (markdown). |
| `lib/enrol.js` | The `/enrol` page (markdown). |
| `lib/deps-guide.js` | The `/deps` page (markdown): waiting on other projects' tasks. |
| `lib/cli-setup.js` | The "get pb and sign in" steps printed on `/enrol`, `/onboard` and `/deps`. |
| `lib/auth.js` | Logins: password check, sessions, app tokens, the device flow, rate limits, the mode. |
| `lib/install.js` | The `/install` shell script. |
| `lib/docs.js` | Docs: storage, versions and history, unread-by-Claude tracking, share links, raw content types. |
| `public/render.js` | The markdown renderer and per-format doc rendering, shared by the board and the full-page view. |
| `public/doc.html`, `doc.js` | A doc full page: `/d/<project>/<id>` (signed in, live) and `/s/<token>` (shared). |
| `public/login.html`, `login.js` | Sign-in and app-approval pages (`/login`, `/login/device`). |
| `public/index.html`, `app.js`, `style.css` | The page. Plain script, no build step, light theme. |
| `bin/pb` | The command line for sessions (Node, `fetch`); one file, published by the server at `/pb`. |
| `bin/pb-admin` | The owner's password and login mode; writes `data/auth-admin.json` (run where the data folder is). |
| `packaging/rhel/` | systemd service, environment file, nginx example and installer for a new server. |
| `docs/` | This documentation. |

## Server internals

- **Store.** At start, every `project.json`, task and hand-off file is read into a `Map` per project. Writes update the
  map, then write that one record's file (temp file + rename) and append to `events.jsonl`. One process is the only
  writer, so there is no locking; Node runs one request handler at a time between awaits.
- **One file per record** keeps writes small (a project with 600 tasks rewrites one ~2 KB file per change, not a
  megabyte), makes the data easy to read, diff and back up, and limits a bad write to one record.
- **Optimistic concurrency.** Every record has `version`; a write with `ifVersion` that does not match fails with 409.
- **Actor.** With logins required, the user is whoever holds a signed-in browser session; app tokens act as Claude.
  Otherwise the `X-PB-Actor: user` header (sent by the page) marks the user's actions. Answers and messages must come
  from the user. Only those set
  `userUpdatedAt` and so fill the inbox and wake waiters. Hand-off imports run as `import`, which may set answer history
  and skips the look-media rule.
- **Live updates.** Every change is broadcast to the project's open pages over Server-Sent Events (`/events`), and
  every user action resolves pending long-polls (`/wait`), which is how a session can sleep until the user answers.
  Both write something every 15 s (an SSE comment, a space before the JSON) so proxies with idle timeouts
  keep them open, and both clean up on the **response's** `close` event: since Node 16 a request emits `close` as soon
  as its body is read, which for a GET is at once (it left waiters hanging and dropped live clients before 1.0.1).
- **Relative URLs.** The page calls `/api/...` and builds copy links from `location.origin`; the instruction pages build
  theirs from the request's forwarded protocol and host. Nothing in the page knows the server's address.
- **Inbox** is computed, not stored: hand-offs with `userUpdatedAt > ackedAt`. Acknowledging is the session's explicit
  statement that it acted; there is no flag the page can set on its own that would hide an answer from Claude.
- **Rules** are one JSON file, shared by all projects, printed into both instruction pages at request time.
- **Format requests** become tasks (tagged `format-request`) plus an `info` hand-off on the built-in `project-boards`
  project, so the board tracks its own backlog the same way as any project's.

## Logins

- **One user, two kinds of credential.** A browser session (cookie `pb_session`, 30 days sliding, made by `POST
  /api/auth/login`) and app tokens (`pbt_<id>_<secret>`, sent as `Authorization: Bearer`, until revoked). Both are
  random 256-bit secrets; `data/auth.json` keeps only their SHA-256 hashes, and lookups compare in constant time.
- **The device flow** (as `gh auth login`, after RFC 8628): `pb login` asks `POST /api/auth/device` for a device code
  (secret, kept by pb) and a user code (`BCDF-GHJK`, shown to the user); it opens `/login/device?code=...`, where the
  signed-in user sees the app, machine, project and address and clicks Allow; pb polls `POST /api/auth/token` every
  3 s and gets the token once. Flows live in memory for 10 minutes; a restart drops pending ones (pb says to run it
  again). Chosen over a loopback redirect because it also works over ssh and on machines without a browser.
- **Password** in `data/auth-admin.json` (scrypt N=32768, r=8, p=1), written only by `bin/pb-admin`, never by the web,
  so there is no "first visitor sets the password" moment on a public site. The server re-reads the file when its
  mtime changes. A session older than the password's `set` time is invalid.
- **Mode** (`off`, `optional`, `required`): `PB_AUTH`, else `auth-admin.json`, else `optional`. `isPublic()` in
  `server.js` lists what needs no login in any mode.
- **CSRF.** Session cookies are `SameSite=Lax`, and any non-GET request carrying a cookie must also carry `X-PB-Actor`,
  which a cross-site form cannot add and a cross-site script cannot send without a CORS preflight the server never
  answers.
- **lastUsed** for sessions and tokens is kept in memory and written at most every 5 minutes; creating or revoking
  writes at once.

## The command line as a download

`bin/pb` is one self-contained file: it carries `VERSION`, its own `pb ensure`, and asks the server for anything that
lives in `lib/` (`POST /api/status-of` for `import-md --dry-run`). The server reads it when it changes and serves it at
`/pb`, its version and sha256 at `/api/pb`, an installer at `/install`, and the version in an `X-PB-CLI-Version`
header on every answer, which is how an old pb learns it should upgrade without an extra request.

## Page internals

- State lives in memory (`state.tasks`, `state.handoffs`); the page loads a project once, then applies SSE events.
- **Keyed rendering** (`renderKeyed`): lists are re-rendered by record id and version; an unchanged record keeps its DOM
  node, and a node that holds keyboard focus is never replaced. Notes being typed are also kept in `state.drafts`. This
  avoids two failures the earlier artifact boards had: clicks swallowed because a button was rebuilt between press and
  release, and typed notes lost to a background refresh.
- Notes and typed answers save 700 ms after typing stops.
- `[hidden] { display: none !important; }` is global: a `display: flex` rule once overrode `hidden` and left an
  invisible lightbox over the page that ate every click.
- Copy buttons fall back to `document.execCommand('copy')` because `navigator.clipboard` needs a secure context and the
  page is plain http on a LAN address.
- Task details render through a small markdown renderer that escapes everything first (headings, paragraphs, lists,
  tables, code, bold, http links).

## Design decisions

| Decision | Why |
|---|---|
| Node with no dependencies | Nothing to install or update on the server or clients; `pb` runs anywhere Node 18+ is. |
| Flat files rather than PouchDB | One writer, small data; plain files are readable, diffable and trivially backed up. |
| A real server on the LAN rather than claude.ai artifacts | Several projects and machines share it; sessions read it with a CLI instead of an artifact database API; the user keeps one tab open for everything. |
| Inbox + acknowledge instead of a "told" flag | The old boards marked answers as told when the user pressed Tell Claude, so a session filtering on it missed answers. Now an answer stays in the inbox until Claude says it acted. |
| Free-text `state` with a derived column | Projects keep their own vocabulary ("ready-for-integration (results in ...)"); the board only needs the first word. |
| Lanes and busy strips | From the Oblivion co-op board: hands-on steps belong to a machine, and the user must know when Claude is driving one. |
| Global rules served by the server | One place to change how every project's sessions report; sessions read them each time, so edits take effect without touching each project's memory. |

## Extending

- **A new import format:** if it is a different task-file layout, extend `parseTaskFile()` in `bin/pb` or add a
  `pb import-<format>` command that builds the task JSON and posts it to `/tasks/import`. Keep the server format-agnostic.
  Close the matching `format-request` task on the `project-boards` project, and add the format to `lib/enrol.js`.
- **A new hand-off kind:** add it to `HANDOFF_KINDS` in `server.js`, its validation in `validateHandoff()`, its state in
  `handoffState()` (server and page), its card in `renderHandoffCard()` and its answer handling in `answerHandoff()`;
  document it in `lib/enrol.js`, `lib/onboarding.js`, `docs/`.
- **A new enforced rule:** add the text as a rule (page or `PUT /api/rules`) and, where the server can check it, a
  check like `requireLookMedia()` with an error message that names the rule.
- **Per-project settings:** add the field to `normalizeProject()`, the PATCH handler, the settings dialog, `pb set`,
  and the onboarding page's settings table.
