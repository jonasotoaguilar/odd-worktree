# pi-odd-worktree

A Pi extension that gives an agent session worktrees, ODD documents and GitHub issues, with `git` as its only external requirement.

## What It Does

Two agent tools, four panels, one sidebar section and one preference, loaded from one extension entry point. Each ODD feature gets its own checkout beside the clone, and you move between checkouts and read your ODD documents, files and issues without leaving Pi.

| Surface | Kind | What it does |
| --- | --- | --- |
| `worktree_create` | tool | Creates `<repo-parent>/<repo-name>-worktrees/<odd>` on a branch, prepares it and starts its install in the background. |
| `worktree_list` | tool | Read-only list of the checkouts this package created, each by its ODD and branch. |
| `/warp` | panel | Moves this session to another checkout, creates one, and removes one. |
| `/odd-list` | panel | Reads this checkout's `odd/tasks/*.md`: list on the left, styled markdown on the right. |
| `/files` | panel | Browses one checkout's files with a live, language-coloured preview: `enter` pastes the chosen paths into your prompt, `ctrl+e` opens the file in `$EDITOR`. |
| `/issues` | panel | Reads this checkout's GitHub issues — the three scoped tabs on open, every open issue behind `g` — and, when your role allows it, edits them. |
| `ISSUES` rail section | sidebar section | Lists the open issues of this checkout's repository assigned to you, seven at a time plus a count of the rest; a click opens that issue in `/issues` on `Assigned` and the overflow row opens `/issues`. Needs `gh` and gentle-shell-bridge with its rail. |
| `/card:bash` | preference | Flips a `bash` tool call between this package's activity card, the default, and the host's own drawing. |

Moving the session and removing a checkout are human actions: only `/warp` does either, and no agent tool can. A checkout has one identity, its ODD: the directory name is the ODD it serves, and `branch` is only the git branch.

`/card:bash` is the one preference the package owns: with no argument it toggles between our activity card (`own`, the default) and the host's own drawing of `bash` (`default`), and remembers the choice. It is also the answer to "why does my bash output look like a card" — turn it off with `/card:bash`. See [the bash card](docs/reference.md#the-bash-card-and-its-toggle).

## Quick Start

| Requirement | Why it is needed |
| --- | --- |
| Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) | Peer dependencies supplied by the host; the package installs no runtime dependencies. |
| Node.js >= 18 and `git` | Every repository operation is a `git` child process. |
| `gh`, authenticated (`gh auth login`) | `/issues` and the `ISSUES` rail section. Without it the command stays registered and says what is missing, and the section shows its error row. |
| Gentle Shell (recommended) | Supplies the session records the deletion guard reads to see other sessions. |
| Gentle Shell with `gentle-shell-bridge` and its rail | The `ISSUES` rail section only. Without the bridge nothing is registered and no other surface changes, apart from one warning in a primary session naming `pi install npm:gentle-shell-bridge`; the package has no dependency on it. |

```bash
pi install npm:pi-odd-worktree
```

Inside a Gentle Shell session, use its launcher instead: `gentle-shell install npm:pi-odd-worktree`. From a local clone, `pi install .` installs the working copy.

Expected result: `/warp`, `/odd-list`, `/files`, `/issues` and `/card:bash` are available as commands, the agent is offered `worktree_create` and `worktree_list`, and a Gentle Shell whose `gentle-shell-bridge` is installed and whose rail is drawn shows an `ISSUES` section for this checkout.

## Core Workflow

1. **Create** a checkout with `worktree_create` (an `odd` and a `branch`) or press `c` in `/warp`. It answers at once; the install continues in the background.
2. **List** with `worktree_list` or by opening `/warp`.
3. **Move** with `/warp <name>`, or pick a checkout in the selector.
4. **Delete** with `ctrl+d` on a checkout in `/warp`, after its confirmation.

