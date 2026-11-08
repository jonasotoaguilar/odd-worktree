# pi-odd-worktree

A Pi extension package for agent worktrees, ODD documents and GitHub issues.
Four agent tools, three panels, one extension entry point. It works in Pi
alone; Herdr is optional.

## What It Does

`package.json` declares one Pi extension,
`./extensions/odd-worktree-tools.ts`, and that file registers everything below.

| Surface | Kind | What it does |
| --- | --- | --- |
| `worktree_list` | tool | Lists the principal checkout, then this session's own checkout, then the rest, cross-checked against live git checkouts. Rows whose path is gone are excluded and pruned from the registry. |
| `worktree_create` | tool | Creates a branch and its checkout from the **local** `main`, registers it, runs the creation hooks, and copies the pending changes you name. |
| `worktree_warp` | tool | Queues the session move to another checkout as a `/warp` handoff; the command performs the move when the turn ends. |
| `worktree_close` | tool | Removes a registered checkout with `git worktree remove`, keeping the branch, and refuses while a live Pi session is working in it. |
| `/warp` | panel | Moves this session to another checkout: no argument opens the selector (list, create, delete, extended list); `/warp <name>` jumps straight there. A session with no conversation yet changes checkout **silently** — no fork, no `Warp · moved` card, nothing to carry — and warping back from it is the same empty case. |
| `/odd-list` | panel | Two-pane reader of this checkout's `odd/tasks/*.md`: list on the left, styled markdown on the right. |
| `/issues` | panel | Full-screen reader of this checkout's repository issues — My issues / Assigned / Involved / All — with preview, comments, labels, assignees and close, gated on your repository role. |
| `/codegraph-hook` | command | **Only when the CodeGraph CLI is installed.** Turns the edit/write sync on or off for the session. |
| `/codegraph-init` | command | **Only when the CLI is installed.** Runs `codegraph init` at the session's current directory and says what happened: `initialized <path> — 1 file, 3 nodes, 3 edges`, or `already initialized at <path> — nothing to do`. |
| `/codegraph-sync` | command | **Only when the CLI is installed.** Runs `codegraph sync` at the session's current directory and says what happened: `already up to date — nothing to sync`, `synced 3 changed files — 12 nodes`, or `no index in this checkout — run /codegraph-init first`. |

A checkout's **name** is the slug of its branch, and its path is
`<repo-parent>/<repo-name>-worktrees/<slug>`: the slug lowercases the branch and
turns every non-alphanumeric run into `-` (`feat/login` → `feat-login`). The
principal checkout is `principal`. Names, paths and branches are accepted
interchangeably by `worktree_close`, and by `/warp`.

## Quick Start

| Requirement | Why it is needed |
| --- | --- |
| Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) | Peer dependencies at `*`, supplied by the host. The package installs no runtime dependencies. |
| Node.js >= 18 and `git` | `engines` declares 18 as the floor, and every repository operation is a git child process. |
| `gh`, authenticated (`gh auth login`) | `/issues` only. Without it the command stays registered, says once per session what is missing, and never opens. |
| `codegraph` — optional | Keeps each checkout's index fresh: `codegraph init` when a checkout is created, and a background `codegraph sync` after edits and writes. Absent, both stay off for the whole session. |
| Gentle Shell — recommended | Supplies the presence and transport records the deletion guard reads to see sessions other than this one. |

```bash
pi install npm:pi-odd-worktree
```

Inside a Gentle Shell session, the same package is installed through the shell's
launcher:

```bash
gentle-shell install npm:pi-odd-worktree
```

From a local clone, `pi install .` installs the working copy instead. Neither
command takes a version, so the install tracks whatever npm publishes.

Herdr is not required; Gentle Shell is recommended for the live-session deletion
guard.

`pi.extensions` in `package.json` points at
`./extensions/odd-worktree-tools.ts`, so Pi loads it without any extra
registration. Expected result: `/warp`, `/odd-list` and `/issues` are available
as commands, and the four `worktree_*` tools are offered to the agent.

## Core Workflow

