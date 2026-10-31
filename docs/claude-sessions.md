# Guide for Claude Code sessions

How a Claude Code session uses Project Boards. The server prints the same material, specific to a project, at:

- `https://boards.example.com/enrol`: a project that is not on the board yet (what the board is, what to do, the import
  formats, format requests).
- `https://boards.example.com/onboard/<slug>`: a registered project (its settings, daily commands, the memory note to save).
- `https://boards.example.com/deps`: any project, on the board or not, that waits on another project's tasks.

Hand a session one of those URLs; this file is the reference behind them.

## The contract

A session working on a registered project:

1. **Starts** with `pb ensure` and `pb whoami` (signed in? else `pb login`), then `pb rules`, `pb inbox`, `pb tasks --status active`.
2. **Follows the global rules** (`pb rules`). They change; never work from a remembered copy.
3. **Keeps every task on the board**: new work is a task (`pb add`), every state change is recorded (`pb update`, or
   `pb import-md` when the project keeps task files).
4. **Asks the user through hand-offs**, with a default wherever one makes sense, never only in chat. Visual questions are
   looks with screenshots, behavior over time looks with videos (global rules).
5. **Reads answers from the inbox** (`pb inbox`) at session start, whenever the user says they answered, and before
   every status report; acknowledges each one once acted on (`pb ack`). Never concludes nothing is new without
   running `pb inbox`.
6. **Never runs more sub-agents at once than the project's `maxSubagents`** (`pb settings` / `pb agents`), read fresh
   before each spawn. 0 means no sub-agents.
7. **Marks shared resources busy** while using them (`pb busy <lane|all> "..."`, `--clear` after).
8. **Has saved the memory note** from `/onboard/<slug>` in the project's auto-memory, so every later session does all of
   the above.

## Getting pb, and signing in

`pb` is one Node script (Node 18 or newer, no packages) that the server publishes. Install it on each machine:

```bash
curl -fsSL https://boards.example.com/install | sh                  # -> ~/.local/share/project-boards/pb
curl -fsSL https://boards.example.com/install | sh -s -- <folder>   # -> <folder>/pb
```

Use the folder the user's instructions name for installed applications when there is one. The copy in a server's own folder
is the source, and is never upgraded over itself.

Then sign the machine in once: `pb login` prints a link and a code and opens a browser tab; the user signs in and
clicks Allow; pb saves the token in `~/.config/project-boards/credentials.json` (mode 600). `pb whoami` shows what the
server sees, `pb logout` revokes and forgets it, `PB_TOKEN=<token>` uses a token made on the page instead (scripts, CI).
A command that gets "login required" exits with code 3.

When the server has a newer pb, every command says so on stderr once; `pb upgrade` downloads it, checks the sha256
and replaces itself. `pb version` compares without upgrading.

## Which project `pb` acts on

In order: `--project <slug>`, else `$PB_PROJECT`, else the registered project whose `path` contains the current
directory (the longest match). A command that needs a project and finds none says so.

`pb` picks the server from `PB_URL`, else `.project-boards.json` (found upward from the current directory), else the
server it was installed from. If that server publishes a LAN address, `pb` falls back to it for the rest of the command
when the main address cannot be reached or does not answer as the API.

Environment: `PB_URL` (pins one address and turns the fallback off), `PB_PROJECT`, `PB_TOKEN`, `XDG_CONFIG_HOME` / `XDG_CACHE_HOME` (where the token and the deps
baseline live). The server comes from `PB_URL`, else `.project-boards.json` (`pb use`, `pb where`), else the server pb came from.

## `pb` reference

### Server and project

| Command | Does |
|---|---|
| `pb self-update [--check] [--yes]` | Checks GitHub releases and, if the user agrees, installs a newer `pb`, checked against the release's checksum and keeping this copy's home server. With no terminal it stops and says to ask the user: pass `--yes` only once they have agreed. `pb upgrade` updates from the board instead. |
| `pb ensure` | Exit 0 when the board answers (or its LAN address does). Otherwise exit 2: tell the user the board is unreachable. pb never restarts a server. |
| `pb login [--name <n>] [--no-browser]` | Signs this machine in through the browser (above). `--name` replaces "pb" in the token's name; `--no-browser` only prints the link. |
| `pb logout` / `pb whoami` | Revoke and forget this machine's token / show who the server sees and the login mode. |
| `pb version [--local]` / `pb upgrade [--force]` | This pb's version against the server's / install the server's pb over this one. |
| `pb health` | The health JSON. |
| `pb projects` | Every project: slug, name, sub-agent limit, task counts per column, inbox size, path. |
| `pb register <slug> --name <n> [--path <dir>] [--lanes "PC1,PC2"] [--max-subagents N] [--description <t>]` | Registers a project. `--path` defaults to the current directory. Leave `--max-subagents` to the user. |
| `pb settings` | This project's settings and counts (JSON). |
| `pb set [--max-subagents N] [--banner <t>] [--lanes "a,b"] [--name <n>] [--path <dir>] [--description <t>]` | Changes settings. `--banner` with no text clears it. |
| `pb rules` | The global rules. |
| `pb busy <lane\|all> <text>` / `pb busy <lane\|all> --clear` | Shows or clears the "Claude is using this" strip. `all` shows on the shared list. |
| `pb agents` | The sub-agent limit, tasks being worked on, and their non-lead owners. |