The full rules of each step, including every refusal, are in [Create, list, move and delete, in detail](docs/reference.md#create-list-move-and-delete-in-detail).

## Key Features You Should Know About

- **A create is instant and writes no state.** The directory is the whole record; there is no list file and no lock file.
- **Deleting refuses on a live session.** The guard reads Gentle Shell's presence records, discloses what it could not resolve, and never auto-warps. Removal is `git worktree remove` and the branch is kept. See [the deletion guard](docs/reference.md#the-deletion-guard-and-its-honest-limit).
- **A warp is queued, never dropped.** While this session's tools, agent tasks or background jobs are still running, `/warp` keeps the request pending and moves when they finish. See [the queued warp](docs/reference.md#a-warp-waits-for-this-sessions-own-tools-agent-tasks-and-background-jobs).
- **`/files` lists one checkout's files and pastes them.** When the clone has more than its principal checkout it asks for a scope first (`main`, then the checkouts this package created, most recently modified first); `ctrl+o` cycles `modified`, `path` and `ext`, and the preview is read-only, bounded and coloured from your active theme. `enter` inserts `@`-prefixed paths — a file of another checkout travels as its absolute path instead, because `@` would resolve against the wrong directory — and `ctrl+e` opens the highlighted file in `$VISUAL`/`$EDITOR`. With gentle-shell-bridge installed it also appears as the `files` keymap action (`alt+p`, editable in Customize → Keymaps) and in the palette's `Session` section. See [the file picker](docs/reference.md#files-the-picker-its-scopes-and-its-orders).
- **`/issues` opens on three tabs, not four.** The bar is `My issues`, `Assigned` and `Involved`; `All` is the `g` shortcut's own view, read the first time you enter it and reused after that, with the footer saying `g all issues` outside it and `g related issues` inside. A typed filter spans the three tabs and travels with you into `All`, which then reads a capped search and says so instead of claiming an exact total. See [the tabs, the shortcut and the filter](docs/reference.md#issues-three-tabs-one-shortcut-one-filter).
- **`/issues` can open on one issue.** `/issues 42` (or `/issues #42`) opens the panel on `Assigned` with that issue selected, and a number that tab cannot find says so instead of guessing a row.
- **`/issues` pins the repository.** Every read, mutation and browser open is bound to the repository that was loaded, and capabilities fail closed. See [the repository pin](docs/reference.md#issues-pins-the-repository).
- **The issues rail is checkout-scoped and optional.** When a Gentle Shell has `gentle-shell-bridge` installed and draws its rail, an `ISSUES` rail section lists the open issues of this checkout's repository assigned to you — that one repository, not every issue across every repository you touch — seven at a time, with `and N more issues` for the rest and a pull-request mark on the issues that already have one. A click opens that issue in the `/issues` panel on `Assigned`, not in a browser: the click first proves the number belongs to this checkout, so a row left over from another checkout — or a checkout whose repository cannot be proven — opens nothing instead of guessing, and `/issues`' own `o` key is still the browser. The overflow row opens `/issues` with no number. While the rail's cache holds this repository, `/issues` paints its first frame from it and reads one tab at mount instead of three, the other two reading the first time you open them. A frame never waits on `gh`: nothing is read at `session_start`, the rows refresh behind a 30 s floor while the section is being drawn — measured on the last attempt, so a failing `gh` is not retried every turn — there is no polling, and a failed refresh keeps the rows and marks them `stale` rather than emptying the list. With no bridge the section simply never appears; the one thing you get is a single warning naming the install command, in a primary session only. See [the rail section](docs/reference.md#the-issues-rail-section).
- **Cards follow your shell.** Tool and warp cards use the card style Gentle Shell publishes, and a click expands that card only. See [card style](docs/reference.md#card-style-follows-your-shell).
- **Bash rows are cards too, and the toggle is yours.** While `/card:bash` is `own` (the default) every `bash` call is drawn as the activity its command names, with that family's mark and word, or the generic `$ bash` when the command names nothing; `default` leaves bash to the host's own drawing. See [the bash card](docs/reference.md#the-bash-card-and-its-toggle).
- **`bash` cannot create or list worktrees, or branch off the principal checkout.** A `git worktree add` or `git worktree list` is refused in any cwd and pointed at `worktree_list` and `worktree_create`; in the principal checkout, creating a branch or switching to anything but the default branch is refused too. See [the guards](docs/reference.md#the-bash-guards).
- **Two blocks in the system prompt.** `## ODD worktrees` tells the agent how worktrees and ODDs work. `## CodeGraph` tells a session that already holds a CodeGraph tool how to use it, with one text per role. Both are appended after the host's own text, and `ODD_WORKTREE_PROMPT=0` suppresses them. See [the prompt blocks](docs/reference.md#the--odd-worktrees-block-in-the-system-prompt).
- **CodeGraph stays fresh, only when its CLI is installed.** At session start the package creates or syncs the checkout's index and warms its daemon, and makes sure your global `mcp.json` has the `codegraph` entry (it adds it or fixes only the differing fields and keeps the rest). It also syncs after a compaction, after a native `codegraph init` and after an `edit` or `write`, in the background and without ever blocking you. See [CodeGraph](docs/reference.md#codegraph-index-daemon-and-mcp-entry). Its tool rows are drawn as a card.
- **Two reminders keep a session on the CodeGraph rule.** The first `grep`, `find`, `ls`, `read` or `bash` search in a checkout gets one sentence appended to its result: use `codegraph` first, or — for another checkout — call `mcp__codegraph__codegraph_explore` with that path as `projectPath`. Once per checkout, once per session, never a block. See [the reminders](docs/reference.md#the-two-codegraph-reminders).
- **Deliberately absent.** No customize panel, no plugin-tools toggles, no companion-app integration and no worktree-to-issue association. There is nothing to configure beyond the one bash-card preference.

## Documentation

| Your task | Start here |
| --- | --- |
| Look up a panel key | [Panel keys](docs/reference.md#panel-keys) |
| Understand a create, a warp or a delete in detail | [Reference](docs/reference.md) |
| Run the suite or see what CI and releases do | [Tests](docs/reference.md#tests), [CI and releases](docs/reference.md#ci-and-releases) |
| Change the package, follow its invariants or cut a release | [`AGENTS.md`](AGENTS.md) |
| Report a bug or request a feature | [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) |
| Open a pull request | [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) |

## Next Steps

- Run `/warp` in a repository with at least one other checkout to see the selector, then `worktree_list` from the agent to confirm both surfaces agree.
- Install `gh` and run `gh auth login` once if you want `/issues`.
- Install Gentle Shell if the deletion guard should see sessions other than the one you are in.
