# pi-odd-worktree

A Pi extension that gives an agent session worktrees, ODD documents and GitHub issues, with `git` as its only external requirement.

## What It Does

Two agent tools, three panels, one sidebar section and one tool-design line, loaded from one extension entry point. Each ODD feature gets its own checkout beside the clone, and you move between checkouts and read your ODD documents and issues without leaving Pi.

| Surface | Kind | What it does |
| --- | --- | --- |
| `worktree_create` | tool | Creates `<repo-parent>/<repo-name>-worktrees/<odd>` on a branch, prepares it and starts its install in the background. |
| `worktree_list` | tool | Read-only list of the checkouts this package created, each by its ODD and branch. |
| `/warp` | panel | Moves this session to another checkout, creates one, and removes one. |
| `/odd-list` | panel | Reads this checkout's `odd/tasks/*.md`: list on the left, styled markdown on the right. |
| `/issues` | panel | Reads this checkout's GitHub issues — the three scoped tabs on open, every open issue behind `g` — and, when your role allows it, edits them. |
| `ISSUES` rail section | sidebar section | Lists the open issues of this checkout's repository assigned to you, seven at a time plus a count of the rest; a click opens that issue in `/issues` on `Assigned` and the overflow row opens `/issues`. Needs `gh` and gentle-shell-bridge with its rail. |
| `activity` tools design | design on the bridge's `Card tools` line | Optional: `/gentle:customize` → `Cards` → `Card tools`, with `default` (the host's own card) and `activity`, which is selected for you on the first run. It covers `bash` and the read-only tools `grep`, `find`, `ls` and `read`: a bash card's heading names what the command does, each family in its own theme colour (`⌕ exploring`, `✓ checking`, …; an unnamed command reads `$ bash`), and those four are always `⌕ exploring`. A finished call shows its duration on the closing rule and the frame turns `warning` while the call runs and `error` when it fails. Needs gentle-shell-bridge 0.6.0 or newer for the one `Card tools` row over the five tools; on 0.5.0 the row is `Card bash`, covers bash alone and keeps everything above for bash cards. Registered through gentle-shell-bridge's `registerToolDesign`; the bridge owns the choice, remembers it and repaints cards already on screen. |

Moving the session and removing a checkout are human actions: only `/warp` does either, and no agent tool can. A checkout has one identity, its ODD: the directory name is the ODD it serves, and `branch` is only the git branch.

The tools card is a design, not a preference of this package: it adds the value `activity` to the bridge's own line, `Card tools` on a bridge that can put several tools on one (0.6.0 and later) and `Card bash` on anything older, which keeps `default` (the host's own card, stored as `native`) available. On the first run, and only when you have not chosen yet, the package selects `activity` once — before it registers the design, so a 0.6.0 bridge carries that choice over to the grouped line — and a later choice of `default` is never undone. The colours are theme roles, so a theme that gives two roles the same colour draws those two families alike. Load order does not matter. See [the cards the `activity` design paints](docs/reference.md#the-cards-the-activity-design-paints).

## Quick Start

| Requirement | Why it is needed |
| --- | --- |
| Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) | Peer dependencies supplied by the host; the package installs no runtime dependencies. |
| Node.js >= 18 and `git` | Every repository operation is a `git` child process. |
| `gh`, authenticated (`gh auth login`) | `/issues` and the `ISSUES` rail section. Without it the command stays registered and says what is missing, and the section shows its error row. |
| Gentle Shell (recommended) | Supplies the session records the deletion guard reads to see other sessions. |
| Gentle Shell with `gentle-shell-bridge` and its rail | The `ISSUES` rail section, and the `activity` value of the `Card tools` line (or `Card bash`, on a bridge older than 0.6.0) in `/gentle:customize` → `Cards`. Without the bridge neither is registered and no other surface changes, apart from one warning in a primary session naming `pi install npm:gentle-shell-bridge`; the package has no dependency on it. |

```bash
pi install npm:pi-odd-worktree
```

Inside a Gentle Shell session, use its launcher instead: `gentle-shell install npm:pi-odd-worktree`. From a local clone, `pi install .` installs the working copy.

