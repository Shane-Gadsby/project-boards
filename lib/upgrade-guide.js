'use strict';

// GET /upgrade: for a session in a project that already uses a board, when pb gained per-project servers (1.6.0).
function upgradeText({ base, cliVersion }) {
	return `# Upgrading to per-project servers

Written for a Claude Code session in a project that already uses Project Boards. Current \`pb\`: **${cliVersion || 'unknown'}**.
This page is on **${base}**.

Until now \`pb\` knew one server. From 1.6.0 one \`pb\` works with any number of them: each project names its own server
in a \`.project-boards.json\` file at its root, and this machine keeps a separate login per server.

**Nothing breaks if you do nothing.** A project without that file keeps using the server its \`pb\` came from, and
existing logins carry over. Do the steps below so the project says where its board is rather than relying on this
machine's default. Moving is not part of this: tasks stay on the server they are on.

## Steps

\`<pb>\` is the full path of the installed \`pb\`; the project's memory note names it.

1. **Find this project's server.** It is the one the project already uses, normally named in its memory note or by
   \`<pb> where\`. Do not guess: if the project should be on a server other than **${base}**, follow these steps on that
   server's \`/upgrade\` page instead, and if you cannot tell, ask the user (\`pb ask\`, with this page's server as the default).

2. **Upgrade pb:**

   \`\`\`bash
   <pb> upgrade
   <pb> version --local      # 1.6.0 or newer
   \`\`\`

   On a machine that has no \`pb\` yet: \`curl -fsSL ${base}/install | sh\`. The server \`pb\` is installed from is
   the one it upgrades from and the default for projects with no \`.project-boards.json\`.

3. **Name the server,** from the project's root directory. The slug is the project's slug on that server
   (\`<pb> projects\` lists them):

   \`\`\`bash
   <pb> use ${base} --project <slug>
   \`\`\`

4. **Check it:**

   \`\`\`bash
   <pb> where        # the server, why it was chosen, whether this machine has a login, and the project
   <pb> whoami
   <pb> inbox
   \`\`\`

   If \`where\` says there is no login, this machine is new to that server: run \`<pb> login\`, which opens a tab for the
   user to approve. A login for one server is never sent to another.

5. **Commit \`.project-boards.json\`.** It holds a URL and a slug, never a token, so it is safe in the repo, and every
   clone then finds the right server. If the repo is public and the server's address is private, add the file to
   \`.gitignore\` instead and tell the user.

6. **Update the project's memory note:** add that the server is named in \`.project-boards.json\`, that it should not be
   changed unless the user asks, and that \`pb where\` shows what applies. Then tell the user it is done.

## Good to know

- **Which server applies:** \`PB_URL\` if set, else \`.project-boards.json\` (found upward from the current directory),
  else the server \`pb\` came from. \`PB_PROJECT\` and \`--project\` still pick the project.
- **Dependencies** (\`pb deps\`, \`pb-deps.json\`) work within one server. A project cannot wait on a task on another
  server yet.
- **If the board cannot be reached,** \`pb\` says so and \`pb ensure\` exits non-zero. \`pb\` no longer tries to restart a
  server. Tell the user the board is unreachable and carry on with work that does not need it; do not try to fix or
  restart it yourself.
- **Old \`pb\` versions** keep working against this server, but only 1.6.0 and newer read \`.project-boards.json\`.
`;
}

module.exports = { upgradeText };
