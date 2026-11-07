# pi-odd-worktree — Agent Guide

Read this before changing anything. It is the contract for this repository: one
Pi extension, four agent tools, three panels, no configuration surface.

## Purpose

`pi-odd-worktree` is a Pi extension package. It gives a Pi session:

- four agent tools — `worktree_list`, `worktree_create`, `worktree_close`,
  `worktree_warp`;
- three panels — `/warp` (move the session between checkouts), `/odd-list`
  (read this checkout's `odd/tasks/*.md`), `/issues` (read and, when permitted,
  edit this checkout's GitHub issues).

It works in Pi alone. Herdr is optional and never required.

## Layout

| Path | Responsibility |
| --- | --- |
| `extensions/odd-worktree-tools.ts` | The **only** Pi entry point. Plain JavaScript under a `.ts` name (`// @ts-nocheck`), so the test copy-to-`.mjs` loader works. Registers the three commands (plus the three `/codegraph-*` ones when the CLI is present), the four tools, the `worktree-warp` message renderer, and the `session_start` / `session_shutdown` / `tool_call` / `tool_result` / `before_agent_start` hooks. |
| `lib/worktree-git.js` | The git seam: identity, worktree listing, branch validation, the flattened target path `<repo-parent>/<repo-name>-worktrees/<slug>` (`feat/login` → `feat-login`), the async argv runner, and the single authority for resolving the `herdr` binary. |
| `lib/worktree-registry.js` | The per-repository registry at `<git-common-dir>/pi-worktrees.json`. |
| `lib/worktree-*.js` (rest) | Checkout behaviour: creation hooks (`worktree-hooks.js`), symlink policy (`worktree-symlinks.js`), pending-change transfer (`worktree-changes.js`), the active-session guard (`worktree-session-guard.js`), git-only removal (`worktree-close-herdr.js`), warp/fork bookkeeping (`worktree-warp-sessions.js`), result text (`worktree-model-result.js`) and the tool card (`worktree-card.js`), checkout facts (`checkout-facts.js`). |
| `lib/warp-*.js` | The panel: selector and extended list (`warp-selector-view.js`), create wizard (`warp-create-panel.js`, `warp-create-picker.js`), delete confirmation (`warp-delete-confirm.js`). |
| `lib/odd-*.js` | `odd-docs.js` (document discovery and ordering), `odd-view.js` (two-pane reader), `odd-markdown.js` (the shared markdown renderer). |
| `lib/gh-issues.js` | The `gh` client: checkout repository scope, identity pinning, issue pages, details, labels, assignees, comments, close, and the `viewerPermission` → capability mapping. |
| `lib/issues-view.js`, `lib/issue-preview.js` | The pure `/issues` view and its preview formatter. |
| `lib/tui-paint.js`, `lib/view-layout.js`, `lib/preview-scroll-keys.js`, `lib/clipboard.js`, `lib/open-external.js` | Shared presentation helpers: the one palette, window/layout maths, the one preview scroll decision, clipboard, external opener. |
| `lib/session-auto-name.js`, `lib/session-worktree-register.js` | Session bookkeeping: naming a session after an ODD write, and the host's session-worktree registry entry. |
| `lib/codegraph-session.js` | The CodeGraph gate (one probe per process, `CODEGRAPH_FORCE=1`), the per-directory git-toplevel cache, and the background `sync` scheduler: debounce, one `{running, pending}` pair, cross-process `O_EXCL` lock, `.codegraph/` and live-daemon skips, run watchdog, hook on/off switch. |
| `lib/codegraph-commands.js` | The three `/codegraph-*` command bodies, returning render-ready lines; registered only when the gate is true. |
| `lib/odd-worktrees-prompt.js` | The two `## ODD worktrees` system-prompt variants and the append-only injection helper. |
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
   no perf tracing, and no `herdr-gentle:` command name. `tools/package-surface.test.js`
   asserts both the loaded surface and the source text.
3. **The shipped surface is exactly three commands and four tools, plus three
   CodeGraph commands that only exist when the CLI does.** `/warp`,
   `/odd-list`, `/issues`; `worktree_create`, `worktree_list`, `worktree_close`,
   `worktree_warp`. `/codegraph-hook`, `/codegraph-init` and `/codegraph-sync`
   are registered only when the session gate says `codegraph` is present, so a
   session without the CLI must not see them. Each keeps its declared name and
   label.
4. **Deletion refuses on a live session.** `worktree_close` and the panel's
   `ctrl+d` go through the *same* guard (`lib/worktree-session-guard.js`), before
   the pending-change question and again immediately before removal. This
   session's own checkout is refused with "warp first"; another session's is
   refused naming its real session id, or the presence hash plus an explicit
   "could not be resolved". Nothing is auto-warped. The check is best effort:
   stale, unattributable and truncated evidence is disclosed, never silently
   dropped and never left blocking forever.
5. **Deletion never touches Herdr.** Removal is `git worktree remove <absolute
   path>` (with `--force` only when the caller asked), the branch is kept, and no
   Herdr workspace is closed, opened or removed on any path — including the
   panel's create, which is git plus the registry row only. The `worktree_create`
   *tool* may attempt a Herdr workspace association first and falls back to git,
   but the checkout succeeding never depends on it.
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
9. **Fixed argv, never a shell string.** Every child (`git`, `herdr`, `gh`,
   package managers, `codegraph`) gets a binary plus an argument array with a
   bounded timeout. Interactive paths await the async runner; nothing blocks the
   host event loop with `spawnSync`.
10. **The CodeGraph gate is one probe per process.** `lib/codegraph-session.js`
    answers PATH presence once and caches it; nothing re-probes mid-session.
    `CODEGRAPH_FORCE=1` answers "present" without probing. Both the edit-time
    sync and the creation-time `codegraph init` read that one answer, so a
    session where the CLI is absent does no CodeGraph work at all.
11. **Edit-time work never blocks a tool result.** `scheduleSync` is
    fire-and-forget: the `tool_result` handler never awaits it, never lets it
    throw and never changes the result. Pile-up is bounded by the debounce (one
    timer per root), the single `{running, pending}` pair (one more run, never a
    queue), the cross-process `O_EXCL` lock, and the run watchdog that settles a
    hung sync. Keep all three.
12. **The prompt block is append-only.** The `## ODD worktrees` section reaches
    the model only through `systemPromptOptions.appendSystemPrompt`; no handler
    returns a replacement `systemPrompt` (the bridge drops it) and no existing
    text is removed. It is idempotent by content, primary sessions only, and
    `ODD_WORKTREE_PROMPT=0` suppresses it.

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
  fakes; they never spawn real `gh`, `herdr`, `codegraph`, a package manager, or
  anything that reaches the network. `tools/fixtures/load-extension.js` copies
  `extensions/odd-worktree-tools.ts` to a scratch `.mjs` with the two Pi imports
  stubbed, loads it against a fake host, and points it at this package's `lib/`
  through `GENTLE_WORKTREE_LIB_DIR`.
- **No network, no live tools.** GitHub responses come from
  `tools/fixtures/gh-*.json` through the injected runner. A test that needs a
  Herdr binary gets a provably nonexistent path.
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