### Tasks

| Command | Does |
|---|---|
| `pb tasks [--status todo\|active\|done] [--json]` | Lists tasks: column, id, state, owner, title. |
| `pb task <id>` | One task as JSON, with its details and log. |
| `pb add --title <t> [--id <id>] [--state <s>] [--owner <o>] [--branch <b>] [--results <p>] [--needs <n>] [--claimed <c>] [--summary <s>] [--priority <p>] [--source <s>] [--file <path>] [--body-file <f>] [--note <t>]` | Creates a task. Without `--id` the next number is used. |
| `pb update <id> [same fields] [--status todo\|active\|done] [--note <t>]` | Changes a task. `--note` appends to its log. `--status` forces the column. |
| `pb add/update ... --tag <t> [--tag <t2>] [--untag <t3>]` | Adds or removes tags, keeping the others (e.g. `--tag demo-app` so a project waiting on `<project>/tag:demo-app` picks it up). |
| `pb import-md <dir> [--dry-run]` | Upserts every `<id>-<name>.md` task file in a folder (format below). `--dry-run` prints the parse and columns without writing. |
| `pb import-json <file>` | Upserts tasks from a JSON array (format below). |
| `pb rm <id>` | Deletes a task. |

### Hand-offs

| Command | Does |
|---|---|
| `pb ask --title <t> --question <q> [--kind choice\|text\|look\|steps\|info] [--choice "Label\|detail"]... [--default <label>] [--context <t>] [--lane <id>] [--media <file or URL>]... [--step "do\|expect"]... [--id <id>] [--source <s>]` | Posts a hand-off. `--media` uploads local files (and makes the kind `look` unless given); `--step` makes it `steps`. A `look` without `--media` is refused. |
| `pb ask-json <file>` | Creates or updates hand-offs from a JSON object or array (format below); may carry answered history. |
| `pb handoffs [--state pending\|answered\|acted] [--json]` | Lists hand-offs with their answers. |
| `pb inbox [--json]` | What the user answered or wrote that has not been acknowledged. |
| `pb ack <id>... [--note <t>] [--hide]` | Acknowledges answers once acted on. The note shows to the user ("Claude picked this up: ..."). `--hide` also takes it off the page. |
| `pb wait [--timeout <s>] [--fresh]` | Blocks until the user answers or writes something, then prints the inbox. Returns at once if the inbox is not empty, unless `--fresh`. Default 600 s, at most 3600. Run it in the background to be woken by an answer. |
| `pb upload <file>` | Uploads an image or video and prints its URL (`/media/<slug>/<file>`) for a hand-off's `media`. |
| `pb format-request --project <slug> --name <format> --description <t> [--sample-file <f>]` | Asks for a native importer for a format the board does not read (lands on the `project-boards` project). |

### Docs

| Command | Does |
|---|---|
| `pb docs [--tag <t>] [--unseen] [--json]` | Lists the project's docs: id, format, version, age, who saved last, title; marks shared ones and ones the user edited that you have not read. |
| `pb doc <id> [--version <n>] [--out <file>] [--meta]` | Prints a doc (or saves it, or prints its metadata). Reading the latest version marks the user's edit as read. |
| `pb doc put <file\|-> [--id <id>] [--title <t>] [--format <f>] [--language <l>] [--tag <t>]... [--summary <s>] [--note <t>] [--if-version <n>]` | Creates or updates a doc. The id defaults to the file name without its extension, the format to the extension (`.md` markdown, `.html` html, `.svg`, `.json`, `.csv`, `.txt` text, anything else code with that language). A new doc's title is `--title`, else its first `# ` heading, else the file name; an existing doc keeps its title unless `--title` is given. `-` reads stdin (then give `--id`). Warns when it overwrote an edit of the user's you had not read. |
| `pb doc rm <id>` / `pb doc history <id>` / `pb doc url <id>` | Delete it (with its history) / list its versions / print its full-page and raw URLs. |

