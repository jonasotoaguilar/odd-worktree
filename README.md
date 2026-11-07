# odd-worktree

A Pi package for agent worktrees, ODD documents and GitHub issues:
create/list/close/warp checkouts from the agent, drive the same work from the
`/warp` panel, read the project's `odd/` documents with `/odd-list`, and read
this checkout's GitHub issues with `/issues`.

It runs in Pi alone. Herdr is optional: every Herdr call is attempted first and
falls back to plain `git`, so nothing here requires a Herdr install.

## Surface

Three commands:

| Command | What it does |
|---|---|
| `/warp` | Move this session to another checkout of the project. No argument opens the selector (list, create, delete); `/warp <name>` jumps straight to the flattened branch slug or `principal`. |
| `/odd-list` | Two-pane viewer of this checkout's `odd/` documents: list on the left, styled markdown on the right. |
| `/issues` | Full-screen reader of this checkout's repository issues: My issues / Assigned / Involved / All, live server search, issue preview with comments, and label/assignee, comment and close actions when the repository permits them. |

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
- `/issues` needs the GitHub CLI (`gh`) installed and authenticated
  (`gh auth login`). Without it the command stays registered, says once per
  session what is missing and never opens the reader.

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
- Paths, branches and arguments reach `git`/`herdr`/`gh` as fixed argv
  arrays, never as a shell string.
- `/issues` pins the repository identity (`<host>/<owner>/<repo>`) when the
  list loads. Every page, detail, label and assignee read binds it, and so do
  the actions and the `o` browser opener (`gh issue view <n> --web -R`). If the
  checkout's remote moves while the reader is open, mutations refuse and the
  reads keep the displayed repository, so an issue number on screen can never
  be sent to another repository.
- Refusals are reported, not swallowed: a rejected name, a dirty checkout, a
  failed move, or a denied GitHub capability names the reason and leaves the
  repository as it was.

## Deliberately absent

This package is the worktree/ODD/issues surface only. It has no customize
panel, no plugin-tools toggles, no Herdr plugin management, and no
worktree↔issue association — there is nothing to configure, and the three
commands above are always on.

## Tests

```bash
node --test tools/*.test.js
```

`tools/package-surface.test.js`, `tools/worktree-tools.test.js`,
`tools/commands.test.js` and `tools/issues-command.test.js` cover this
package's own surface: registration, manifest, the three checkout tools against
a real temporary repository with a deliberately unusable Herdr, the three
command handlers, and `/issues` end to end against an injected `gh` runner (no
network, no real GitHub mutation). The remaining suites cover the shared `lib/`
modules (warp selector view, ODD viewer and document reader, the GitHub issue
client and view, delete evidence, change transfer, registry, session
bookkeeping).

Tests keep every temporary repository, stub binary and extension copy under the
system temp directory and remove them on exit.
