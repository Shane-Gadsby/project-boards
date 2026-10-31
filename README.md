# Project Boards

A task board and hand-offs queue that several Claude Code projects share, each kept separate. You watch every project
from one browser tab; each project's Claude sessions keep their tasks on it, ask you questions through it, and read
your answers from it.

| | |
|---|---|
| **Tasks** tab | Every task of the selected project in three columns: Not started, Being worked on, Complete. |
| **Docs** tab | The project's documents (specs, reports, diagrams, HTML pages, data): Claude writes them with `pb doc put`, you read, edit, present and share them. |
| **Hand-offs** tab | What a session needs from you: decisions with a default, typed answers, screenshots and videos to judge, hands-on test steps, and a box to message Claude. Your answers wait in the project's inbox until Claude acknowledges them. |
| **Project dropdown** | Switch projects; **+ Add a project...** registers one. |
| **Gear** | The project's settings, including **sub-agents allowed at once** (0-10, default 0). |
| **Rules** | Global rules every project's sessions follow (screenshots for visual A/B, videos for anything over time, ...). |

## Bringing a project onto the board

Give a Claude Code session working in that project this URL (Copy button in the Add-project and settings dialogs):

```
https://boards.example.com/enrol
```

It explains the board and what the session must do, lists the formats it can import (task files, task JSON, hand-off
JSON), and lets the session request a format the board cannot read yet. Once a project is registered, its own
instructions (settings, daily commands, the memory note that makes every later session use the board) are at
`https://boards.example.com/onboard/<project>`.

## Waiting on another project

A project (or any app) that needs work another project owns, and only wants to know when it is done, does not need to
be registered: give its session `https://boards.example.com/deps`. It lists what it waits on in a
`pb-deps.json` at its repo root (`pb deps add engine/83 --why "..."`) and checks with `pb deps`, which marks
what changed since the last check and flags work closed without being done. The owning project sees a "needed by"
tag on those tasks and lists them with `pb needed`. Any language can use the same check: `GET /api/deps?ref=...`.

## Several servers

One `pb` works with any number of boards. A project names its server in a committed `.project-boards.json`
(`pb use <url> --project <slug>`), and logins are kept per server. A project already on a board: `<board>/upgrade`.
A new board on RHEL 8 or 9: `<board>/install-rhel` and `scripts/make-dist.sh`.

## Documentation

| | |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | The page, for the user: every control, hand-off kind, column, setting and rule. |
| [docs/claude-sessions.md](docs/claude-sessions.md) | For Claude sessions: the contract, the `pb` command reference, import formats, asking well, sub-agents, the memory note. |
| [docs/api.md](docs/api.md) | The HTTP API: every route, body and response; live events; examples. |
| [docs/data-model.md](docs/data-model.md) | Files on disk, every record's fields, how columns and the inbox are derived, backup. |
| [docs/operations.md](docs/operations.md) | Running a server: configuration, logins, releasing, security, troubleshooting. |
| [docs/architecture.md](docs/architecture.md) | How it is built, why, and how to extend it (formats, hand-off kinds, rules, settings). |
| [docs/install-rhel.md](docs/install-rhel.md) | Installing a server on RHEL 8 or 9. |
| [CHANGELOG.md](CHANGELOG.md) | Versions. |

## Running one

Node.js 18 or newer, no packages, no database:

```bash
PB_AUTH=off PB_HOST=127.0.0.1 node server.js     # a local trial on http://127.0.0.1:4780
```

For a real server, see [docs/operations.md](docs/operations.md) and, on RHEL 8 or 9, [docs/install-rhel.md](docs/install-rhel.md).
Set a password and keep logins required on anything others can reach.

## Updating pb

`pb upgrade` updates from the board `pb` came from. `pb self-update` checks GitHub releases, shows what is new and asks
before installing.

## License

MIT. See [LICENSE](LICENSE).
