# odd-worktree

A Pi package for agent worktrees and ODD documents: create/list/close/warp
checkouts from the agent, drive the same work from the `/warp` panel, and read
the project's `odd/` documents with `/odd-list`.

It runs in Pi alone. Herdr is optional: every Herdr call is attempted first and
falls back to plain `git`, so nothing here requires a Herdr install.

## Surface

Two commands:

| Command | What it does |
|---|---|
| `/warp` | Move this session to another checkout of the project. No argument opens the selector (list, create, delete); `/warp <name>` jumps straight to the flattened branch slug or `principal`. |
| `/odd-list` | Two-pane viewer of this checkout's `odd/` documents: list on the left, styled markdown on the right. |

Four agent tools:

| Tool | What it does |
|---|---|
| `worktree_create` | Create a branch and its checkout from local `main`, register it, run the creation hooks, optionally copy pending changes. |
| `worktree_list` | Read-only listing: principal first, then the session's own checkout, then the rest. Prunes rows whose checkout is gone. |
| `worktree_close` | Remove a registered checkout and keep the branch. Needs `force: true` for a dirty checkout. |
| `worktree_warp` | Queue the session move to another checkout. The tool only queues it as `/warp <handoff>`; the command performs the move when the turn ends. |

Create and close ask for approval when the host offers dialog UI. `list` never
mutates anything.

## Install

```bash
pi install .            # from this directory
```

`package.json` declares `pi.extensions`, so Pi loads
`extensions/odd-worktree-tools.ts` on its own.

## Requirements

- Node.js >= 18 and `git`.
- Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) — peer
  dependencies, provided by the host.
- Optional: `herdr` for workspace association; `codegraph` for the create
  hook's index step. Both are detected at runtime and skipped when absent.

## Where state lives

The registry is per repository at `<git-common-dir>/pi-worktrees.json`, so a
worktree of the same clone sees the same rows. Session names derived from an
ODD write and the warp's fork/resume bookkeeping travel in the Pi session files
the host already owns. Nothing is written to user config.

## Contract worth knowing

- A new branch is born from the LOCAL `main` ref. A repository without a local
  `main` is refused before anything is written, rather than seeding the branch
  from whatever the invoking checkout had.
- `worktree_create` requires `changes`: `"all"`, `"none"`, or an explicit list
  of checkout-relative paths. The create never guesses.
- Paths, branches and arguments reach `git`/`herdr` as fixed argv arrays, never
  as a shell string.
- Refusals are reported, not swallowed: a rejected name, a dirty checkout, or a
  failed move names the reason and leaves the repository as it was.

## Deliberately absent

This package is the worktree/ODD surface only. It has no customize panel, no
plugin-tools toggles, no GitHub issues reader, and no Herdr plugin management —
there is nothing to configure, and the two commands above are always on.

## Tests

```bash
node --test tools/*.test.js
```

`tools/package-surface.test.js`, `tools/worktree-tools.test.js` and
`tools/commands.test.js` cover this package's own surface: registration,
manifest, the three checkout tools against a real temporary repository with a
deliberately unusable Herdr, and both command handlers. The remaining suites
cover the shared `lib/` modules (warp selector view, ODD viewer and document
reader, delete evidence, change transfer, registry, session bookkeeping).

Tests keep every temporary repository, stub binary and extension copy under the
system temp directory and remove them on exit.
