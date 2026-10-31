# Changelog

## 1.7.2 (2026-11-01)

- The bundle and the RHEL guide use HAProxy instead of nginx for TLS.

## 1.7.1 (2026-11-01)

- One-line server install from the latest release: `install-server.sh`, attached to each release, downloads the bundle,
  checks its checksum, unpacks it and runs `install.sh`.
- Fixed: `install.sh` only looked at `/usr/bin/node`, so it refused a machine with an old one there and a newer one on the
  `PATH`. It now uses `NODE` if set, then `PATH`, then the usual places, then nvm's versions, and runs the service with the Node.js it found.
  One in a home folder, like nvm's, is copied into `/opt/project-boards/runtime`, because the service cannot read it there.

## 1.7.0 (2026-11-01)

- `pb self-update`: checks GitHub releases, shows what is new, asks, and replaces itself if you accept. It checks the
  download against the release's checksum and keeps this copy's home server. `--check` only looks; `--yes` is for when the
  user has already agreed.
- GitHub Actions: tests on every push, and a workflow that builds a version and drafts its release.
- Documentation is also published as wiki pages (`scripts/make-wiki.sh`).

## 1.6.0 (2026-11-01)

- One `pb` now works with any number of servers. A project names its server in a committed `.project-boards.json`
  (`pb use <url> --project <slug>`; `pb where` shows what applies). Order: `PB_URL`, that file, the server pb came from.
- Logins are kept per server, so a token only goes to the server that issued it. Existing logins carry over.
- The source of pb no longer names any server: each server stamps its own address, and optionally a LAN address, into
  the pb it publishes (`PB_PUBLIC_URL`, `PB_LAN_URL`, or `data/publish.json`).
- pb no longer restarts servers over ssh, and `bin/ensure-running.sh` is gone. `pb ensure` only checks; a session that
  cannot connect tells the user the board is unreachable.
  `pb upgrade` comes from that server.
- `/upgrade`: what a session in an existing project does to name its server. `/install-rhel`: installing a server on
  RHEL 8 or 9.
- `scripts/make-dist.sh` builds a tarball for a new server, with a systemd service, nginx example and `install.sh`.

## 1.5.0 (2026-11-01)

- **Tell waiting sessions** on the Hand-offs tab, above the answered cards: wakes every `pb wait` now with the whole
  inbox (`POST {p}/notify`, user only), and shows how many sessions are waiting.
- Answers no longer wake sessions one by one: the wake is held until that button, or 60 s after the last answer
  (`PB_ANSWER_QUIET_MS`), so a batch arrives together. Messages and everything else still wake at once.
- The board page catches up after losing its connection: it reconnects after an error answer from the proxy (the
  browser gives up on those for good), notices a stream that died silently (pings are now data events, 40 s without
  one reconnects), and reloads the project on every reconnect. Half-typed answers are kept.
- A reload button next to the connection dot does the same by hand.
- The full-page doc view (`/d/...`) catches up the same way, and only redraws if the doc actually changed.

## 1.4.0 (2026-10-30)

- Hand-offs can be unanswered: **Clear answer** on an answered card (Answered or Done) removes the answer and notes
  (`{clear: true}` on `/answer`). A hand-off with nothing left in it goes back to Waiting, however it was emptied, and
  comes back even if it was acknowledged with `--hide`.
- A cleared answer stays in the inbox until acknowledged, so a session acting on it finds out; pb 1.4.0 shows it as
  `[withdrawn]`. Answered and Done cards say they can still be changed or cleared.
- Fixed: after changing an answer, the card kept highlighting the old one until something else redrew it (the clicked
  button held focus, and a focused card was not replaced).

## 1.3.0 (2026-10-30)

- Docs: per-project documents (gists / artifacts) in markdown, HTML, SVG, JSON, CSV, code or text. Apps store and
  update them (`{p}/docs`, `pb doc put`), the user reads and edits them on the new **Docs** tab (live preview,
  conflict handling when both edit at once), every version is kept (last 50, view and restore), and each can be
  presented full page (`/d/<project>/<id>`, live) or shared with a public link only the user can make (`/s/<token>`).
- The user's edits to a doc show in `pb inbox` / `pb wait` until a session reads it (`pb doc <id>`).
- HTML and SVG docs run in a sandbox with an opaque origin (sandboxed frame plus a CSP sandbox on the raw answer).
- Markdown rendering (docs and task details): emphasis, strikethrough, quotes, rules, header rows, task lists,
  images and safe links; shared by the board and the full-page view (`public/render.js`).
