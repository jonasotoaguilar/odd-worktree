# pi-odd-worktree — Agent Guide

Read this before changing anything. It is the contract for this repository: one
Pi extension, two agent tools, three panels, no configuration surface.

## Purpose

`pi-odd-worktree` is a Pi extension package. It gives a Pi session:

- two agent tools — `worktree_create` (create a checkout beside the clone and
  start its setup) and `worktree_list` (read-only listing);
- three panels — `/warp` (move the session between checkouts, and remove one),
  `/odd-list` (read this checkout's `odd/tasks/*.md`), `/issues` (read and, when
  permitted, edit this checkout's GitHub issues).

Deleting a checkout and moving the session are human actions only: they happen
through `/warp` (its `ctrl+d`, its selector, a typed name, a queued handoff), and
no agent tool does either. It works in Pi alone, with `git` as the only external
requirement; Gentle Shell is recommended only because the deletion guard reads
its presence records.

## Layout

| Path | Responsibility |
| --- | --- |
| `extensions/odd-worktree-tools.ts` | The **only** Pi entry point. Plain JavaScript under a `.ts` name (`// @ts-nocheck`), so the test copy-to-`.mjs` loader works. Registers the three commands, the two tools, the `worktree-warp` message renderer, and the `session_start` / `session_shutdown` / `tool_call` / `tool_result` / `before_agent_start` hooks. |
| `lib/worktree-git.js` | The git seam: identity, worktree listing, branch validation, the canonical target path `<repo-parent>/<repo-name>-worktrees/<slug>` and its helpers, and the async argv runner. |
| `lib/worktree-registry.js` | The one ownership rule, with no file: a checkout this package created is a directory under `<repo-parent>/<repo-name>-worktrees`, so the path decides. Partitions Git's listing into ours and outside, and parses `git worktree list --porcelain` for the create path. |
| `lib/worktree-create.js` | `worktree_create`'s core: request validation, base resolution, the ODD-named destination, the refusals sentence for sentence, plan execution and the fixed output lines. |
| `lib/worktree-list.js` | `worktree_list`'s rendering: rows, order, detail lines and footers, from one structured row list. It writes nothing. |
| `lib/worktree-hooks.js` | The preparation chain of a create: submodules, local inputs, `copy_changes`, build-cache and asset links, the setup slot, and the clone-local `gentle-ai/worktree-hooks.json` that extends the lists. |
| `lib/worktree-setup.js` | The setup chain: the closed command table one lockfile selects, the plan, and the two notice sentences. |
| `lib/worktree-setup-runner.js` | The tracked background task of a create: runs the planned commands one child at a time, sends their output to its own log under the system temp directory, and reports one notice built from the child process outcome. No state is persisted. |
| `lib/worktree-remove.js` | Git-only removal: `git worktree remove <absolute path>`, branch kept. |
| `lib/worktree-symlinks.js` | Symlink policy for a checkout. |
| `lib/worktree-changes.js` | Pending-change snapshot and transfer (the panel's `changes` selection, and a typed warp's copy). |
| `lib/worktree-session-guard.js` | The active-session guard the panel's `ctrl+d` runs, with the caveats it discloses. |
| `lib/worktree-warp-busy.js` | This session's busy evidence for a warp: agent-task counters, its `job_list` jobs, and the one pending handoff. |
| `lib/worktree-warp-sessions.js` | Warp/fork bookkeeping in the session files the host owns. |
| `lib/checkout-facts.js` | The facts one checkout row shows in the selector. |
| `lib/worktree-card.js` | The `worktree-warp` message renderer (the moved/queued card), composed on the card substrate like the tool cards. |
| `lib/card-style.js` | The one style reader: the live process-wide slot Gentle Shell publishes, then the strict `<home>/card-style.json`, then `float`. It reports the source and the reason it fell back, caches only the document branch, and is re-read on `session_start`. |
| `lib/shell-card.js`, `lib/worktree-cards.js` | The card substrate (rounded frame, palette, tone, elapsed) and the two tools' call/result card factory built on it. |
| `lib/warp-*.js` | The panel: selector and extended list (`warp-selector-view.js`), create wizard (`warp-create-panel.js`, `warp-create-picker.js`), delete confirmation (`warp-delete-confirm.js`). |
| `lib/odd-*.js` | `odd-docs.js` (document discovery and ordering), `odd-view.js` (two-pane reader), `odd-markdown.js` (the shared markdown renderer). |
| `lib/odd-prompt/odd-worktrees.md` | The `## ODD worktrees` prompt prose: one text, no variants. |
| `lib/odd-worktrees-prompt.js` | The append-only injection helper that reads that file. |
| `lib/gh-issues.js` | The `gh` client: checkout repository scope, identity pinning, issue pages, details, labels, assignees, comments, close, and the `viewerPermission` → capability mapping. |
| `lib/issues-view.js`, `lib/issue-preview.js` | The pure `/issues` view and its preview formatter. |
| `lib/tui-paint.js`, `lib/view-layout.js`, `lib/preview-scroll-keys.js`, `lib/clipboard.js`, `lib/open-external.js` | Shared presentation helpers: the one palette, window/layout maths, the one preview scroll decision, clipboard, external opener. |
| `lib/session-auto-name.js`, `lib/session-worktree-register.js` | Session bookkeeping: naming a session after an ODD write, and the host's session-worktree registry entry. |
| `tools/*.test.js`, `tools/fixtures/` | The Node test suites and their fixtures (`load-extension.js`, `gh-*.json`). |

`package.json` ships `extensions`, `lib`, `tools` and `README.md`, and declares
`pi.extensions: ["./extensions/odd-worktree-tools.ts"]`. There are no runtime
`dependencies`; the three `@earendil-works/*` packages are peer dependencies the
host provides.

## Run the suite

```bash
node --test tools/*.test.js            # the whole suite (package.json `test`)
node --test tools/issues-command.test.js   # one suite while iterating
```

Node builtins only: no install step, no lockfile, no network. Node 18 is the
floor `engines` declares; CI additionally runs 20, 22 and 24.

## Invariants — do not break these

1. **One extension entry point.** `package.json` `pi.extensions` is exactly
   `["./extensions/odd-worktree-tools.ts"]`, and `extensions/` holds no other
   file. A second entry point changes what the host loads.
2. **No customize / plugin-tools / Herdr-panel surface.** No customize command,
   no plugin-tools toggles, no Herdr plugin management, no `worktree-mode` file,
   no perf tracing, and no `herdr-gentle:` command name — and no CodeGraph probe,
   command or sync either. `tools/package-surface.test.js` asserts both the loaded
   surface and the source text.
3. **The shipped surface is exactly three commands and two tools.** `/warp`,
   `/odd-list`, `/issues`; `worktree_create`, `worktree_list`. No agent surface
   moves the session or removes a checkout: `/warp` moves the session (its
   `ctrl+d`, the selector, a typed name, a queued handoff) and its `ctrl+d`
   removes a checkout. Each keeps its declared name and label.
4. **Deletion refuses on a live session.** The only front that removes a checkout
   is `/warp`'s `ctrl+d`, and it goes through `lib/worktree-session-guard.js`
   before the pending-change question and again immediately before removal. This
   session's own checkout is refused with "warp first"; another session's is
   refused naming its real session id, or the presence hash plus an explicit
   "could not be resolved". Nothing is auto-warped. The check is best effort:
   stale, unattributable and truncated evidence is disclosed — the panel notifies
   each caveat the guard could not resolve, one notice per caveat — never
   silently dropped and never left blocking forever.
5. **Deletion is git only.** Removal is `git worktree remove <absolute path>`
   (with `--force` only when the caller asked) and the branch is kept. No other
   application is closed, opened or removed on any path — including the panel's
   create and `worktree_create`, which use git and the canonical directory alone.
6. **`/issues` keeps repository identity pinning.** The identity
   (`<host>/<owner>/<repo>`) is pinned when the list loads and bound to every
   read, every mutation and the `o` browser opener. A checkout whose remote moved
   while the reader is open must refuse the mutation with the scope-drift message
   and keep the displayed repository for reads. Failing closed beats guessing a
   repository.
7. **`/issues` capabilities fail closed.** Close, labels and assignees need
   `TRIAGE`; creating a label needs `WRITE`; commenting is ungated. Anything but
   a literal `true` capability means no hint, no editor, no mutation.
8. **The package ships only `extensions`, `lib`, `tools`, `README.md`.** Adding a
   shipped path means changing `files[]` and the package-surface test together.
9. **Fixed argv, never a shell string.** Every child (`git`, `gh`, package
   managers) gets a binary plus an argument array with a bounded timeout.
   Interactive paths await the async runner; nothing blocks the host event loop
   with `spawnSync`.
10. **There is no worktree document.** A create always lands at
    `<repo-parent>/<repo-name>-worktrees/<odd>`, so the path is the whole record:
    which checkouts this package created and which ODD each one serves. No
    `<git-common-dir>/pi-worktrees.json`, no `records`, no lock file, and no second
    file in their place. `lib/worktree-registry.js` answers the one question the
    path answers — is this checkout ours — and nothing reads or writes stored state.
    Two consequences are limits, not open work: a worktree moved somewhere else by
    hand stops being ours (nothing is rewritten to match), and there is nothing to
    migrate or reconcile, so no version boundary can lose a row.
11. **The listing is read-only and has no state.** `worktree_list` reads Git's own
    worktree set and writes nothing, prunes nothing and reads no document: the main
    checkout prints first and unnumbered, then the checkouts under
    `<repo-name>-worktrees` by name, and `all: true` adds the worktrees Git knows
    outside that directory. A row is its directory's basename — which IS the ODD —
    and its branch; there is no `odd:` field, no date, no setup or hooks line and no
    state vocabulary. A directory that exists is a worktree and one that does not is
    simply not listed; nothing is reported as `gone` or `missing`, because nothing
    was stored to go stale. The footer counts the outside worktrees it hides.
12. **One identity per worktree: the directory is the ODD.** A create lands at
    `<repo-parent>/<repo-name>-worktrees/<odd>`; `odd` is a required parameter and
    a required plan input (one path segment, refused with `invalid odd name: …`),
    and there is no second identity to override — no `name` parameter, no
    branch-derived naming. `branch` only decides the git branch, created when it
    is absent and adopted when it exists, so two creates for one ODD are refused
    by `worktree path already exists` naming the ODD path. Existing checkouts are
    never renamed and no record is rewritten to match.
13. **A create never waits for its setup.** `worktree_create` and the panel's
    create both plan the chain in `lib/worktree-setup.js` and start it through
    `lib/worktree-setup-runner.js` as one tracked task per checkout: the task
    spawns the planned command with its own log under the system temp directory
    and persists the state through `recordWorktreeSetup` when the child ends.
    The preparation hooks (`lib/worktree-hooks.js`) run before the answer and the
    setup continues behind it; never await the setup in the create path, because
    that is the hang the split removed. Nothing is skipped, and a child that
    never finishes is terminated at its bound. A record a crash left `running`
    stays the honest state. The completion notice belongs to the caller that
    supplied a `notify` (the panel); the tool front supplies none, so a create
    never fires a `ui.notify` its call did not ask for, and a setup problem is
    never reported as a failed create.
14. **The prompt block is append-only.** The `## ODD worktrees` section reaches
    the model only through `systemPromptOptions.appendSystemPrompt`; no handler
    returns a replacement `systemPrompt` (the bridge drops it) and no existing
    text is removed. It is one text (`lib/odd-prompt/odd-worktrees.md`) with no
    variant selection, idempotent by content, primary sessions only, and
    `ODD_WORKTREE_PROMPT=0` suppresses it.
15. **A warp waits for this session's own agent tasks AND background jobs, and it
    is queued, never thrown away.** While `lib/worktree-warp-busy.js` reports a
    running or queued agent task, or an active job, `/warp` keeps the validated
    handoff PENDING instead of switching, and re-dispatches the same
    `/warp @<token>` from a bounded, unref'd poller once both workloads are idle.
    The request is recorded as pending at QUEUE time, so a second warp in the
    same turn is refused and the pending one is never replaced. Expiry
    (`ODD_WORKTREE_WARP_PENDING_MS`, 30 min default) notifies that nothing moved,
    and every terminal outcome (moved, refused, cancelled, expired, shutdown)
    clears the record. Agent tasks come from the presence counters; jobs come
    from the host's `job_list` tool through the same `ctx.tools` +
    `ctx.executeTool` seam `worktree_create` uses. Only a status field that says
    `running` or `queued` is active — `exited 0`, `failed 1` and `stopped` are
    finished — and a missing tool, a failed call or an unknown answer is
    UNKNOWN, which blocks nothing and is never reported as "no jobs".

## Commits and pull requests

`pr-check.yml` enforces Conventional Commits on the PR title (which becomes the
squash subject) and on every non-merge commit subject:

```
<type>(<optional-scope>): <subject>
feat(warp): keep the current checkout out of the selector
fix(issues)!: refuse a mutation after the remote moves
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`,
`ci`, `style`, `revert`. Scopes are optional and lowercase. The subject is one
line and has no trailing period. Merge commits are exempt. A failing check means
rewrite the commits locally and force-push the branch.

## Cut a release

1. Bump `version` in `package.json`, commit, and tag the exact commit:
   `git tag -a v1.0.0 -m v1.0.0 && git push origin v1.0.0`.
2. `.github/workflows/release.yml` runs on a `v*` tag push (a `v*-*` tag is
   excluded) or on a manual dispatch naming an existing tag. Preflight requires
   the tag to be `v` plus the `package.json` version and stops the run otherwise,
   then the suite runs.
3. The `release` job (environment `release`, `contents: write` and the only
   `id-token: write` in the repository) creates the GitHub Release with
   generated notes, then publishes to npm with provenance over OIDC Trusted
   Publishing. The `verify` job reads the registry from outside and checks the
   release is published for the tag.
4. Curate the notes afterwards by editing the published release
   (`gh release edit v1.0.0 --title … --notes-file …`). No notes file is
   committed.
5. A version npm already serves is skipped, and a published version is
   immutable: fix the cause and cut the next patch tag.

Prerequisites the workflow cannot satisfy by itself: the trusted publisher must
be bound to this repository, `release.yml` and the `release` environment, the
`repository` field must name the public repository the provenance attestation
binds to, and the `release` environment must exist (attach reviewers there if a
release should pause). `npm pack --dry-run` is the check that `files[]` still
lists every shipped surface.

## Local test rules

- **Test the public surface.** Assert what a caller observes: the registered
  commands/tools, the manifest, the command handlers' results, the view's
  rendered lines, the files on disk. Do not read module-internal state.
- **Inject the runners.** Every child process sits behind a seam
  (`runAsync`, an injected `runner`, `hasBinary`, the TUI loader). Tests pass
  fakes; they never spawn real `gh`, a package manager, or anything that reaches
  the network. `tools/fixtures/load-extension.js`
  copies `extensions/odd-worktree-tools.ts` to a scratch `.mjs` with the two Pi
  imports stubbed, loads it against a fake host, and points it at this package's
  `lib/` through `GENTLE_WORKTREE_LIB_DIR`.
- **No network, no live tools.** GitHub responses come from
  `tools/fixtures/gh-*.json` through the injected runner.
- **Temporary state lives outside the worktree.** Use
  `fs.mkdtempSync(path.join(os.tmpdir(), …))`, remove it in teardown/`after()`,
  and never point `TMPDIR` or a cache directory into the repository. A test that
  must write inside the repository removes the path before it ends.
- **Keep it green at the whole-suite level.** Run the focused file while
  iterating, then the full `node --test tools/*.test.js`. CI needs no install
  step; adding a dependency so a test passes is not an option.

## Relevant documentation

| Document | Use when | Path |
| --- | --- | --- |
| README | Install, requirements, panel keys, user-facing behaviour | [`README.md`](README.md) |
| CI matrix and test command | What CI runs and on which Node versions | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| PR gates | Commit and PR-title conventions | [`.github/workflows/pr-check.yml`](.github/workflows/pr-check.yml) |
| Release flow | Tag, environment, OIDC publish, verification | [`.github/workflows/release.yml`](.github/workflows/release.yml) |
