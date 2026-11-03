'use strict';

const { cliSetupText } = require('./cli-setup');

// The text a Claude Code session reads at /onboard[/<slug>]: everything it needs to start using the board.
function onboardingText({ base, slug, project, root, projects, rules, cliVersion }) {
	const pb = '<pb>';
	const ensure = `${pb} ensure`;
	const s = slug || '<slug>';
	const registered = !!project;
	const settings = project
		? `Registered as **${project.name}** (\`${project.slug}\`), path \`${project.path || '(none)'}\`.

| Setting | Value | Meaning |
|---|---|---|
| maxSubagents | **${project.maxSubagents}** | The most sub-agents (Agent tool calls, workers, forks, workflows' agents) you may have running at once for this project. 0 means none: do all work yourself. The user changes it on the board; re-read it before you spawn. |
| lanes | ${project.lanes.length ? project.lanes.map((l) => `\`${l.id}\` (${l.name})`).join(', ') : 'none'} | Columns on the Hand-offs tab (e.g. one per test PC). A hand-off with \`lane\` shows in that column; without, in the shared list. |
| banner | ${project.banner ? `"${project.banner}"` : '(empty)'} | One line shown at the top of the board. |`
		: `This project is not registered yet${slug ? ` (no project \`${slug}\`)` : ''}. Registered projects: ${projects.length ? projects.map((p) => `\`${p.slug}\` (${p.name})`).join(', ') : 'none'}. **Start at ${base}/enrol**: it explains the board, what is expected of you, the import formats, and how to ask for a format that is missing.`;

	return `# Project Boards: how this project tracks its work

