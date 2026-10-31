# Operations

How to run a board server. To install one on RHEL 8 or 9, follow [install-rhel.md](install-rhel.md); the service, paths and
commands there are the reference setup.

## Requirements

Node.js 18 or newer. No npm packages and no database: everything is flat files in the data folder.

Anywhere else, run it however you run services:

```bash
PB_PUBLIC_URL=https://boards.example.com PB_DATA=/srv/project-boards PB_AUTH=required node server.js
```

Put a TLS proxy in front of anything reachable over a network. The server speaks plain HTTP.

## Configuration

Server, from its environment (restart to apply):

| Variable | Default | Meaning |
|---|---|---|
| `PB_PUBLIC_URL` | the address a request came in on, sub-path included | The address stamped into the `pb` this server publishes. `pb` treats it as home and upgrades from it. |
| `PB_LAN_URL` | (none) | A second address, stamped too; `pb` falls back to it when the main one fails. |
| `PB_BASE_PATH` | (none) | A sub-path to answer on as well as the root, such as `/projects`. See below. |
| `PB_UPDATE_MODE` | (none) | How the page installs updates: `systemd` or `inplace`. See below. |
| `PB_PORT` | 4780 | Port. |
| `PB_HOST` | 0.0.0.0 | Interface. Use `127.0.0.1` behind a local proxy. |
| `PB_DATA` | `./data` | Data folder. |
| `PB_CLIENT_ROOT` | the server's folder | The folder path the instruction pages print. |
| `PB_AUTH` | (unset) | `off`, `optional` or `required`: pins the login mode, overriding the data folder and the page. |
| `PB_ANSWER_QUIET_MS` | 60000 | How long after the last answer waiting sessions are woken without the button. |

`PB_PUBLIC_URL` and `PB_LAN_URL` can instead be `url` and `lan` in `<data>/publish.json`.

Clients: `PB_URL`, `PB_PROJECT`, `PB_TOKEN` (a token instead of `pb login`'s saved one), `XDG_CONFIG_HOME` (see
[claude-sessions.md](claude-sessions.md)).

## Updating from the page

Signed in, the **Updates** button checks GitHub for a newer release and installs it. It needs a browser session: `pb`, app
tokens and a board with logins off cannot use it.

How it installs depends on how the server runs:

| `PB_UPDATE_MODE` | What happens |
|---|---|
| `systemd` | Set by the reference install. The service cannot write its own code, so it writes the version to a request file, and a root unit (`project-boards-update.path`) installs that release with the normal installer, which checks the checksum. |
| `inplace` | The server replaces its own files and exits, so a process manager must restart it, and its folder must be writable. |
| (unset) | The page only reports new versions. |

`update` in `<data>/publish.json` can set the mode instead. The server must be able to reach GitHub. It does that with `curl`, which uses `https_proxy` and `no_proxy`, so through a proxy it
needs those in its environment. The reference install reads them from `/etc/environment` and its env file; settings in a
shell profile do not reach a service. The page cannot go
backwards, or install anything but the latest published release. Take a backup first if the data matters: an update does not
make one.

## Serving from a sub-directory

A board can live at `https://blah.com/`, at `https://blah.com/projects`, or at both. Pages, links, the login cookie, `pb` and
media all follow the address they were reached on.

Set `PB_BASE_PATH=/projects`, and send the requests to the server with the path intact. The root keeps working as well, so
close it at the proxy if you do not want it. Include the path in `PB_PUBLIC_URL`, because `pb` keeps that address as its
home: `PB_PUBLIC_URL=https://blah.com/projects`. Clients use it the same way: `pb use https://blah.com/projects`.

A proxy that removes the path before forwarding has to say what it removed, in an `X-Forwarded-Prefix: /projects` header. That
is believed only from a proxy on the same machine; a proxy elsewhere must leave the path intact and rely on `PB_BASE_PATH`.

Signing in on a sub-path sets the cookie for that path only, so other apps on the domain never receive it. Sign in separately
if you use both addresses.

## When it is down

Clients do not restart the server. `pb ensure` only checks it, and a session that cannot connect tells the user the
board is unreachable.

## Changing the code

```bash
sh scripts/smoke-test.sh
```

Changes to `public/` need no restart: files are read on each request. Changes to `server.js` or `lib/` do. `bin/pb` is
published when saved, so it reaches clients as `pb upgrade`. Bump `VERSION` in both `server.js` and `bin/pb`, and add a section to `CHANGELOG.md`.

Test against a scratch copy before restarting a real server:

