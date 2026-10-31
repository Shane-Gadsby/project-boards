'use strict';

const { cliSetupText } = require('./cli-setup');

// The text at /deps: how any project or app, on the board or not, keeps track of tasks other projects own.
function depsText({ base, projects, cliVersion }) {
	const pb = '<pb>';
	return `# Project Boards: waiting on another project's tasks

Use this when your project needs work that **another project** owns and tracks on Project Boards (${base}/), and you
want to know when it is done. Your project does not need to be registered on the board, and checking creates nothing
on it: no tasks, no hand-offs. Reading the board does need a login: \`pb login\` once per machine (below), or a
token the user makes on the board (Access) for an app that cannot open a browser. Projects on the board now: ${projects.length ? projects.map((p) => `\`${p.slug}\` (${p.name})`).join(', ') : 'none'}.

## What you can wait on

A **ref** names tasks on another project:

| Ref | Means |
|---|---|
| \`engine/83\` | one task, by id |
| \`engine/tag:demo-app\` | every task with that tag (ask the owning project to tag what you need; new ones join automatically) |
| \`engine/*\` | every task of the project (for a summary; never "met" while any task is open) |

Each one has an **until**: when it counts as met.

| until | Met when |
|---|---|
| \`done\` (default) | the task was completed (done, integrated, merged, closed, ...) |
| \`closed\` | the task is in the Complete column, including won't-fix, superseded, cancelled, duplicate |
| \`active\` | someone has started it, or it is finished |
| a state word, e.g. \`ready-for-integration\` | the task's state starts with that word, or it was completed |

A task closed **without** being done (won't fix, superseded, cancelled, abandoned, duplicate) shows as **DROPPED** and
is not met under \`done\`: re-plan instead of waiting for it.

## With pb (recommended)

${cliSetupText({ base, version: cliVersion })}
\`pb\` keeps the list in a \`pb-deps.json\` file at your repository root, so the
dependencies live with the code that needs them:

\`\`\`bash
${pb} deps add engine/83 --why "the renderer needs this fix"
${pb} deps add engine/tag:demo-app --why "engine fixes demo-app reported"
${pb} deps                 # check: met / waiting / DROPPED per ref, and what CHANGED since the last check
${pb} deps --strict        # same, but exit 1 unless everything is met (for scripts and CI)
${pb} deps --until-change --every 600   # poll; exit when something changed (run in the background to be woken)
${pb} deps rm engine/83
${pb} deps engine/83 engine/84   # a one-off check without the file
\`\`\`

The file:

\`\`\`json
{
	"from": "demo-app",
	"deps": [
		{"ref": "engine/83", "why": "the renderer needs this fix"},
		{"ref": "engine/tag:demo-app", "until": "done"}
	]
}
\`\`\`

\`from\` is how you appear to the owning project ("needed by demo-app" on its board and in its \`pb needed\`), so
the people and sessions working there know someone is waiting and why. It defaults to your registered project's slug,
else the folder name. What each task looked like at the last check is kept in \`~/.cache/project-boards/deps/\`, so
\`pb deps\` can mark changes; the first check is the baseline.

## Over HTTP (any language, any app)

\`$TOKEN\`: the token \`pb login\` saved (\`token\` in \`~/.config/project-boards/credentials.json\`), or one the user
made on the board under Access. A 401 answer means it is missing, revoked or wrong.

\`\`\`bash
curl -s -H "Authorization: Bearer $TOKEN" "${base}/api/deps?from=demo-app&ref=engine/83&ref=engine/tag:demo-app"
curl -s -X POST ${base}/api/deps -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
  -d '{"from": "demo-app", "deps": [{"ref": "engine/83", "until": "done", "why": "..."}]}'
\`\`\`

Answer:

\`\`\`json
{"checked": "...", "from": "demo-app", "met": false, "deps": [
	{"ref": "engine/83", "until": "done", "why": "...", "met": false, "dropped": false,
	 "tasks": [{"id": "83", "title": "...", "state": "open", "status": "todo", "resolution": null, "met": false,
	            "owner": "", "branch": "", "results": "", "updated": "...", "version": 3}]}
]}
\`\`\`

\`status\` is the column (\`todo\`, \`active\`, \`done\`), \`resolution\` is \`completed\` or \`dropped\` once done. A ref that
cannot be resolved gets \`error\` (no such project or task) and is not met; the rest of the answer is still good. Compare
\`version\` between checks to see that a task changed. Leave out \`from\` to check without being listed as waiting.
\`DELETE /api/deps?from=<name>&ref=<ref>\` stops listing you. For instant updates instead of polling, the project's
event stream \`GET /api/projects/<slug>/events\` (Server-Sent Events) carries every task change.

How often: every few minutes is plenty; the check is one cheap request. A waiter that has not checked for 30 days stops
showing on the owning project's board.

## For a Claude Code session in the depending project

Save this to the project's auto-memory (the \`memory/\` directory named in your system prompt) as
\`project_deps.md\`, with its line in \`MEMORY.md\`:

\`\`\`markdown
---
name: project-deps
description: "This project waits on tasks other projects own on Project Boards; check them with pb deps each session"
metadata:
  type: reference
---

Work this project needs from other projects is listed in \`pb-deps.json\` (repo root) and checked against Project Boards
(${base}/deps). Instructions: ${base}/deps

**How to apply:**
- Session start, and before planning anything that relies on another project: \`${pb} deps\`. Treat CHANGED and
  DROPPED lines as news to act on; DROPPED means it will not be done, so re-plan.
- When this project starts depending on new work elsewhere: \`${pb} deps add <project>/<task id> --why "..."\`;
  remove it once no longer needed (\`pb deps rm\`).
- To be woken when something lands: \`${pb} deps --until-change --every 600\` in the background.
\`\`\`

## For the project that owns the tasks

\`pb tasks\` marks tasks other projects wait on (\`[needed by demo-app]\`), \`pb needed\` lists them with each
waiter's reason, and the board shows a "needed by" tag on the task card. Keep those tasks' states current; nothing
else is needed. When a depending project waits on a tag, tag what it needs: \`${pb} update <id> --tag <tag>\`
(\`--untag\` removes it).
`;
}

module.exports = { depsText };
