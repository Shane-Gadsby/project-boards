# User guide: the page

Open your board's address, for example **https://boards.example.com/**. Once
logins are required (Access, below) it first asks for the board's password; you stay signed in on that browser for 30
days of use.

## The top bar

| Control | What it does |
|---|---|
| **Project dropdown** | Switches between projects. Each project's tasks, hand-offs and settings are separate. A number after a name is how many hand-offs are waiting for you there. The last entry, **+ Add a project...**, registers a new one. |
| **Hand-offs** tab | Everything a Claude session needs from you. The red badge counts items waiting for you. |
| **Tasks** tab | The work board. The badge counts tasks being worked on. |
| **Docs** tab | The project's documents. The badge counts them. |
| **Sub-agents: up to N \| M being worked on** | This project's sub-agent limit and how many of its tasks are in progress. |
| Green dot | The page is connected to the server and updates live. Grey means it lost the connection (it reconnects on its own). |
| **Rules** | The global rules every project's Claude sessions follow. |
| **Access** | Logins: whether they are required, the apps and browsers signed in (with Revoke), tokens for scripts. |
| **Sign in / Sign out** | This browser's session. |
| Gear | This project's settings. |

The browser tab title shows `(N)` while N hand-offs wait for you. The address bar keeps the project and tab
(`#/<project>/<tab>`), so a bookmark or a reload comes back to the same place; the page also remembers the last project
you looked at.

A yellow **banner** under the top bar is a one-line message from the project (set in its settings, or by Claude).

## Hand-offs tab

### Message Claude

The box at the top sends a free-text message to the project's Claude session. It lands in the project's inbox like an
answer, and shows under "Answered" until Claude reads it, then under "Done" with Claude's reply note if it left one.

### Waiting for you

Questions Claude has posted and you have not answered yet. If the project has **lanes** (for example one per test PC),
each lane is a column, plus a "Shared" column for items without a lane. A yellow strip at the top of a lane, "Claude is
using this: ...", means a session is driving that machine or resource right now; leave it alone until the strip goes.

Kinds of hand-off:

| Kind | How you answer |
|---|---|
| **Choice** | Click a button. The **default** is marked (dashed border, "default" tag): it is what Claude will do if you just accept defaults. Click the selected button again to clear your answer. Add a note if you like. |
| **Text** | Type in "Your answer". It saves as you type. |
| **Look** | Screenshots or videos, then a choice and an optional note. Click a screenshot to see it full size. Each video plays in place with its own controls (fullscreen included); **Enlarge** under it opens it large, and with several videos **Compare the N videos side by side** opens them all (stacked when they are very wide) with **Play all from start** to watch a before and an after in step. Escape or Close shuts the view and stops the videos. Used for anything judged by eye or over time (see Rules). |
| **Steps** | A hands-on checklist. Each step shows what to do and what should happen, with **Looks good**, **Blocked, see notes** and **Needs work, see notes**, and its own notes box. Click a selected button again to clear it. |
| **Info** | A notice. **Dismiss** hides it. |

Notes and typed answers save automatically about a second after you stop typing. Nothing you type is lost when the page
updates in the background.

### Answered: Claude has not picked these up yet

Everything you answered (or wrote) that the session has not acknowledged. You can still change an answer here; a change
after Claude acknowledged puts it back in this list, so the session sees it again.

**Clear answer** on any answered card, here or under Done, removes your answer and notes and puts the question back in
Waiting. Claude is told, so it stops acting on the old answer. Clicking the selected button or emptying the box does the
same once nothing else is left on the card.

### Done

Answers Claude has acted on, newest first, with "Claude picked this up ..." and its note. Collapsed by default; the
filter box searches ids, titles, questions, answers and notes. These can still be changed or cleared, which tells Claude
again.

## Tasks tab

Three columns:

| Column | Tasks whose state is... |
|---|---|
| **Not started** | open, blocked, deferred, todo, or anything not listed below: nobody is working on it |
| **Being worked on** | claimed, in progress, ready for integration, in review, integrating, verifying, testing |
| **Complete** | done, integrated, merged, closed, resolved, cancelled, superseded |

Not started is sorted by id; the others by most recently changed. Complete shows the 60 newest; **Show all** shows the
rest. The filter box searches ids, titles, owners, states and branches (and shows every match).

Each card shows the id, title, state, owner and when it last changed, and an orange **needed by <project>** tag when
another project is waiting on that task and it is not complete yet (hover for their reasons). Click (or Enter) to open the **details drawer**:
all the task's fields (including **Needed by**: who is waiting on it, why, and when they last checked), its log
(notes with who and when), and its details. In the drawer you can change the **state**
text and click **Set state**; the column follows the state's first word, or pick a column in the dropdown to force one.
Escape or the cross closes the drawer.