```bash
PB_DATA=/tmp/pb-test PB_PORT=4791 PB_HOST=127.0.0.1 node server.js &
PB_URL=http://127.0.0.1:4791 bin/pb register demo --name Demo --path /tmp
```

## Releasing

The **Draft release** workflow (Actions tab, Run workflow) tests the code, builds the server bundle and `pb`, and drafts a
GitHub release named after `VERSION`, with notes from `CHANGELOG.md`. Check the draft and publish it: `pb self-update`
only sees published releases.

## Backup

Copy the data folder (safe while running). Media files are the bulk; tasks and hand-offs are small JSON. `events.jsonl` can
be rotated or truncated at any time.

## Logins

A board has one password for its owner, a session cookie for the page, and an app token per machine for `pb` and other
apps. How the pieces work is in [architecture.md](architecture.md#logins); the API is in [api.md](api.md#logins).

**The password** is set with `bin/pb-admin`, never over the web, on a machine that can reach the data folder. The server
picks up the change on its next request.

```bash
PB_DATA=<data folder> node bin/pb-admin set-password   # asks twice; at least 10 characters
PB_DATA=<data folder> node bin/pb-admin status         # password set?, mode, tokens, sessions
PB_DATA=<data folder> node bin/pb-admin mode required  # or optional / off
```

Changing the password signs every browser out; app tokens stay valid (revoke them on the page, under Access).

**The mode** says what is enforced:

| Mode | Effect |
|---|---|
| `off` | No logins at all: the board is open to anyone who can reach it. The emergency switch. |
| `optional` (default) | Signing in and `pb login` work, nothing is refused. For a changeover, while each machine signs in. |
| `required` | The page, the API and media need a signed-in browser or an app token. Public: `/api/health`, the login pages, `/pb`, `/api/pb`, `/install`, `/install-rhel`, `/upgrade`, `/enrol`, `/onboard`, `/deps`. Only a signed-in browser counts as the user (answers, messages). |

Set it on the page (Access) or with `pb-admin mode`. `PB_AUTH` overrides both, for when a login problem locks everyone out.

## The pb command line

Each server publishes `bin/pb`, stamped with its own address:

| | |
|---|---|
| `GET /pb` | the script |
| `GET /api/pb` | `{version, sha256, size, url, install}` |
| `GET /install` | a shell installer: `curl -fsSL <base>/install \| sh [-s -- <folder>]`, checked against the sha256 |

`pb upgrade` updates from the server `pb` came from. `pb self-update` updates from GitHub releases after asking.

## Security

- Passwords are scrypt hashes. Session cookies and app tokens are 256-bit random secrets of which the server keeps only
  SHA-256 hashes, so the files in the data folder do not let anyone sign in. Cookies are `HttpOnly`, `SameSite=Lax`, and
  `Secure` behind TLS. A browser request that changes something must carry the page's `X-PB-Actor` header. Wrong passwords
  are limited to 5 per address and 30 overall per 15 minutes.
- Forwarded client addresses are only believed from loopback.
- Anyone who can write the data folder can change the password, and anyone who can write the code can run as the service:
  keep both restricted. The reference install keeps the code root-owned and runs as an unprivileged user.
- Uploads are stored under a sanitized name in the project's `media/` and served back as-is.

## Troubleshooting

| Symptom | Check |
|---|---|
| `pb: cannot reach the server` | The service's log, then restart it. |
| `login required` from `pb` (exit 3) | `pb login` on that machine; `pb whoami` shows what the server sees. A revoked or lost token looks the same. |
| `pb login` says the code expired | It lasts 10 minutes; run it again and approve the tab sooner. |
| The page keeps going back to the sign-in page | The session was revoked, or the password changed. Sign in again. |
| Locked out entirely | `pb-admin set-password`, and if needed `pb-admin mode optional`, or pin `PB_AUTH`. |
| Log says the port is in use | `ss -ltnp \| grep 4780` shows what has it. |
| The page shows a grey dot | It lost the event stream; it reconnects and catches up on its own. |
| `pb` picks the wrong server or project | `pb where` shows what applies and why. |
| 502/503 through the proxy, but the port answers directly | The proxy's configuration and its upstream health. |
| Live updates stop through a proxy | The app pings every 15 s; check the proxy's read timeout and that it does not buffer the response. |
| A record vanished after a crash | Look for a `*.tmp-<pid>` beside it in `<data>/projects/<slug>/...`; the log names any file it skipped at start. |
| `look` hand-off refused | It needs at least one screenshot or video: `pb ask --media <file>`. |