- pb 1.3.0: `pb docs`, `pb doc`, `pb doc put|rm|history|url`; `inbox` and `wait` keep working against older servers.

## 1.2.0 (2026-10-30)

- Logins. One password for the owner (`bin/pb-admin set-password`, never over the web), a session cookie for the page
  (`/login`), and app tokens for pb and other apps through a browser approval like `gh auth login`: `pb login` opens
  `/login/device?code=...`, the user signs in and clicks Allow, pb saves the token. Modes `off`, `optional` (default,
  for the changeover) and `required`, set on the page (Access), with `pb-admin mode`, or pinned with `PB_AUTH`.
- Access dialog: the mode, signed-in apps and browsers with Revoke, tokens made on the page for scripts.
- With logins required, only a signed-in browser is the user; answers and messages refuse app tokens; browser writes
  need the page's `X-PB-Actor` header (CSRF).
- pb is versioned and published by the server: `/pb`, `/api/pb` (version, sha256), `/install` (installer, checked
  against the sha256). `pb version`, `pb upgrade`, a notice when the server has a newer pb, `pb login`/`logout`/`whoami`.
  `pb ensure` no longer needs the shared folder; `import-md --dry-run` asks the server (`POST /api/status-of`).
- `/enrol`, `/onboard` and `/deps` start with installing pb from the domain and signing in.
- Videos on hand-offs: never narrower than 280 px nor shorter than 72 px (their controls, fullscreen included, used to
  vanish), **Enlarge** under each, and **Compare** for a card with several (side by side, or stacked when very wide,
  with Play all from start). Closing the view stops them.

## 1.1.0 (2026-10-30)

- Dependencies between projects: any project or app, registered or not, checks tasks it waits on in other projects
  (`GET/POST /api/deps` with refs `<project>/<id>`, `<project>/tag:<tag>`, `<project>/*` and an `until` of done,
  closed, active or a state word). Tasks closed without being done (won't fix, superseded, ...) come back as
  `dropped`, not done.
- `pb deps` (with `pb-deps.json` in the depending repo: add, rm, `--strict`, `--until-change` polling) marks what
  changed since the last check; `pb needed` and `[needed by ...]` in `pb tasks` show the owning project who is waiting.
- `pb add` / `pb update` take `--tag` and `--untag` (repeatable; other tags are kept).
- The board shows a "needed by <project>" tag on open tasks and a Needed by line in the task drawer, updated live.
- `/deps`: the instructions for a depending project, with its memory note. `/onboard` mentions both directions.
- Fixed: typing in a hand-off's answer or note lost focus whenever the hand-offs re-rendered (each save, every event,
  the one-minute timer) and when the first save moved the card from Waiting to Answered.

## 1.0.1 (2026-10-30)

- Works behind a TLS proxy.
- Links on `/onboard` and `/enrol` follow the address the request came in on (forwarded protocol and host); the page
  already used relative URLs.
- `pb` and `ensure-running.sh` use the domain and fall back to the LAN address (`PB_URL` pins one).
- Fixed: `pb wait` never returned and the page's live updates were dropped soon after connecting (cleanup listened to
  the request's `close`, which Node 16+ emits as soon as a GET is read; now the response's).
- `pb wait` sends a space every 15 s and the event stream pings every 15 s, so proxies with idle timeouts
  keep them open.

## 1.0.0 (2026-10-30)

First version.

- Multi-project server, flat-file data, live page updates.
- Tasks tab: Not started / Being worked on / Complete, from each task's free-text state; details drawer; add tasks.
- Hand-offs tab: choice, text, look (screenshots/videos), steps (hands-on checklists), info, and messages from the
  user; lanes with "Claude is using this" strips; the inbox and acknowledgements.
- Per-project settings: name, path, description, sub-agents allowed at once (0-10, default 0), lanes, banner.
- Global rules, editable on the page and printed for every session; the server refuses a look without media.
- `/enrol` (bringing a project on from scratch, import formats, format requests) and `/onboard/<slug>` (a project's
  instructions and memory note), with copy buttons on the page.
- `bin/pb` command line (tasks, task-file and JSON import, hand-offs, inbox, ack, wait, uploads, rules, format
  requests).