**Add task** creates a task with a title, a state (default "open") and details (markdown).

## Settings (gear)

| Setting | Meaning |
|---|---|
| Name | Shown in the dropdown. |
| Path | The project's folder on the machine where its sessions run; `pb` uses it to know which project a session is in. |
| Description | One line, for you. |
| **Sub-agents allowed at once** | 0-10, default 0. The most sub-agents (workers, forks, parallel agents) a Claude session may run at once for this project. 0 means the session does everything itself. Sessions read it before every spawn. |
| Hand-off lanes | Comma-separated names (e.g. `PC1, PC2`) to split "Waiting for you" into columns. Blank for one list. |
| Banner | The one-line message under the top bar. |

The dialog also shows two links with **Copy** buttons:

- **This project's instructions**: `https://boards.example.com/onboard/<project>`, for a Claude session working on it.
- **Enrol a new project from scratch**: `https://boards.example.com/enrol`, for a session whose project is not on the
  board yet.

## Rules

Global rules apply to **every** project. Edit them in the **Rules** dialog: one rule per box, **Add a rule** for another,
empty boxes are removed when you save. Claude sessions read the current rules every session, and both instruction pages
print them. The starting rules:

1. Anything that can be judged by eye (A/B, before/after) comes to you as a **look** with a screenshot of each variant.
2. Anything about behavior over time (animation, flicker, transitions, loading) comes with a **video** of each variant.

The server refuses a look without a screenshot or video. Whether a question should have been a look at all is up to the
session; the rule tells it so.

## Adding a project

Either:

- **+ Add a project...** in the dropdown: a slug (short, lower case, e.g. `my-game`), a name and the folder path; or
- give a Claude session working in that project `https://boards.example.com/enrol` (Copy button in the Add-project
  dialog). It registers the project, imports the tasks it already tracks, moves its open questions over, saves a memory
  note so every later session uses the board, and tells you what it did. If its tasks are in a format the board does
  not read, it files a **format request**, which appears as a task on the **Project Boards (this server)** project.

## Project Boards (this server)

A built-in project for the board itself: format requests and anything else about the server land there as tasks, with a
notice on its Hand-offs tab.

## Docs tab

Documents for the project: specs, reports, notes, diagrams (SVG), small pages (HTML), data (JSON, CSV), code. Claude
sessions add them with `pb doc put`; you can add and edit them here.

| Part | What it does |
|---|---|
| **List** (left) | Newest first; the filter searches titles, tags and summaries. Tags show the format, the doc's tags, **shared** when it has a public link, and **Claude has not read your edit** until a session reads your change. |
| **New doc** | An empty editor (title, format, tags, content). |
| **Edit** | Edit in place: monospace text, Tab inserts a tab, Ctrl+S saves. Tick **Preview** to see it rendered beside the text. "What changed" is kept in the history. If Claude saves the doc while you are editing, a red strip says so and keeps your text: **Save mine over theirs** or **Discard mine, load theirs**. |
| **Present** | Opens the doc on a page of its own (HTML pages fill the window); it follows changes live. |
| **Raw** | The content itself. |
| **History** | Every saved version (the last 50) with who saved it and the note. **View** shows one; from there **Restore this version** saves it as a new version. |
| **Share** | Makes a link anyone can open without signing in (read-only), shown in a green strip with **Copy** and **Stop sharing**. Only you can share; Claude cannot. |
| **Delete** | Deletes the doc and its history (asks first). |

HTML and SVG docs run in a sandbox: their scripts work, but they cannot see your sign-in or the board.

## Access and signing apps in

Each machine that runs Claude sessions signs in once with `pb login`. It opens a tab on this site (or prints a link
and a code): sign in if asked, check the machine and project shown match what you just started, and click **Allow**.
Deny anything you did not start. The machine then appears under **Access**.

The **Access** dialog:

| Part | What it does |
|---|---|
| **Logins** | Optional (signing in works, nothing is refused), Required (the page and every app must sign in), or Off (anyone who can reach the board can use it). Switch to Required once every machine has signed in. |
| **Signed-in apps** | Every app token: name, machine, project, last use and address. **Revoke** signs it out at once (that machine runs `pb login` again). |
| **Make a token** | A token for a script or CI that cannot open a browser. It is shown once; give it to the app as `PB_TOKEN` or `Authorization: Bearer <token>`. |
| **Signed-in browsers** | Your sessions, this one highlighted. Revoke signs that browser out. |

The password itself is changed with `pb-admin set-password` (see [operations.md](operations.md#logins)), which signs
every browser out.
