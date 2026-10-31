'use strict';

const { cliSetupText } = require('./cli-setup');

// /enrol: what a Claude Code session reads to put a project on the board from scratch.
function enrolText({ base, root, projects, rules, cliVersion }) {
	const pb = '<pb>';
	const taken = projects.map((p) => `\`${p.slug}\``).join(', ') || 'none';
	return `# Enrol your project on Project Boards

You have been pointed here to put the project you are working in onto **Project Boards**, the user's task board and
hand-offs queue. Read this page to the end, then do the steps in "What you are expected to do".

## What it is, and why the user wants it

Project Boards is a small server on the user's home network (${base}/). The user keeps it open in their browser to see,
for every project they run with Claude, what is being worked on and what is waiting for them. Each project is
separate; a dropdown switches between them. A project's page has two tabs:

- **Tasks**: every unit of work in three columns: **Not started** (nobody is on it: open, blocked, deferred),
  **Being worked on** (claimed, in progress, ready for integration), **Complete** (done, integrated, closed).
- **Hand-offs**: everything that needs the user: decisions with a default, typed answers, pictures to judge by eye,
  hands-on test steps. The user answers on the page; you read the answers from the project's **inbox** and
  acknowledge them once you have acted. The user can also send you free-text messages there.

It replaces task lists kept only in chat or files, and any claude.ai artifact "hand-offs" page. Once a project is on
it, every future session of that project uses it (you will save that to the project's memory).

Each project also has a **sub-agent limit** (0-10, default 0) that the user sets on the board: the most sub-agents
you may have running at once for that project. 0 means you do all the work yourself.

Server code: \`${root}\`. You use it through the \`pb\` command (\`pb help\`) or plain HTTP (JSON). The board
needs a login: \`pb login\` once per machine (below), or a token from the user for plain HTTP
(\`Authorization: Bearer <token>\`).

${cliSetupText({ base, version: cliVersion })}
## Global rules (every project)

The user's rules for all projects. They may change: read them each session with \`${pb} rules\`.

${rules}

## What you are expected to do

1. **Get \`pb\` and sign in** (above), unless this machine already has both.
2. **Check the server is up:** \`${pb} ensure\` (exit 0 = up; otherwise tell the user the board is unreachable, and stop here).
3. **Pick a slug** for the project: short, lower case, letters, digits and \`-\` (taken: ${taken}).
4. **Register** from the project's root directory:

   \`\`\`bash
   ${pb} register <slug> --name "<Readable name>" --path "$(pwd)" [--lanes "PC1,PC2"] [--description "<one line>"]
   \`\`\`

   \`--path\` lets \`pb\` find the project from the current directory later. \`--lanes\` only if hand-offs belong to
   separate machines or people (each lane is a column on the Hand-offs tab). Leave the sub-agent limit alone: the
   user sets it.
5. **Import the work you already track**, in one of the formats below (or ask for a new one, last section). Check the
   result: \`${pb} tasks\` and the page (${base}/#/<slug>/tasks).
6. **Move open questions** for the user onto the Hand-offs tab (\`pb ask\` or JSON, below). Answered history is optional.
7. **Read your project's own instructions** at \`${base}/onboard/<slug>\`. They show its settings and the day-to-day
   commands, and give you the **memory note to save** so future sessions use the board. Save it.
8. **Tell the user** what you registered and imported, and anything you could not.

## Formats we accept today

### A. Task files (markdown, one file per task)

A directory of files named \`<id>-<short-name>.md\` (\`README*.md\` is skipped). The id is the part before the
first \`-\` (letters and digits, e.g. \`12\`, \`99b\`). The first \`# \` line is the title (a leading
\`<id>-<short-name>: \` is dropped). Header lines anywhere in the first 40 lines, each optional:

\`\`\`markdown
# 12-save-loader: Fix the save loader

State: claimed
Owner: worker-3
Claimed: 2026-10-30 09:00
Needs: test PC
Branch: work/12
Results: docs/work/results/12-save-loader/

## Context
Everything after the header lines is the task's details (markdown), shown when the card is opened.
\`\`\`

Import (re-running it updates changed files and leaves the rest alone):

\`\`\`bash
${pb} import-md <tasks dir> --dry-run      # shows how each file parsed and which column it lands in
${pb} import-md <tasks dir>
\`\`\`

### B. Tasks as JSON

An array of objects (or \`{"tasks": [...]}\`). Records with an existing \`id\` are updated, new ones created.

| Field | Required | Meaning |
|---|---|---|
| \`id\` | no | Short id (letters, digits, \`.\` \`_\` \`-\`). Omit and the next number is assigned. |
| \`title\` | yes (new) | One line. |
| \`state\` | no | Free text; its first word picks the column: done, integrated, merged, closed, complete, resolved, cancelled, superseded -> Complete; claimed, in-progress, in, working, ready-for-integration, ready, review, integrating, verifying, testing, wip -> Being worked on; anything else (open, blocked, todo, deferred...) -> Not started. |
| \`status\` | no | \`todo\`, \`active\` or \`done\`: forces the column regardless of \`state\`. |
| \`owner\`, \`claimed\`, \`branch\`, \`results\`, \`needs\`, \`priority\`, \`source\` | no | Strings, shown on the card. |
| \`file\` | no | Path of the task's spec file, if it has one. |
| \`summary\` | no | One-line summary. |
| \`body\` | no | Markdown details. |
| \`note\` | no | Appended to the task's log (who/when kept). |

\`\`\`bash
cat > /tmp/tasks.json <<'EOF'
[
  {"id": "1", "title": "Port the renderer", "state": "done", "owner": "lead", "body": "Merged in abc123."},
  {"id": "2", "title": "Fix the save loader", "state": "in-progress", "owner": "worker-3", "branch": "work/2"},
  {"title": "Write the manual", "state": "open"}
]
EOF
${pb} import-json /tmp/tasks.json        # or: curl -X POST ${base}/api/projects/<slug>/tasks/import -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' -d @/tmp/tasks.json
\`\`\`

### C. Hand-offs (questions for the user) as JSON

An object or an array; \`pb ask-json <file>\` (or POST \`/api/projects/<slug>/handoffs/import\`). For one-off
questions \`pb ask\` is simpler (\`pb help\`).

| Field | Meaning |
|---|---|
| \`id\` | Optional short id; made from the title if omitted. |
| \`kind\` | \`choice\` (buttons + note), \`text\` (typed answer), \`look\` (pictures/videos + buttons + note), \`steps\` (hands-on checklist: each step gets Looks good / Blocked / Needs work + a note), \`info\` (a notice, no answer). |
| \`title\`, \`question\`, \`context\` | What is asked, and why it matters. |
| \`choices\` | \`[{"label": "Keep", "detail": "as today"}, ...]\` or plain strings. |
| \`default\` | The label you will go with if the user just accepts defaults. Always give one when there is a sensible one. |
| \`media\` | \`[{"url": "/media/<slug>/<file>", "kind": "image"|"video", "caption": ""}]\`; upload files with \`pb upload <file>\`. |
| \`steps\` | \`[{"do": "Walk through the door", "expect": "The hall loads"}, ...]\` |
| \`lane\` | A lane id (e.g. \`pc1\`) if the project has lanes. |
| \`order\`, \`visible\`, \`source\` | Sort key; \`false\` hides it; where it came from. |
| \`answer\`, \`note\`, \`answeredAt\`, \`userUpdatedAt\`, \`ackedAt\`, \`ackNote\` | Only when importing history: the user's earlier answer, and that you already acted on it (ISO times). Leave them out for open questions. |

\`\`\`json
[
  {"id": "fog-default", "kind": "choice", "title": "Fog default", "question": "Keep volumetric fog on by default?",
   "choices": [{"label": "Keep on", "detail": "as today"}, {"label": "Off", "detail": "faster on phones"}], "default": "Keep on"},
  {"id": "door-walk-pc1", "kind": "steps", "lane": "pc1", "title": "Door walk",
   "steps": [{"do": "Walk through the door", "expect": "The hall loads"}]}
]
\`\`\`

### D. Anything else: convert it yourself

If your tasks or questions live somewhere else (a table in a doc, an issue tracker export, a claude.ai artifact's
database, your notes), the quickest route is usually to write the JSON in B / C yourself and import it. Do that when
the import is a one-off.

## When none of these fit: ask for your format

If the project keeps its work in a format that should be imported **natively and repeatedly** (e.g. a tracker you
re-sync from, a different task-file layout), file a format request. It lands as a task on the board's own project
("Project Boards (this server)") for the user to see and someone to build; until then, convert by hand (D) or
enter the tasks with \`pb add\`.

\`\`\`bash
${pb} format-request --project <your slug or name> --name "<short name of the format>" \\
   --description "where the data lives, what each field means, how it should map to tasks/hand-offs, one-off or re-sync" \\
   --sample-file <a small, real, redacted example>
\`\`\`

or

\`\`\`bash
curl -X POST ${base}/api/format-requests -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \\
   -d '{"project": "<slug>", "name": "<format>", "description": "...", "sample": "<example text>"}'
\`\`\`

Say what you need: the source (file layout or service), a sample, the mapping you expect (which field is the id,
title, state...), and whether you will re-import. You get back a task id on the \`project-boards\` project; mention it
to the user. You can still register the project and use the board meanwhile.

## After enrolling

Your project's page: \`${base}/onboard/<slug>\` (settings, daily commands, the memory note to save).
`;
}

module.exports = { enrolText };
