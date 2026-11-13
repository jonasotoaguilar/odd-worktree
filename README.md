# pi-odd-worktree

A Pi extension package for agent worktrees, ODD documents and GitHub issues.
Two agent tools, three panels, one extension entry point. It works in Pi alone,
with `git` as the only external requirement.

## What It Does

`package.json` declares one Pi extension,
`./extensions/odd-worktree-tools.ts`, and that file registers everything below.

| Surface | Kind | What it does |
| --- | --- | --- |
| `worktree_create` | tool | Creates `<repo-parent>/<repo-name>-worktrees/<odd>` on `branch`, registers the checkout in this session and in the clone's document, runs the preparation hooks, and starts the install as a tracked background task. |
| `worktree_list` | tool | Read-only listing: the main checkout first and unnumbered, then numbered rows with ODD, branch and setup state, plus footers counting what it hides. |
| `/warp` | panel | Moves this session to another checkout, and removes one. No argument opens the selector (list, create, delete, extended list); `/warp <name>` jumps straight there. A session with no conversation yet changes checkout **silently** — no fork, no `Warp · moved` card, nothing to carry — and warping back from it is the same empty case. |
| `/odd-list` | panel | Two-pane reader of this checkout's `odd/tasks/*.md`: list on the left, styled markdown on the right. |
| `/issues` | panel | Full-screen reader of this checkout's repository issues — My issues / Assigned / Involved / All — with preview, comments, labels, assignees and close, gated on your repository role. |

Moving the session and removing a checkout are **human actions only**: `/warp`
is the only front for both (its `ctrl+d` removes, the selector and a typed name
move), and no agent tool does either. The agent can create and list.

A checkout has **one identity: its ODD**. Its directory is
`<repo-parent>/<repo-name>-worktrees/<odd>`, beside the principal checkout, so a
worktree is never nested inside another checkout and the folder names the ODD the
checkout serves. `branch` is only the git branch: it is created when it does not
exist and adopted when it does. Two checkouts for one ODD cannot coexist — a
second create for the same ODD is refused by `worktree path already exists: …`,
which is the model, not a limitation.

## Quick Start

| Requirement | Why it is needed |
| --- | --- |
| Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) | Peer dependencies at `*`, supplied by the host. The package installs no runtime dependencies. |
| Node.js >= 18 and `git` | `engines` declares 18 as the floor, and every repository operation is a git child process. |
| `gh`, authenticated (`gh auth login`) | `/issues` only. Without it the command stays registered, says once per session what is missing, and never opens. |
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

It needs only Pi and `git`, with no companion app and no extra service. Gentle
Shell is recommended only for the live-session deletion guard.

`pi.extensions` in `package.json` points at
`./extensions/odd-worktree-tools.ts`, so Pi loads it without any extra
registration. Expected result: `/warp`, `/odd-list` and `/issues` are available
as commands, and the two `worktree_*` tools are offered to the agent.

## Core Workflow

1. **Create** — `worktree_create` with an `odd` and a `branch`, or press `c` in
   `/warp`.
   - `odd` and `branch` are required; `copy_changes` is optional.
   - `odd` IS the checkout's directory: one path segment (letters, digits, dash,
     underscore, dot), nothing that could escape the directory it names. The
     branch never names a directory, so `branch: feat/login` with
     `odd: login-ui` lands in `…-worktrees/login-ui`.
   - The base is the local `main` when it resolves, else the branch `origin/HEAD`
     names, else `init.defaultBranch`. When none of them resolves, the create is
     refused with `could not resolve a base branch: tried main, origin/HEAD,
     init.defaultBranch` before anything is written.
   - Three refusals protect what already exists, each before a single write:
     `worktree path already exists: …` (remove it or pass a different odd),
     `branch … is already checked out in …` (use another branch, or work in that
     worktree), and `branch main is the base branch; pick the branch this worktree
     should work on`.
   - A whitespace-only or otherwise unusable `odd` is refused here with
     `invalid odd name: …` — a deliberate divergence from the reference branch,
     where it would create a directory nobody can see and a record the store must
     then refuse. An omitted `odd` gets the same sentence: the schema asks for it,
     and the plan refuses it if anything reaches the core directly.
   - An existing branch is adopted as-is — the answer's second line says
     `branch: <branch> (existing)`, and `(created)` when the branch was made from
     the base.
   - The answer and the list both print the ODD; a list row for a record written
     before the field existed prints `odd: -`.
   - `copy_changes: true` carries the uncommitted work of the checkout the call
     was made from — the one the session stands in, not necessarily the main
     checkout — into the new checkout: staged, unstaged and untracked
     non-ignored files. The source checkout keeps those changes.
   - **A create is instant.** The checkout, its registry row, its record, the
     session registration and the preparation hooks (submodules, local inputs,
     `copy_changes`, build-cache and asset links) settle before the answer. The
     slow half — the package manager the root's lockfile selects, or nothing when
     no lockfile matches — continues in one tracked background task with its own
     log under the system temp directory. The answer says where the setup stands
     and a later `worktree_list` reports how it ended; a setup problem is never
     reported as a failed create.