1. **Create** — ask the agent for a worktree, or press `c` in `/warp`.
   `worktree_create` needs a `branch` and a mandatory `changes` selection:
   `"all"`, `"none"`, or a list of checkout-relative paths. It never guesses,
   and a repository with no local `main` is refused before anything is written.
   An existing branch is adopted as-is instead of being recreated.
2. **List** — `worktree_list`, or open `/warp`. Pass `all: true` to the tool (or
   `v` in the panel) to also see live checkouts the registry does not know.
3. **Move** — `/warp <name>`, the selector's `enter`, or `worktree_warp`. The
   selector never offers the checkout you are already in; the exclusion is by
   resolved real path, so a differently-spelled path to the same checkout is
   excluded too.
4. **Close** — `worktree_close` with exactly one of `name`, `path` or `branch`,
   plus `force: true` for a dirty checkout. Closing asks for approval when the
   host offers dialog UI; creating never does, because it touches no existing
   data.

## Key Features You Should Know About

### Panel keys

`/warp` selector — the footer legend is the key reference.

| Key | Action |
| --- | --- |
| `↑`/`↓`, `j`/`k` | Move the selection |
| `enter` | Warp to the focused checkout (`enter` on the `view all worktrees` row opens the extended list) |
| `c` | Open the create flow |
| `ctrl+d` | Ask to delete the focused checkout; the extension owns the confirmation, the evidence and the removal |
| `v` | Open the extended list of every other checkout (`↑`/`↓`, `pgUp`/`pgDn`, `enter`, `T` or `/` to filter, `esc` back) |
| `r` | Reload the listing |
| `esc`, `ctrl+c` | Close the panel |

`/odd-list` — `↑`/`↓` select, `t` search (`T` and `/` also open the box), `o`
open the document in `$VISUAL`/`$EDITOR`, `s` toggles the order between `recent`
and `name`, `r` reload, `esc` close. `←`/`→` and `[`/`]` scroll the list; the
document pane pages with `ctrl+j`/`ctrl+k`.

`/issues` — bucket tabs are `My issues`, `Assigned`, `Involved` and `All`.

| Key | Action | Needs |
| --- | --- | --- |
| `↑`/`↓`, `j`/`k` | Move the selection | — |
| `←`/`→` (also `tab`/`shift+tab`) | Switch bucket | — |
| `]`/`[` | Scroll the list one page; the hint is deliberately absent from the footer | — |
| `ctrl+j`/`ctrl+k` | Scroll the preview a page (`ctrl+shift+j/k`, `shift+J/K` and `pgUp`/`pgDn` also work; `ctrl+d`/`ctrl+u` scroll half a page) | — |
| `t` | Open the search box (`T` and `/` also open it) | — |
| `o` | Open the issue in the browser through `gh issue view <n> --web -R` | — |
| `r` | Re-read the list and the preview freshly, and re-read your repository role | — |
| `l` | Labels editor: apply or remove an existing label | triage |
| `a` | Assignee editor | triage |
| `c` | Comment | read access |
| `x` (and `X`) | Close the issue, after the host's confirmation; only `x` rides the legend | triage |
| `esc`, `q`, `ctrl+c` | Close the reader | — |

Creating a **new** label is a separate capability inside the labels editor and
needs `write`, so a triage-only viewer opens the editor normally and sees
neither a create row nor its `n` keybinding. Commenting is deliberately ungated:
GitHub lets anyone with read access comment, so requiring triage would hide an
action the viewer is allowed to take. Anything but a confirmed capability fails
closed — no hint, the key refuses on screen, no editor opens, no mutation is
attempted.

### The deletion guard, and its honest limit

Deleting a checkout is refused while a live Pi session is working in it, and
the **same** check runs for `worktree_close` and for the panel's `ctrl+d`, both
before the pending-change question and again immediately before the removal.
This session's own checkout is refused with "warp first"; another session's is
refused naming its real session id, resolved by joining the published presence
hash to Gentle Shell's transport activation record. When no record joins, the
refusal shows the presence hash and says the id could not be resolved — it never
invents one from a label. Nothing is auto-warped and nothing is closed on your
behalf.

That check is **best effort, not a guarantee**:

- It reads Gentle Shell's presence records (heartbeat plus workspace) and its
  transport activation records when Gentle Shell is installed and running, and
  it always catches the checkout this session stands on.