Expected result: `/warp`, `/odd-list` and `/issues` are available as commands, the agent is offered `worktree_create` and `worktree_list`, a Gentle Shell whose `gentle-shell-bridge` is installed and whose rail is drawn shows an `ISSUES` section for this checkout, and its `/gentle:customize` → `Cards` page offers `activity` on its `Card tools` line — `Card bash` on a bridge older than 0.6.0.

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
- **`/issues` opens on three tabs, not four.** The bar is `My issues`, `Assigned` and `Involved`; `All` is the `g` shortcut's own view, read the first time you enter it and reused after that, with the footer saying `g all issues` outside it and `g related issues` inside. A typed filter spans the three tabs and travels with you into `All`, which then reads a capped search and says so instead of claiming an exact total. See [the tabs, the shortcut and the filter](docs/reference.md#issues-three-tabs-one-shortcut-one-filter).
- **`/issues` can open on one issue.** `/issues 42` (or `/issues #42`) opens the panel on `Assigned` with that issue selected, and a number that tab cannot find says so instead of guessing a row.
- **`/issues` pins the repository.** Every read, mutation and browser open is bound to the repository that was loaded, and capabilities fail closed. See [the repository pin](docs/reference.md#issues-pins-the-repository).
- **The issues rail is checkout-scoped and optional.** When a Gentle Shell has `gentle-shell-bridge` installed and draws its rail, an `ISSUES` rail section lists the open issues of this checkout's repository assigned to you — that one repository, not every issue across every repository you touch — seven at a time, with `and N more issues` for the rest and a pull-request mark on the issues that already have one. A click opens that issue in the `/issues` panel on `Assigned`, not in a browser: the click first proves the number belongs to this checkout, so a row left over from another checkout — or a checkout whose repository cannot be proven — opens nothing instead of guessing, and `/issues`' own `o` key is still the browser. The overflow row opens `/issues` with no number. While the rail's cache holds this repository, `/issues` paints its first frame from it and reads one tab at mount instead of three, the other two reading the first time you open them. A frame never waits on `gh`: nothing is read at `session_start`, the rows refresh behind a 30 s floor while the section is being drawn — measured on the last attempt, so a failing `gh` is not retried every turn — there is no polling, and a failed refresh keeps the rows and marks them `stale` rather than emptying the list. With no bridge the section simply never appears; the one thing you get is a single warning naming the install command, in a primary session only. See [the rail section](docs/reference.md#the-issues-rail-section).
- **Cards follow your shell.** Tool and warp cards use the card style Gentle Shell publishes, and a click expands that card only. See [card style](docs/reference.md#card-style-follows-your-shell).
- **Tool headings can name the activity.** With `activity` chosen on the `Card tools` line, a bash card whose heading shows the whole command is headed with the family its command names (mark and word) instead of `$`, and a `grep`, `find`, `ls` or `read` card is headed `⌕ exploring` instead of its own glyph and name; a bash command the classifier cannot name, or a heading that hides part of it, keeps the host's `$`. See [the cards the `activity` design paints](docs/reference.md#the-cards-the-activity-design-paints).
- **`bash` cannot create or list worktrees, or branch off the principal checkout.** A `git worktree add` or `git worktree list` is refused in any cwd and pointed at `worktree_list` and `worktree_create`; in the principal checkout, creating a branch or switching to anything but the default branch is refused too. See [the guards](docs/reference.md#the-bash-guards).
- **Two blocks in the system prompt.** `## ODD worktrees` tells the agent how worktrees and ODDs work. `## CodeGraph` tells a session that already holds a CodeGraph tool how to use it, with one text per role. Both are appended after the host's own text, and `ODD_WORKTREE_PROMPT=0` suppresses them. See [the prompt blocks](docs/reference.md#the--odd-worktrees-block-in-the-system-prompt).
- **CodeGraph stays fresh, only when its CLI is installed.** At session start the package creates or syncs the checkout's index and warms its daemon, and makes sure your global `mcp.json` has the `codegraph` entry (it adds it or fixes only the differing fields and keeps the rest). It also syncs after a compaction, after a native `codegraph init` and after an `edit` or `write`, in the background and without ever blocking you. See [CodeGraph](docs/reference.md#codegraph-index-daemon-and-mcp-entry). Its tool rows are drawn as a card.
- **Two reminders keep a session on the CodeGraph rule.** The first `grep`, `find`, `ls`, `read` or `bash` search in a checkout gets one sentence appended to its result: use `codegraph` first, or — for another checkout — call `mcp__codegraph__codegraph_explore` with that path as `projectPath`. Once per checkout, once per session, never a block. See [the reminders](docs/reference.md#the-two-codegraph-reminders).
- **Deliberately absent.** No customize panel, no plugin-tools toggles, no companion-app integration and no worktree-to-issue association. There is nothing to configure here: the design is chosen on the bridge's own `Card tools` line (or `Card bash`, on an older bridge).

## Documentation

| Your task | Start here |
| --- | --- |
| Look up a panel key | [Panel keys](docs/reference.md#panel-keys) |
| Understand a create, a warp or a delete in detail | [Reference](docs/reference.md) |
| Run the suite or see what CI and releases do | [Tests](docs/reference.md#tests), [CI and releases](docs/reference.md#ci-and-releases) |
| Change the package, follow its invariants or cut a release | [`docs/codebase/mental-model.md`](docs/codebase/mental-model.md) |
| Report a bug or request a feature | [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) |
| Open a pull request | [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) |

## Next Steps

- Run `/warp` in a repository with at least one other checkout to see the selector, then `worktree_list` from the agent to confirm both surfaces agree.
- Install `gh` and run `gh auth login` once if you want `/issues`.
- Install Gentle Shell if the deletion guard should see sessions other than the one you are in.