2. **List** — `worktree_list`, or open `/warp`. Pass `all: true` to the tool (or
   `v` in the panel) to also see live checkouts Git knows outside the registry and
   the records whose checkout no longer exists. The listing is read-only: it
   writes nothing and prunes nothing, and it shows the state of each row.
3. **Move** — `/warp <name>`, the selector's `enter`, or a typed name. The
   selector never offers the checkout you are already in; the exclusion is by
   resolved real path, so a differently-spelled path to the same checkout is
   excluded too. No agent tool moves the session.
4. **Delete** — `/warp`'s `ctrl+d` on the focused checkout, with a forced removal
   only for a dirty checkout. It asks for confirmation, then re-checks the
   identity of the checkout and the live-session guard immediately before the
   removal. No agent tool removes a checkout.

## Key Features You Should Know About

### Panel keys

`/warp` selector — the footer legend is the key reference.

| Key | Action |
| --- | --- |
| `↑`/`↓`, `j`/`k` | Move the selection |
| `enter` | Warp to the focused checkout (`enter` on the `view all worktrees` row opens the extended list) |
| `c` | Open the create flow: pick the change type, type the change name, then the ODD — `tab`/`←`/`→` walk the three fields, `↑`/`↓` pick the type or step between fields, `enter` on the ODD creates, `esc` cancels |
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

Deleting a checkout is refused while a live Pi session is working in it. The
removal is **`/warp`'s `ctrl+d`**: it runs the guard
(`lib/worktree-session-guard.js`) before the pending-change question and again
immediately before the removal, so a session that starts working in the checkout
while the question is open still refuses there. This session's own checkout is
refused with "warp first"; another session's is refused naming its real session
id, resolved by joining the published presence hash to Gentle Shell's transport
activation record. When no record joins, the refusal shows the presence hash and
says the id could not be resolved — it never invents one from a label. Nothing is
auto-warped and nothing is closed on your behalf.

After a successful removal the panel notifies each caveat the guard could not
resolve, one notice per caveat — never silently dropped. That check is **best
effort, not a guarantee**:

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
caller asked for it. The branch is kept. Nothing else is touched: no other
application is closed, opened or removed on any path.

### A warp waits for this session's own agent tasks and background jobs

A warp never lands while this session still has running or queued agent tasks or
a running background job — and it is never thrown away: the request is
**queued**.

- `/warp` — a typed name, the selector and a create's follow-up warp all share
  one path — gives both sources a bounded chance to drain
  (`ODD_WORKTREE_WARP_BUSY_WAIT_MS`, 60 s by default) and then keeps the request
  **pending** instead of switching: the session stays where it is, and a bounded
  background poller re-dispatches the SAME validated handoff once this session
  reports no running or queued agent task and no running job. Nothing switches
  mid-work. A queued handoff never claims a move.
- **One pending warp per session.** A second warp is refused while one is
  pending, with `a warp to <name> is already pending for this session — it runs
  when the pending agent tasks and background jobs finish; wait for it or let it
  expire` — and the pending request is never replaced.
- The pending warp expires after `ODD_WORKTREE_WARP_PENDING_MS` (30 minutes by
  default, clamped to a day) and notifies that it expired with nothing moved. It
  re-reads both sources every `ODD_WORKTREE_WARP_PENDING_POLL_MS` (2 s by
  default) and its timer never keeps the session alive. A warp that runs, is
  refused or expires clears the queue, so the next request is accepted again.
- The re-dispatched handoff re-checks that the destination checkout and the
  session are still where the request left them: drift refuses the move instead
  of guessing.

Both sources are read **best effort**, and neither is ever guessed:

- **Agent tasks** come from Gentle Shell's presence header for this session,
  through the same bounded reader the deletion guard uses. A heartbeat older than
  15 s is not evidence, and an absent or unreadable store blocks nothing.
- **Background jobs** come from the host's `job_list` tool — the same `ctx.tools`
  + `ctx.executeTool` seam `worktree_create` uses to register a checkout. Each
  row is `id · status · label · elapsed · output`; only a status field that says
  `running` or `queued` (a monitor reports `monitor running`) keeps the warp
  waiting, while `exited 0`, `failed 1` and `stopped` are finished. "Not
  exited" is never read as activity.
- A host that does not offer `job_list`, a call that fails, and an answer this
  parser does not know all count as **unknown**, never as "no jobs": the warp
  still runs, and a `queue:` line says the job state is unknown instead of
  pretending it was read.

### `/issues` pins the repository

