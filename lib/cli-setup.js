'use strict';

// The "get pb and sign in" steps, shared by /enrol, /onboard and /deps.
function cliSetupText({ base, version }) {
	return `### Get the \`pb\` command and sign this machine in

\`pb\` is one Node script (Node 18+, no packages) that the server publishes (current version: **${version || 'unknown'}**).
Check whether this machine already has it: the project's memory may name its path, or look in the folder below.
\`<pb>\` in the rest of this page means that file's full path; call it by its full path every time (aliases and
\`cd\` do not carry between your shell commands).

1. **Install** (or skip if it is there; \`<pb> version\` says whether it is current):

   \`\`\`bash
   curl -fsSL ${base}/install | sh -s -- <folder>
   \`\`\`

   \`<folder>\`: if the user's instructions say where installed applications go (a CLAUDE.md rule, for example),
   use a \`project-boards\` folder there; otherwise leave \`-s -- <folder>\` off and it goes to
   \`~/.local/share/project-boards/pb\`. The installer checks the download against the published sha256 and prints
   the path.

   **On Windows** (native, not WSL), from PowerShell:

   \`\`\`powershell
   irm ${base}/install.ps1 | iex                                         # -> %LOCALAPPDATA%\\project-boards\\pb
   & ([scriptblock]::Create((irm ${base}/install.ps1))) <folder>         # -> <folder>\\pb
   \`\`\`

   It also writes \`pb.cmd\` beside \`pb\` and adds the folder to the user's PATH. There, \`<pb>\` is
   \`node "<folder>/pb"\` (forward slashes work in Git Bash, PowerShell and cmd), or plain \`pb\` in a new terminal.
2. **Sign in** (once per machine):

   \`\`\`bash
   <pb> login        # prints a link and a code and opens a browser tab; the user signs in there and clicks Allow
   \`\`\`

   It waits (up to 10 minutes) until the user approves, then saves this server's token in
   \`~/.config/project-boards/credentials.json\`. Run it in the background if you need to keep working, and tell
   the user a tab is waiting for them (give them the link it printed, in case the tab did not open). \`<pb> whoami\`
   shows the result. When the board requires logins, a command that says "login required" means: run
   \`<pb> login\` again.
3. **Point the project at this server:** from the project's root directory, run \`<pb> use ${base}\`. It writes
   \`.project-boards.json\`, which names the server for everyone working in this repo: commit it (it holds no secrets).
   One \`pb\` works with any number of servers, with a separate login for each.
4. **Stay current:** when the server \`pb\` came from has a newer \`pb\`, every command says so on stderr; run
   \`<pb> upgrade\`.
`;
}

module.exports = { cliSetupText };