Project Boards is the user's local task board and hand-offs queue, shared by several projects (each kept separate).
The user watches it in their browser at **${base}/** (project dropdown at the top). It replaces any artifact-based
"Hand-offs" page and any task list you were keeping only in files or chat.

- **Tasks** tab: every unit of work, in three columns: **Not started** (open, blocked, deferred: nobody is on it),
  **Being worked on** (claimed, in progress, ready for integration), **Complete** (done, integrated, closed).
- **Hand-offs** tab: everything that needs the user: decisions with a default, typed answers, "does this look right"
  pictures, hands-on test steps. The user answers there; you read the answers from the inbox.

Server: \`${root}\` (Node, no dependencies, flat-file data in \`data/projects/<slug>/\`). CLI: \`pb\`, installed
on each machine from ${base}/install (section 1). The board needs a login once per machine (\`pb login\`).

## Global rules (every project, every session)

The user sets these on the board (Rules, top right). They may change: read them each session with \`${pb} rules\`.

${rules}

The server refuses a \`look\` hand-off without at least one screenshot or video.

## 1. pb, a login, and a running server (every session, before anything else)

${cliSetupText({ base, version: cliVersion })}
Then, every session:

\`\`\`bash
${ensure}        # exit 0 = up. Otherwise the board is unreachable: tell the user
${pb} whoami     # signed in? (if not: ${pb} login)
\`\`\`

Health check by hand: \`curl -s ${base}/api/health\`. If a \`pb\` call says it cannot reach the server, run
\`${ensure}\` once to confirm, then tell the user the board is unreachable and carry on with work that does not need it.
Do not try to restart or repair the server yourself. If it says "login required", run \`${pb} login\`.

## 2. This project

${settings}

${registered ? '' : `### Register it (once)

\`\`\`bash
${pb} register ${s} --name "<Readable name>" --path <repo root>   # --lanes "PC1,PC2" if hand-offs belong to machines
\`\`\`

Pick a short lower-case slug. Defaults: maxSubagents **0** (the user raises it on the board), no lanes, empty banner.
Then reload this page as \`${base}/onboard/${s}\` to see the settings. Tell the user it is registered.
`}
\`pb\` finds the project from the current directory (the registered \`path\`), or pass \`--project ${s}\` /
\`export PB_PROJECT=${s}\`.

## 3. Register the tasks you already have

- **Task files** in the \`<id>-<slug>.md\` format (a \`# title\` line, then \`State:\`, \`Owner:\`, \`Claimed:\`,
  \`Needs:\`, \`Branch:\`, \`Results:\` lines) import directly; re-running it updates changed files (it upserts by id):

  \`\`\`bash
  ${pb} import-md <tasks dir> --dry-run    # check the parse first
  ${pb} import-md <tasks dir>
  \`\`\`

- **Anything else** (a list in a doc, an issue tracker, your own notes): write JSON and import it:

  \`\`\`bash
  cat > /tmp/tasks.json <<'EOF'
  [{"id": "12", "title": "Fix the save loader", "state": "open", "owner": "", "body": "markdown details..."}]
  EOF
  ${pb} import-json /tmp/tasks.json
  \`\`\`

  Fields: \`id\` (short, e.g. a number; omit and one is assigned), \`title\`, \`state\` (free text: its first word
  picks the column: done/integrated/closed/merged -> Complete; claimed/in-progress/ready-for-integration/review ->
  Being worked on; anything else -> Not started), optional \`status\` (todo|active|done) to force the column,
  \`owner\`, \`branch\`, \`results\`, \`needs\`, \`file\`, \`summary\`, \`body\` (markdown, shown on the card).

- **Open questions** you were tracking (an artifact hand-offs page, a list in chat): post the unanswered ones as
  hand-offs (section 5). Answered history may be imported with \`pb ask-json\` including \`answer\`, \`answeredAt\`,
  \`userUpdatedAt\` and \`ackedAt\` so it shows as done.

Then check the board in the browser matches what you expect, and tell the user what you imported.

## 4. Keep tasks current

\`\`\`bash
${pb} add --title "Short title" --state open --body-file spec.md       # new task (id assigned unless --id)
${pb} update <id> --state claimed --owner worker-3 --branch work/<id>  # someone starts it
${pb} update <id> --state "ready-for-integration" --note "results in ..."
${pb} update <id> --state done --note "merged abc123"
${pb} tasks [--status active]                                          # what is where
\`\`\`

If the project keeps task files as the spec, keep them and the board in step: after editing \`State:\` lines,
re-run \`pb import-md <dir>\` (cheap, upserts). The board is what the user looks at; never leave it stale.

## 5. Ask the user through hand-offs, not only in chat

Anything the user must decide, look at, or do by hand goes on the Hand-offs tab, **with a default** where there is one:

\`\`\`bash
${pb} ask --title "Fog default" --question "Keep volumetric fog on by default?" \\
   --choice "Keep on|as today" --choice "Off|faster on phones" --default "Keep on" --context "why it matters..."
${pb} ask --kind text --title "Repo URL" --question "Which remote should releases use?"
${pb} ask --kind look --title "Shadows A/B" --question "Which looks right?" --media a.png --media b.png --choice A --choice B
${pb} ask --kind look --title "Door animation" --question "Which one is smooth?" --media before.mp4 --media after.mp4 --choice Before --choice After
${pb} ask --kind steps --title "Door walk" --lane pc1 --step "Walk through the door|You load into the hall" --step "Open the map|Marker is on you"
\`\`\`

Kinds: \`choice\` (buttons + note), \`text\` (typed answer), \`look\` (images/videos + buttons + note), \`steps\`
(hands-on checklist; each step gets Looks good / Blocked / Needs work + a note), \`info\` (a notice, no answer). The
user can also send a free **message** from the board; it arrives in the inbox like an answer. Use \`--lane\` when the
project has lanes. Upload files with \`pb upload\`; media URLs are \`/media/<slug>/<file>\`.

While you are using a shared resource the user might touch (a test PC, the GPU), show it:
\`pb busy <lane|all> "Running the GPU matrix"\`, and \`pb busy <lane> --clear\` when done.

## 6. Read answers: the inbox, and acknowledge what you act on

\`\`\`bash
${pb} inbox                 # everything the user answered/said that you have not acknowledged
${pb} ack <id> [--note "recorded as task 14"] [--hide]   # after you have acted on / recorded it
${pb} wait --timeout 1800   # blocks until the user answers something (run it in the background to be notified)
\`\`\`

The inbox is exact: an item is in it from the moment the user answers or edits a note until you \`ack\` it, and it
comes back if they change the answer afterwards. An item with no answer (pb shows \`[withdrawn]\`) means they cleared
it: stop acting on the old answer, treat the question as open again, and \`ack\` it. Check it at the start of a session, whenever the user says they
answered something, and before every status report. Never decide that nothing is new without running \`pb inbox\`.

So that answers reach you while you work, install the hook once per project on each machine:
\`${pb} hook install\` (writes \`.claude/settings.local.json\`; \`--user\` for every project). It takes effect in
sessions started afterwards. Claude Code then runs \`pb hook\` after tool calls and before you stop: when the user has
answered or written something, you are told in the conversation. Act on it as if you had read it in \`pb inbox\`, and
\`ack\` it. The page's **Tell sessions now** reaches you this way.

### Docs: documents for the user to read, edit and present

Anything longer than a hand-off that the user should read or keep (a spec, a design, a report, release notes, a
diagram, a data table, a small HTML page or demo) goes on the project's **Docs** tab instead of only into a file or
chat:

\`\`\`bash
${pb} doc put docs/spec.md --tag spec --note "first draft"    # create or update; id = file name, format from the extension
${pb} doc put report.html --title "GPU timings" --summary "RTX 4080 vs phone"
${pb} docs                                                    # what is there
${pb} doc <id>                                                # read one (marks the user's edit as read)
\`\`\`

Formats: markdown, html, svg, json, csv, code (\`--language\`), text. HTML and SVG run in a sandbox, so a page may
carry its own scripts. The user can edit any doc on the board; their edits show in \`${pb} inbox\` until you read the
doc, so re-read it before you change it, and pass \`--if-version <n>\` when you must not overwrite an edit. Every
save is kept (\`${pb} doc history <id>\`, the last 50). \`${pb} doc url <id>\` prints the full-page view to give
the user; only the user can make a public share link.

### Other projects waiting on yours, and yours on theirs

Other projects can wait on your tasks (they check them, they never change them). \`${pb} needed\` lists your open
tasks someone is waiting on, with their reasons; \`${pb} tasks\` marks them \`[needed by ...]\`. Weigh that when
picking what to do next, and keep those tasks' states exact: "done" tells the waiting project to go ahead, and
won't-fix/superseded tells it to re-plan.

When this project needs work another project owns: \`${pb} deps add <project>/<task id> --why "..."\`, then
\`${pb} deps\` each session. Details: ${base}/deps

## 7. Sub-agents

Before spawning any sub-agent, read the limit fresh: \`${pb} settings\` (maxSubagents) or \`${pb} agents\` (limit +
tasks being worked on). Never have more than maxSubagents running at once; with 0, do the work yourself and do not
spawn. Give each worker a task id, have it set the task's state/owner on the board as it goes (or do it yourself when
it reports), and tell it the board URL (\`${base}/onboard/${s}\`) and its task id.

## 8. Save this to the project's memory (once, so every future session uses the board)

Write a memory file in this project's auto-memory directory (the \`memory/\` path named in your system prompt's
Memory section), then add its line to that directory's \`MEMORY.md\` index. If an older memory describes a different
hand-offs board or task list for this project, update it to point here instead of keeping two.

File \`project_boards.md\`:

\`\`\`markdown
---
name: project-boards
description: "Tasks and hand-offs for this project live on the local Project Boards server (${base}, project ${s}); check the inbox every session"
metadata:
  type: reference
---

This project tracks all work on Project Boards: ${base}/ (project \`${s}\`), server at \`${root}\`.
Instructions: ${base}/onboard/${s}
\`pb\` on this machine: \`<full path of the installed pb>\` (write the real path here; call it by that path).

**How to apply:**
- If \`pb\` cannot connect, tell the user the board is unreachable; never try to restart it.
- Session start: \`pb ensure\`, \`pb whoami\` (not signed in: \`pb login\`, the user approves it in a browser tab),
  then \`pb rules\` (the user's global rules: follow them), \`pb inbox\` and \`pb tasks --status active\`.
- \`pb hook install\` once per project on each machine, so the user's answers reach sessions while they work; a
  "Project Boards: the user has answered" note in the conversation is the inbox: act on it and \`pb ack\`.
- The server for this project is named in \`.project-boards.json\` at the repo root (committed): keep it, and never
  point this project at another server without being asked. \`pb where\` shows what applies.
- \`pb\` says when there is a newer version: run \`pb upgrade\`.
- \`pb self-update\` installs from GitHub releases. Only pass \`--yes\` after the user has agreed to that version.
- The global rules apply to every project and change: never work from memory of them, read \`pb rules\`. (When this
  was saved they required screenshots of each variant for anything judged by eye and a video of each variant for
  anything that plays out over time, as \`look\` hand-offs.)
- Every task is on the board (\`pb add\` / \`pb update <id> --state ...\`); keep task files in step (\`pb import-md\`).
- Questions, by-eye checks and hands-on steps for the user go on the Hand-offs tab with a default (\`pb ask\`),
  not only in chat. Read answers with \`pb inbox\`, \`pb ack\` once acted on; never assume nothing is new.
- Before spawning sub-agents, read \`maxSubagents\` (\`pb settings\`); never exceed it (0 = none).
- Mark shared resources busy while using them (\`pb busy <lane> "..."\`, \`--clear\` after).
- Documents for the user (specs, reports, diagrams, HTML pages) go on the Docs tab with \`pb doc put <file>\`;
  the user's edits to them show in \`pb inbox\`: read them (\`pb doc <id>\`) before changing those docs.
- \`pb needed\`: tasks other projects are waiting on; weigh them when picking work, keep their states exact. If this
  project waits on other projects' tasks, \`pb deps\` each session (${base}/deps).
\`\`\`

\`MEMORY.md\` line:

\`\`\`markdown
- [Project Boards](project_boards.md) — tasks + hand-offs on ${base} (project ${s}); pb ensure, pb inbox each session; maxSubagents limit
\`\`\`

## API reference (if you prefer curl)

All JSON. \`{p}\` = \`/api/projects/${s}\`. Send \`Authorization: Bearer <token>\` (from \`pb login\`, in
\`~/.config/project-boards/credentials.json\`, or made by the user on the board under Access).

| Method and path | Body / query | Does |
|---|---|---|
| GET /api/health | | \`{ok, app: "project-boards"}\` |
| GET /api/projects, POST /api/projects | \`{slug, name, path, lanes, maxSubagents}\` | list / register |
| GET, PATCH {p} | \`{name, path, banner, maxSubagents, lanes, busy: {lane: text or ""}}\` | settings |
| GET {p}/tasks | \`?status=todo\\|active\\|done\`, \`&full=1\` for bodies | list |
| POST {p}/tasks, PATCH/PUT/DELETE {p}/tasks/{id} | task fields, \`note\` appends to its log, \`ifVersion\` | write |
| POST {p}/tasks/import | \`{tasks: [...]}\` | upsert many |
| GET/POST {p}/handoffs, PATCH/DELETE {p}/handoffs/{id} | hand-off fields | write |
| POST {p}/handoffs/import | \`{handoffs: [...]}\` | upsert many (may carry answers) |
| GET {p}/inbox | | unacknowledged answers/messages |
| POST {p}/handoffs/{id}/ack | \`{note, hide}\` | acknowledge |
| GET {p}/wait | \`?timeout=600\` | long-poll until the user answers |
| GET /api/deps | \`?ref=<project>/<id>&from=<you>\` | check tasks you wait on (see ${base}/deps) |
| POST {p}/media?name=f.png | raw bytes | \`{url}\` for media |
| GET {p}/docs, PUT {p}/docs/{id} | \`{title, format, content, tags, note, ifVersion}\` | list / create or update a doc |
| GET {p}/docs/{id}, /raw, /history | \`?version=n\` | a doc, its raw content, its versions |
`;
}

module.exports = { onboardingText };