The repository identity (`<host>/<owner>/<repo>`) is pinned when the list loads,
and the host is part of it. Every page, detail, label, assignee and comment read
binds that pin, and so do every action and the `o` browser opener. If
the checkout's remote moves while the reader is open, mutations refuse with
`the checkout's repository changed since this issue list loaded (now … instead of
…); reopen /issues`, and the reads keep the displayed repository. An issue
number on screen can never be sent to another repository.

### Worktree state, and the list that reports it

`worktree_list` prints the main checkout first and unnumbered, then one numbered
row per checkout this clone created, each with its ODD, its branch and its setup
state. Footers count the rows the list hides. The text is fixed-field and
undecorated, so it reads the same on every run:

```text
project: repo
path: /code/repo
main: main 1a2b3c4 active · manual
1 worktree-tools feat/worktree-tools odd: bug-42 running (npm ci)
  setup: npm ci · log: /tmp/odd-worktree-setup-abc123/step-1.log
2 billing feat/billing odd: - ready
```

The state vocabulary is closed:

| State | Meaning |
| --- | --- |
| `ready` | the checkout exists and its setup finished |
| `running` | setup is running now; the parenthesis names the step |
| `failed` | setup ended in failure; the row names the log to inspect |
| `skipped` | setup did not run, and the parenthesis says why (no lockfile at the root, or its package manager is not installed) |
| `pending` | the chain is queued and has not started; the parenthesis says why |
| `interrupted` | a `running` or `pending` chain this session wrote whose job its runner no longer holds; another session's record stays `running` because this process cannot tell |
| `active · manual` | the checkout exists and carries no record: Git knows it, this package did not create it |
| `missing` | the path a record names is gone while Git still lists it |
| `gone` | a record whose checkout Git no longer lists; `all: true` shows it |
| `foreign` | the path now belongs to another repository |

The listing is **read-only**: it writes nothing, prunes nothing and never
touches the clone document, so a dead record stays visible as `gone` or `missing`
with its reason and date until a human acts. When the document cannot be read at
all, the list says so and shows what Git knows instead of an empty view that
looks authoritative.

### Where state lives

One document per clone: `<git-common-dir>/pi-worktrees.json`, shared by two
owners that each preserve the other's key verbatim for documents either module
wrote, and by value and key order for a hand-edited one.

- `worktrees` — the registry: one row per checkout with its branch, path and
the session that owns it. The panel and the live-session guard read it.
- `records` — the metadata: per-worktree `odd`, creator, base ref, hook
outcomes and setup state, keyed by canonical path and reconciled against
`git worktree list` on every read.

A version boundary runs through that document. An older release of this package
reads it safely — it requires `worktrees` to be an array and ignores `records` —
but its writers build an explicit `{ version, worktrees }` payload, so the next
registry write from an older process drops `records` and `kind`. Mixing this
version with an older one, or rolling back to an older one after creating
worktrees here, therefore keeps the checkouts and their branches and loses what
`records` held: each worktree's ODD, creator and setup history. Nothing here can
prevent that, because the deletion happens in the older code, and no migration
or recovery exists. Finish or park work before switching versions, and treat a
rollback as losing the metadata, not just the feature.

Session names derived from an ODD write, and the warp's fork/resume bookkeeping,
travel in the Pi session files the host already owns. The setup logs live under
the system temp directory (`odd-worktree-setup-*`), one directory per create.
Nothing is written to user configuration, and there is no second worktree file.

### The `## ODD worktrees` block in the system prompt

The primary session's system prompt gains a short section telling the agent where
a worktree lives and that the directory is the ODD it serves, that an ODD with an
existing assignment is resumed instead of duplicated, to carry pending work that
belongs to it with `copy_changes`, and that after the merge the branch is kept and
the checkout removed unless a live session stands in it. Moving the session stays
the human's.

It is **appended**, never substituted: the block rides
`systemPromptOptions.appendSystemPrompt`, so whatever Gentle Shell (or any other
extension) put there is preserved verbatim and our text lands after it. There is
one text, read from `lib/odd-prompt/odd-worktrees.md` at load. Child and
named-agent sessions get nothing, because their own instructions are already the
bounded task they received. `ODD_WORKTREE_PROMPT=0` suppresses the block.

One limit, stated plainly: a string has no "must be last" flag, so the block's
position follows extension load order. It can sit before a later extension's
short hint; it can never land inside or in place of another extension's text.

### Deliberately absent

This package is the worktree / ODD / issues surface only: two agent tools, three
panels, no customize panel, no plugin-tools toggles, no CodeGraph work, no
companion-app integration, and no worktree↔issue association. There is nothing to
configure, and `/warp`, `/odd-list` and `/issues` are always on. Paths, branches
and arguments reach `git` and `gh` as fixed argv arrays, never as a shell string.

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

The npm package is `pi-odd-worktree`. A release is the tag `v` plus the exact
`package.json` version — version 2.1.0 is `v2.1.0` — and preflight stops the run
when the two disagree. Publication uses
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