`pb inbox` (and `pb wait`) also list docs the user edited that you have not read.

### Dependencies (waiting on other projects)

No registration needed. The list lives in `pb-deps.json` at the depending repo's root
(`{"from": "<name>", "deps": [{"ref", "why", "until"}]}`), found by walking up from the current directory (`--file`
overrides). Refs, `until` and the meaning of DROPPED are in [api.md](api.md#dependencies).

| Command | Does |
|---|---|
| `pb deps [<ref>...] [--json] [--strict] [--as <name>] [--until <u>]` | Checks every dep in the file (or just the refs given) and prints met / waiting / DROPPED / ERROR per ref, marking tasks that **CHANGED** since the last check (the first check is a baseline; what was seen is kept in `~/.cache/project-boards/deps/`). `--strict` exits 1 unless all are met. `--as` sets who is asking (default: the file's `from`, else the registered project, else the folder name). |
| `pb deps add <ref> [--why <t>] [--until done\|closed\|active\|<state>]` | Adds or replaces one dep, creating the file at the repo root if needed, and checks it once. |
| `pb deps rm <ref>` | Removes one, and stops showing as waiting on it. |
| `pb deps --until-change [--every <s>] [--timeout <s>]` | Polls (default every 300 s, at least 30; up to 6 h) and exits as soon as something changed, printing the check. Run in the background to be woken. |
| `pb needed [--all] [--json]` | The owning side: this project's open tasks that other projects wait on, with each one's reason and last check (`--all` includes finished ones). `pb tasks` also marks them `[needed by ...]`. |

## Import formats

### Task files (`pb import-md`)

Files named `<id>-<short-name>.md`; `README*.md` is skipped. The id is the part before the first `-`. The first `# `
line is the title (a leading `<id>-<short-name>: ` is dropped). Header lines in the first 40 lines, each optional:
`State:`, `Owner:`, `Claimed:`, `Needs:`, `Branch:`, `Results:`, `Priority:`. Everything else is the task's details.

```markdown
# 12-save-loader: Fix the save loader

State: claimed
Owner: worker-3
Branch: work/12

## Context
...
```

Re-running the import is cheap: unchanged tasks are skipped, changed ones updated, new ones created. Projects that keep
task files as the spec re-run it after editing `State:` lines.

### Tasks JSON (`pb import-json`, `POST .../tasks/import`)

An array, or `{"tasks": [...]}`. See [data-model.md](data-model.md#task) for every field. Minimal:

```json
[{"id": "12", "title": "Fix the save loader", "state": "in-progress", "owner": "worker-3", "body": "markdown"}]
```

### Hand-offs JSON (`pb ask-json`, `POST .../handoffs/import`)

An object, an array, or `{"handoffs": [...]}`. See [data-model.md](data-model.md#hand-off). To import history, include
`answer`/`note`, `answeredAt` and `userUpdatedAt` (when the user answered) and `ackedAt` (when it was acted on); the item
then shows as done and stays out of the inbox. Imported looks may lack media (old pictures that cannot be fetched);
new looks may not.

### Anything else

Convert it to one of the JSON formats yourself when the import is a one-off. For a format that should be imported
natively and repeatedly, `pb format-request` with a sample and the mapping you expect.

## Asking well

- One decision per hand-off, with the **default** set to what you will do if the user just accepts defaults.
- `context` says why it matters and what each choice costs.
- Looks: crop to the thing being judged, one picture or video per variant, caption each (`media[].caption` via JSON,
  or describe them in `question`). WebGPU beside native, before beside after.
- Steps: one physical action per step with what should happen; one lane per machine.
- After the user answers: act, record it where the project records decisions, then `pb ack <id> --note "<what you did>"`.

## Sub-agents

`maxSubagents` (0-10, default 0) is the user's limit on sub-agents running at once for the project: Agent tool calls,
background workers, forks, workflow agents. Read it fresh before spawning (`pb settings`); the user changes it on the
page at any time. With 0, do the work yourself. Give each worker its task id and have the board updated as it goes.

## The memory note

`/onboard/<slug>` prints the exact file to save in the project's auto-memory (`project_boards.md`, type `reference`)
and its line for `MEMORY.md`. It makes every future session: run `pb ensure` and `pb whoami`, read `pb rules`, check `pb inbox`
and active tasks, keep the board current, ask through hand-offs, respect `maxSubagents`, mark resources busy.
