# pi-odd-worktree

A Pi extension that gives an agent session worktrees, ODD documents and GitHub issues, with `git` as its only external requirement.

## What It Does

Two agent tools, three panels and one sidebar section, loaded from one extension entry point. Each ODD feature gets its own checkout beside the clone, and you move between checkouts and read your ODD documents and issues without leaving Pi.

| Surface | Kind | What it does |
| --- | --- | --- |
| `worktree_create` | tool | Creates `<repo-parent>/<repo-name>-worktrees/<odd>` on a branch, prepares it and starts its install in the background. |
| `worktree_list` | tool | Read-only list of the checkouts this package created, each by its ODD and branch. |
| `/warp` | panel | Moves this session to another checkout, creates one, and removes one. |
| `/odd-list` | panel | Reads this checkout's `odd/tasks/*.md`: list on the left, styled markdown on the right. |
| `/issues` | panel | Reads this checkout's GitHub issues and, when your role allows it, edits them. |
| `ISSUES` rail section | sidebar section | Lists the open issues of this checkout's repository that are assigned to you; a click opens one in your browser. Needs gentle-shell-bridge. |

Moving the session and removing a checkout are human actions: only `/warp` does either, and no agent tool can. A checkout has one identity, its ODD: the directory name is the ODD it serves, and `branch` is only the git branch.

## Quick Start

| Requirement | Why it is needed |
| --- | --- |
| Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) | Peer dependencies supplied by the host; the package installs no runtime dependencies. |
| Node.js >= 18 and `git` | Every repository operation is a `git` child process. |
| `gh`, authenticated (`gh auth login`) | `/issues` and the `ISSUES` rail section. Without it the command stays registered and says what is missing, and the section shows its error row. |
| Gentle Shell (recommended) | Supplies the session records the deletion guard reads to see other sessions. |
| Gentle Shell with `gentle-shell-bridge` and its rail | The `ISSUES` rail section only. Without the bridge nothing is registered and no other surface changes; the package has no dependency on it. |

```bash
pi install npm:pi-odd-worktree
```

Inside a Gentle Shell session, use its launcher instead: `gentle-shell install npm:pi-odd-worktree`. From a local clone, `pi install .` installs the working copy.

Expected result: `/warp`, `/odd-list` and `/issues` are available as commands, the agent is offered `worktree_create` and `worktree_list`, and a Gentle Shell with `gentle-shell-bridge` installed shows an `ISSUES` rail section for this checkout.

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
- **`/issues` pins the repository.** Every read, mutation and browser open is bound to the repository that was loaded, and capabilities fail closed. See [the repository pin](docs/reference.md#issues-pins-the-repository).
- **The issues rail is checkout-scoped and optional.** When a Gentle Shell has `gentle-shell-bridge` installed, an `ISSUES` rail section lists the open issues of this checkout's repository assigned to you — that one repository, not every issue across every repository you touch — and a click opens one in your browser. A frame never waits on `gh`, and with no bridge the section simply never appears. See [the rail section](docs/reference.md#the-issues-rail-section).
- **Cards follow your shell.** Tool and warp cards use the card style Gentle Shell publishes, and a click expands that card only. See [card style](docs/reference.md#card-style-follows-your-shell).
- **Two blocks in the system prompt.** `## ODD worktrees` tells the agent how worktrees and ODDs work. `## CodeGraph` tells a session that already holds a CodeGraph tool how to use it, with one text per role. Both are appended after the host's own text, and `ODD_WORKTREE_PROMPT=0` suppresses them. See [the prompt blocks](docs/reference.md#the--odd-worktrees-block-in-the-system-prompt).
- **CodeGraph stays fresh, only when its CLI is installed.** At session start the package creates or syncs the checkout's index and warms its daemon, and makes sure your global `mcp.json` has the `codegraph` entry (it adds it or fixes only the differing fields and keeps the rest). It also syncs after a compaction, after a native `codegraph init` and after an `edit` or `write`, in the background and without ever blocking you. See [CodeGraph](docs/reference.md#codegraph-index-daemon-and-mcp-entry). Its tool rows are drawn as a card.
- **Deliberately absent.** No customize panel, no plugin-tools toggles, no companion-app integration and no worktree-to-issue association. There is nothing to configure.

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