- A heartbeat older than 15 s cannot prove a session is gone, so it is reported
  in the close output as a stale record instead of blocking the removal forever.
- Live records that published no workspace, and a scan that hit its bound, are
  disclosed too. An absent or unreadable presence store blocks nothing and is
  disclosed as unavailable.
- Gentle Shell's scratch ledger is deliberately not consulted: it records what a
  session *created*, not where it is working.

Removal is `git worktree remove <absolute path>`, with `--force` only when the
caller asked for it. The branch is kept, and **no Herdr workspace is closed,
opened or removed** on any path.

### A warp waits for this session's own agent tasks

A warp never lands while this session still has running or queued agent tasks.
The `worktree_warp` tool refuses **before** it queues anything, and `/warp`
gives the published counters a bounded chance to drain (`ODD_WORKTREE_WARP_BUSY_WAIT_MS`,
60 s by default) before it refuses: the session stays where it is and the notice
says how many tasks are running. The counters are read from Gentle Shell's
presence header for this session, through the same bounded reader the deletion
guard uses.

That check is **best effort, and it does not see background jobs**:

- Agents publish their task counters in the presence header; a heartbeat older
  than 15 s is not evidence, and an absent or unreadable store blocks nothing.
- `bash_background` and `monitor` jobs live in Gentle Shell's in-memory job
  registry, which publishes nothing durable and is not exposed by the Pi host,
  so no warp can observe them. Confirm a job finished before warping.

### `/issues` pins the repository

The repository identity (`<host>/<owner>/<repo>`) is pinned when the list loads,
and the host is part of it. Every page, detail, label, assignee and comment read
binds that pin, and so do every action and the `o` browser opener. If
the checkout's remote moves while the reader is open, mutations refuse with
`the checkout's repository changed since this issue list loaded (now … instead of
…); reopen /issues`, and the reads keep the displayed repository. An issue
number on screen can never be sent to another repository.

### CodeGraph stays fresh, when the CLI is installed

The probe for `codegraph` on `PATH` runs **once per session** and is cached for
everything below. Install the CLI mid-session and nothing changes until the next
start, unless you set `CODEGRAPH_FORCE=1`, which answers "present" without
probing.

- **On creation**, `worktree_create` runs `codegraph init` inside the new
  checkout, so it starts with its own index. A session where the gate answered
  false reports that step as `skipped` and names the gate as the reason; it never
  silently pretends to have indexed anything.
- **On edits**, a successful `edit` or `write` schedules `codegraph sync` for the
  git toplevel of the file touched, so a worktree syncs that worktree. The sync is
  detached: the tool result never waits for it, and a failure never reaches you.
- **Debounced and coalesced.** Rapid edits collapse into one sync after ~2s, and
  an edit that lands while a sync runs starts exactly one more when it ends —
  never a queue.
- **One sync at a time across sessions**, guarded by
  `<root>/.codegraph/pi-sync.lock` holding `{pid, startedAt}`. A lock held by a
  live process means skip (the other session's sync already covers that tree),
  with one bounded retry so the edit that raced it still lands. A dead pid or an
  expired lock is taken over.
- **Skipped when it would be wasted**: no `.codegraph/` in that checkout, or a
  live CodeGraph daemon (`<root>/.codegraph/daemon.pid`, either the JSON record
  1.6 writes or the older bare pid), whose own watcher is already syncing that
  tree.
- **Bounded**: a sync that never finishes is terminated after two minutes so a
  checkout can never be wedged for the rest of the session.

Three commands exist **only when the CLI is present**, and they do not appear at
all otherwise:

| Command | What it does |
| --- | --- |
| `/codegraph-hook` | Turns the edit/write sync on or off for the whole process. No argument toggles; `on`, `off` and `status` say it explicitly. It starts enabled. |
| `/codegraph-init` | Runs `codegraph init` at the session's current directory. |
| `/codegraph-sync` | Runs `codegraph sync` at the session's current directory. |

The toggle lasts for the session — this package writes nothing to user
configuration — so `CODEGRAPH_HOOK=0` is how you start a session with it off.

### The `## ODD worktrees` block in the system prompt

The primary session's system prompt gains a short section telling the agent where
worktrees live, to resume an ODD in its assigned one, and — when `codegraph` is
present — that creation indexes the checkout and edits sync it.

It is **appended**, never substituted: the block rides
`systemPromptOptions.appendSystemPrompt`, so whatever Gentle Shell (or any other
extension) put there is preserved verbatim and our text lands after it. Two
variants exist, with and without the CodeGraph sentences, chosen by the same
session gate. Child and named-agent sessions get nothing, because their own
instructions are already the bounded task they received. `ODD_WORKTREE_PROMPT=0`
suppresses the block.

One limit, stated plainly: a string has no "must be last" flag, so the block's
position follows extension load order. It can sit before a later extension's
short hint; it can never land inside or in place of another extension's text.

### Where state lives

The worktree registry is per repository at `<git-common-dir>/pi-worktrees.json`,
so every worktree of the same clone sees the same rows. Session names derived
from an ODD write, and the warp's fork/resume bookkeeping, travel in the Pi
session files the host already owns. The only other file this package writes is
the short-lived `<root>/.codegraph/pi-sync.lock`. Nothing is written to user
configuration.

### Deliberately absent

This package is the worktree / ODD / issues surface only: no customize panel, no
plugin-tools toggles, no Herdr plugin management, and no worktree↔issue
association. There is nothing to configure, and `/warp`, `/odd-list` and
`/issues` are always on (the three `/codegraph-*` commands follow the CLI).
Paths, branches and arguments reach `git` and `gh` as fixed argv arrays,
never as a shell string.

## Tests

```bash
node --test tools/*.test.js        # package.json `test`
```

The suite uses Node builtins only — no install step, no lockfile, no network.
Every temporary repository, stub binary and extension copy lives under the
system temp directory and is removed on exit. `tools/fixtures/load-extension.js`
copies the extension to a scratch `.mjs` with the two Pi imports stubbed and
loads it against a fake host, which is how the registered commands, tools and
manifest are asserted from the outside.

## CI and releases

| Workflow | Trigger | What it runs |
| --- | --- | --- |
| `ci.yml` | push to `main`, every pull request | `node --test tools/*.test.js` on Node 18, 20, 22 and 24 — the range `engines` declares, 18 as its floor |
| `pr-check.yml` | pull request opened, edited, reopened or synchronized | the PR title and every non-merge commit subject must follow [Conventional Commits](https://www.conventionalcommits.org/), plus one suite run on Node 22 |
| `release.yml` | tag `v*` push, or a manual dispatch naming an existing tag | tag/`package.json` version parity, the suite, the GitHub Release, then `npm publish`, then verification |

The npm package is `pi-odd-worktree`, published at 0.1.0. A release is the tag
`v` plus the exact `package.json` version — the 1.0.0 release is `v1.0.0` — and
preflight stops the run when the two disagree. Publication uses
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers): `id-token:
write` is granted to the `release` job and nowhere else, and no npm credential
exists in the workflow or in the protected environment. A version npm already
serves is reported and left alone; a published version is immutable.

The `release` environment is where a release pauses for approval when reviewers
are attached to it, and the trusted publisher binds to this workflow file plus
that environment name. Publication therefore needs the trusted publisher bound
to this repository, this workflow file and the `release` environment, and the
provenance attestation binds to the public `repository` `package.json` names,
case-sensitively.

Release notes are generated when the GitHub Release is created and curated
afterwards by editing the published release (`gh release edit`); no notes file is
committed.

Cutting a release, contributor rules and the repository invariants are in
[`AGENTS.md`](AGENTS.md).

## Documentation

| Your task | Start here |
| --- | --- |
| Change the package, run the suite, cut a release | [`AGENTS.md`](AGENTS.md) |
| Report a bug or request a feature | [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) |
| Open a pull request | [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) |

## Next Steps

- Run `/warp` in a repository with at least one other checkout to see the
  selector, then `worktree_list` from the agent to confirm both surfaces agree.
- Install `gh` and authenticate if you want `/issues`; run `gh auth login` once.
- Install Gentle Shell if the deletion guard should see sessions other than the
  one you are in.
