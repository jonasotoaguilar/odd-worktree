# pi-odd-worktree — Agent Guide

Read this before changing anything. It is the contract for this repository: one
Pi extension, two agent tools, three panels, one preference, no other
configuration surface.

## Purpose

`pi-odd-worktree` is a Pi extension package. It gives a Pi session:

- two agent tools — `worktree_create` (create a checkout beside the clone and
  start its setup) and `worktree_list` (read-only listing);
- three panels — `/warp` (move the session between checkouts, and remove one),
  `/odd-list` (read this checkout's `odd/tasks/*.md`), `/issues` (read and, when
  permitted, edit this checkout's GitHub issues);
- one preference — `/card:bash` (draw a `bash` tool call as this package's
  activity card, the default, or leave it to the host's own drawing).

Deleting a checkout and moving the session are human actions only: they happen
through `/warp` (its `ctrl+d`, its selector, a typed name, a queued handoff), and
no agent tool does either. It works in Pi alone, with `git` as the only external
requirement; Gentle Shell is recommended only because the deletion guard reads
its presence records.

## Layout

| Path | Responsibility |
| --- | --- |
| `extensions/odd-worktree-tools.ts` | The **only** Pi entry point. Plain JavaScript under a `.ts` name (`// @ts-nocheck`), so the test copy-to-`.mjs` loader works. Registers the four commands, the two tools, the `worktree-warp` message renderer, the optional `ISSUES` rail section with its one missing-bridge warning, and the `session_start` / `session_shutdown` / `turn_end` / `tool_call` / `tool_result` / `before_agent_start` hooks. |
| `lib/worktree-git.js` | The git seam: identity, worktree listing, branch validation, the canonical target path `<repo-parent>/<repo-name>-worktrees/<slug>` and its helpers, and the async argv runner. |
| `lib/worktree-registry.js` | The one ownership rule, with no file: a checkout this package created is a directory under `<repo-parent>/<repo-name>-worktrees`, so the path decides. Partitions Git's listing into ours and outside, and parses `git worktree list --porcelain` for the create path. |
| `lib/worktree-create.js` | `worktree_create`'s core: request validation, base resolution, the ODD-named destination, the refusals sentence for sentence, plan execution and the fixed output lines. |
| `lib/worktree-list.js` | `worktree_list`'s rendering: rows, order, detail lines and footers, from one structured row list. It writes nothing. |
| `lib/worktree-guard.js` | The `bash` guards' decision: a pure function over the command text and injected seams; it spawns nothing and reads no file. |
| `lib/worktree-hooks.js` | The preparation chain of a create: submodules, local inputs, `copy_changes`, build-cache and asset links, the setup slot, and the clone-local `gentle-ai/worktree-hooks.json` that extends the lists. |
| `lib/worktree-setup.js` | The setup chain: the closed command table one lockfile selects, the plan, and the two notice sentences. |
| `lib/worktree-setup-runner.js` | The tracked background task of a create: runs the planned commands one child at a time, sends their output to its own log under the system temp directory, and reports one notice built from the child process outcome. No state is persisted. |
| `lib/worktree-remove.js` | Git-only removal: `git worktree remove <absolute path>`, branch kept. |
| `lib/worktree-symlinks.js` | Symlink policy for a checkout. |
| `lib/worktree-changes.js` | Pending-change snapshot and transfer (the panel's `changes` selection, and a typed warp's copy). |
| `lib/worktree-session-guard.js` | The active-session guard the panel's `ctrl+d` runs, with the caveats it discloses. |
| `lib/worktree-warp-busy.js` | This session's busy evidence for a warp: the in-flight tool counter, agent-task counters, its `job_list` jobs, the one pending handoff, and the persistent row that handoff shows. |
| `lib/worktree-warp-sessions.js` | Warp/fork bookkeeping in the session files the host owns. |
| `lib/checkout-facts.js` | The facts one checkout row shows in the selector. |
| `lib/worktree-card.js` | The `worktree-warp` message renderer (the moved/queued card), composed on the card substrate like the tool cards. |
| `lib/card-style.js` | The one style reader: the live process-wide slot Gentle Shell publishes, then the strict `<home>/card-style.json`, then `float`. It reports the source and the reason it fell back, caches only the document branch, and is re-read on `session_start`. |
| `lib/card-content.js` | The one reader of the card content level Gentle Shell publishes (`default` or `minimal`), read at paint time; every card honors it. |
| `lib/card-bash-mode.js` | The one bash-card mode reader and writer: the live process-wide slot this package's toggle sets, then the strict `<home>/card-bash.json` (`{"schema":"gentle-pi.card-bash/v1","mode":"own"|"default"}`), then `own`. Same resolution order and reasons as `lib/card-style.js`; the writer is atomic, owner-only, document-first and never rewrites a document it cannot parse. |
| `lib/bash-activity.js` | The classifier the bash card heads with: the one quote-aware segmenter, the eight named families and the mark and theme role each wears, and the package's own conservatism — a segment it cannot name leaves the call unnamed, which is what the generic `$ bash` heading is. |
| `lib/bash-destructive.js` | The destructive family's evidence: the segment that names a deleting program, and the whole command whose pipe or heredoc feeds a database client its statements. Evidence only — no permission, guard or execution decision may read it. |
| `lib/bash-card.js` | The bash activity card on the card substrate: the heading identity, the collapsed detail and its three-row output tail, the expanded whole command and whole output, the running row, the rail and the elapsed. Its slots re-read the mode on every paint. |
| `lib/bash-card-resolver.js` | The seam: one resolver registered through the host's `registerToolRenderer`, this card for every bash call while the mode is `own`, the host's own drawing while it is `default`, and every other row forwarded exactly as the chain resolved it. |
| `lib/shell-card.js`, `lib/worktree-cards.js` | The card substrate (rounded frame, palette, tone, elapsed) and the two tools' call/result card factory built on it. |
| `lib/warp-*.js` | The panel: selector and extended list (`warp-selector-view.js`), create wizard (`warp-create-panel.js`, `warp-create-picker.js`), delete confirmation (`warp-delete-confirm.js`). |
| `lib/odd-*.js` | `odd-docs.js` (document discovery and ordering), `odd-view.js` (two-pane reader), `odd-markdown.js` (the shared markdown renderer). |
| `lib/odd-prompt/odd-worktrees.md` | The `## ODD worktrees` prompt prose: one text, no variants. |
| `lib/odd-worktrees-prompt.js` | The append-only injection helper that reads that file. |
| `lib/codegraph-prompt/*.md` | The `## CodeGraph` prose: one approved text per role (orchestrator, explore, verify, worker, fix, judge, generic). |
| `lib/codegraph-rules.js` | Selects a role's text from the session's own facts and appends it. Runs and probes nothing. |
| `lib/codegraph-guard.js`, `lib/codegraph-guard-target.js` | The two reminders (invariant 21): the decision core with its once-per-key state, and the checkout a `grep`/`find`/`ls`/`read`/`bash` call went to. They append one text part to a finished result and run nothing else. |
| `lib/codegraph-session.js` | The single CodeGraph wiring point (invariant 19): session start, compaction, the observed native init, the edit/write sync, the two reminders and shutdown, only with the CLI installed. |
| `lib/codegraph-index.js`, `lib/codegraph-lock.js`, `lib/codegraph-compaction.js` | Create-or-sync, worktree seeding, the CLI probe and the notices; the one init lock and the per-project sync lease; the compaction sync. |
| `lib/codegraph-edit-sync.js`, `lib/codegraph-role.js` | The debounced edit/write sync; the index role that keeps verify and the judges read-only. |
| `lib/codegraph-daemon.js`, `lib/codegraph-warmup.js`, `lib/codegraph-mcp.js`, `lib/codegraph-mcp-config.js`, `lib/codegraph-paths.js` | The per-checkout daemon registry and client; the warm-up through CodeGraph's own proxy; the MCP exposure warnings; the one `mcp.json` entry writer; root identity and the argv to start `codegraph`. |
| `lib/codegraph-card.js`, `lib/codegraph-card-preview.js` | The CodeGraph tool card for the native tool, the MCP explore tool and a `bash` call that runs CodeGraph, on the card substrate. |
| `lib/gh-issues.js` | The `gh` client: checkout repository scope, identity pinning, issue pages, details, labels, assignees, comments, close, and the `viewerPermission` → capability mapping. |
| `lib/issues-view.js`, `lib/issue-preview.js` | The pure `/issues` view and its preview formatter. |
| `lib/issues-section.js` | The checkout's assigned issues as a rail section: the `#<number> <title>` row and its one pull-request mark, the seven-row body, its one `and N more issues` row that sends `/issues`, the one in-memory snapshot, its TTL, and the drawn-frame stamp the session's own activity read is gated on. A failed refresh keeps the rows and marks them `stale`. It schedules refreshes and never waits on a child process; only a bridge that published its API can show it. |
| `lib/related-issues-cache.js` | The in-process cache of the three scoped issue views (`mine`, `assigned`, `involved`) that one combined read answers, keyed by repository identity: the 100-then-20 read plan, the merge by issue number, the count invariant that forces a full re-read, and the ten-minute bound measured from the last FULL read, so a stream of deltas cannot postpone it. Memory only, and it holds the two views no surface draws yet. |
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
2. **No customize / plugin-tools / Herdr-panel surface, and CodeGraph only as
   invariants 18 and 19 allow.** No customize command, no plugin-tools toggles, no
   Herdr plugin management, no `worktree-mode` file, no perf tracing, and no
   `herdr-gentle:` command name. The ONE preference this package owns is the bash
   card mode (invariant 3): no other setting is read, written or offered. CodeGraph
   adds no command and no model-facing tool: no `/codegraph-*` command, no tool
   named `codegraph`, no override of another extension's tool.
   `tools/package-surface.test.js` asserts the loaded surface, the one-line
   registration in the extension, the closed list of `lib/codegraph-*` modules and
   what each may do.
3. **The shipped surface is exactly four commands, two tools and one sidebar
   section.** `/warp`, `/odd-list`, `/issues`, `/card:bash`; `worktree_create`,
   `worktree_list`; and the one fourth kind of surface, a sidebar section
   (`lib/issues-section.js`) that is neither a command nor a tool and therefore
   registers no name the host or the agent can call. No agent surface moves the
   session or removes a checkout: `/warp` moves the session (its `ctrl+d`, the
   selector, a typed name, a queued handoff) and its `ctrl+d` removes a checkout.
   Each command and tool keeps its declared name and label.

   **The section reaches the host only through gentle-shell-bridge.** It is
   published through that package's sidebar-section API alone: the object read from
   its `Symbol.for("gentle-shell-bridge/api/v1")` slot after its schema and version
   gate, or the one `gentle-shell-bridge:ready` announcement when the bridge
   publishes later. There is NO dependency on that package and no import of it
   anywhere in this repo. Without a bridge the section never appears at all:
   nothing is registered and no other surface changes. A host
   that HAS the bridge but draws no rail registers the section and never paints it,
   which is the bridge's business and not an error here. Its `/gentle:customize` → `Sections` visibility toggle is
   contributed by the bridge, not by this package (invariant 2 keeps the customize
   surface out of it). A host without the bridge otherwise hears nothing about it;
   the one warning it can get is discoverability — once per process, from a primary
   session only (`GENTLE_PI_AGENTS_CHILD` is not `1`), naming
   `pi install npm:gentle-shell-bridge`, timed after the announcement window because
   an empty slot at `session_start` may still be a bridge that has not loaded, and
   immediate on a host with no event bus to announce on.

   `/card:bash` is the ONE preference this package owns: it flips between `own`
   (this package's activity card, the default) and `default` (the host's own bash
   drawing), reports the new state in one line, and persists it in the strict
   document `<home>/card-bash.json` (`{"schema":"gentle-pi.card-bash/v1",
   "mode":"own"|"default"}` and nothing else), written only by
   `lib/card-bash-mode.js` — atomically, owner-only, document first and slot second,
   and never over a document it cannot parse. `<home>` is the same one
   `lib/card-style.js` resolves (`GENTLE_PI_CONFIG_HOME` →
   `GENTLE_SHELL_CONFIG_HOME` → `~/.pi/gentle-ai`). There is no second setting and
   no settings file.
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
15. **A warp waits for this session's own tools, agent tasks AND background
    jobs, and it is queued, never thrown away.** While
    `lib/worktree-warp-busy.js` reports a tool still executing, a running or
    queued agent task, or an active job, `/warp` keeps the validated handoff
    PENDING instead of switching, and re-dispatches the same `/warp @<token>`
    from a bounded, unref'd poller once all three workloads are idle, and an
    `agent_settled` handler ticks the pending record once, so a queued warp (also
    one asked while `ctx.isIdle()` is false) starts when the session settles, not
    on the next poll, while the record's `dispatching` guard keeps that boundary
    and the poller from dispatching it twice. The request
    is recorded as pending at QUEUE time, so a second warp in the same turn is
    refused and the pending one is never replaced. Expiry
    (`ODD_WORKTREE_WARP_PENDING_MS`, 30 min default) notifies that nothing moved,
    and every terminal outcome (moved, refused, cancelled, expired, shutdown)
    clears the record. While the record waits it also shows ONE persistent line
    in the zone above the editor (`ctx.ui.setWidget`'s `aboveEditor` placement,
    dim and truncated like Pi's `Steering:` row); that line is cleared on the
    dispatch and on every terminal outcome, so it never outlives the queue and
    never claims a move. When the host cannot paint that zone
    (`ctx.ui.setWidget` absent or throwing), the same one line falls back to ONE
    fixed transcript entry through `pi.appendEntry` and the entry renderer
    registered for it — appended once per record, never once per poll.

    **One surface per request.** The record keeps the answer its painter gave it,
    so the queued answer reports that line and prints NOTHING of its own when a
    surface took it: the row above the editor (or its one fallback entry) is the
    whole message, and the chat never holds a second copy of the same sentence.
    Only a host with no surface at all — no row AND no `appendEntry` seam — gets
    the one `ui.notify` with that same line, because otherwise the request would
    be invisible.

    **A refused carry-copy never blocks the move.** A queued handoff's copy
    (`lib/worktree-changes.js`) refuses whole: its own error says
    `(nothing was copied)` and the destination is untouched. That refusal is
    disclosed, never fatal — the warp proceeds WITHOUT the copy, overwrites
    nothing, and appends ONE line naming the copies it could not carry (`details`:
    `copyRefused`, `copiedFiles: []`). A copy that landed anything — even
    partially — stays a hard failure through `failAfterCopy`, because that is
    real state.

    **The dispatch boundary.** A dispatch is only ever attempted into an IDLE
    host: the pending record holds the bound `ctx.isIdle` seam (absent or
    unknown blocks nothing), so a tick that finds the run still live releases
    its slot and re-arms. The host does not reject a slash command sent while it
    streams: the handler would run at once and park in `ctx.waitForIdle()` until
    the whole run settles, so claiming that dispatch would leave the record
    `dispatching` behind a parked handler.

    **The turn boundary.** A queued warp takes effect at the SAME boundary Pi uses
    for a queued input message — after the current assistant turn's tool calls,
    before the next model call. On the host's `turn_end` event, when the run
    itself is the only thing still blocking a pending record (no tool executing,
    no running or queued agent task, no active job) AND the turn that just ended
    executed tools (`event.toolResults.length > 0`), the extension aborts the run
    through `ctx.abort()`, ONCE, and the settle tick then moves the session.
    NOTHING is ever sent to the agent — no steering message, no custom message, no
    instruction text: an instruction can be ignored (the model answers with a
    text turn, and that turn produces no later tool-using boundary for a net to
    fire on) while the abort is deterministic. A turn that ends with no tool
    results is the agent's final answer, so that boundary aborts nothing and the
    run settles by itself. A record with real workload pending, and an idle host,
    abort nothing either. The abort is per record and bounded — one per record,
    never twice — and the `turn_end` handler returns no boundary proposal. It also
    lands BETWEEN provider requests: the boundary decides synchronously, before
    any awaited read, from the activity the record already sampled and the event's
    own tool evidence (an absent or stale sample is the only case that falls back
    to an awaited re-read, and there the abort follows the read only when it
    proves nothing is running), so ending the run never cuts an assistant message
    whose tool cards the host would repaint as failed `Operation aborted` results.
    The queued line is one brief
    sentence and the same text everywhere it appears (`Queued: warp <name> —
    waiting for <the work>`); the unknown-job clause belongs to the expiry notice
    alone. An executing tool comes from the host's
    `tool_execution_start` / `tool_execution_end` pair — an execution with no end
    yet is executing, only top-level calls are counted (so this package's own
    `job_list` probe and any nested call never count), and `session_shutdown`
    clears the counter. Agent tasks come from the presence counters; jobs come
    from the host's `job_list` tool through the same `ctx.tools` +
    `ctx.executeTool` seam `worktree_create` uses. Only a status field of a job
    that says `running` or `queued` is active — `exited 0`, `failed 1` and
    `stopped` are finished — and a missing tool, a failed call or an unknown
    answer is UNKNOWN, which blocks nothing and is never reported as "no jobs".
16. **The card substrate's role tables are the reference's, not a local
    invention.** `TITLE_ROLE`, `FRAME_ROLE` and `BODY_ROLE` in
    `lib/shell-card.js` mirror `gentle-shell/lib/shell-card.ts`: the label carries
    its tone's role (the accent for INFO, whose plain border cannot carry it), the
    frame carries the same role in both styles (the plain `border` for INFO), and
    a card body is the theme's plain `text`. A change to those tables must be
    diffed against that file before it lands here, and this repo's tests state the
    REFERENCE's roles (`tools/shell-card.test.js` for all four tones,
    `tools/worktree-card.test.js` and `tools/worktree-cards.test.js` for the card
    each draws), never a role this package would prefer.
17. **This repo paints last; the host's key hint is the one painted input it
    measures.** Rows are wrapped, clipped to the inner width with the `…` mark and
    padded as PLAIN text and painted in their role afterwards (`cardBodyRows`,
    `cardLine`), so no painted string this repo composes is ever measured or
    clipped — which is why the `/warp` card's ANSI-unaware fallback clip draws the
    same text as the host's ANSI-aware helpers and copies the host's truncation
    rule (a width of zero or less is nothing; an ellipsis too wide for the budget
    is clipped and emitted itself). The ONE painted input it measures is the host's
    `keyHint`, which the host paints before handing it over (`keyHint` returns
    `fg("dim", …) + fg("muted", …)`): `lib/worktree-cards.js:185` forwards it, it
    is measured only by `metrics.visibleWidth` at `lib/shell-card.js:218`, `:378`
    and `:424`, and the `/warp` path strips that paint at
    `lib/worktree-card.js:158`. `tools/warp-fallback-regression.test.js` states
    both halves: the two seams draw the same text at the same width, and no body
    row ever hands a helper a string THIS REPO painted. The host's key hint is the
    named exception above: it arrives already painted, it is measured here with the
    host's ANSI-aware width functions, and this repo then wraps it ONCE MORE in
    `dim` when it draws the tail (`lib/shell-card.js:225`) — a redundant outer
    layer over the host's own paint, harmless, but it means the hint is both
    measured AND repainted here. Write no assertion that no helper ever receives a
    painted string, and none that a painted string is never painted twice: both
    would be false.

18. **The `## CodeGraph` section is advice, selected by the session's own facts.**
    It rides `systemPromptOptions.appendSystemPrompt` like invariant 14: appended,
    idempotent by heading, never a returned `systemPrompt`, suppressed by
    `ODD_WORKTREE_PROMPT=0`. It is added only when the session already holds the
    native `codegraph` tool or `mcp__codegraph__codegraph_explore` (in a child, the
    requested-tools list counts). The text is chosen by role: a primary session gets
    `orchestrator.md`; a child's agent name, read from its own argv
    (`gentle-pi-subagent-<agent>-<random>/`), picks `explore`, `verify`, `worker`,
    `fix` or `judge` (both judges share one); any other child, or a name that cannot
    be read, gets `generic.md`; a `review-*` agent gets nothing. A missing or
    heading-less file falls back to `generic.md`, and a missing generic means no
    section. Only the orchestrator and explore texts name the native operations; the
    other roles name the MCP tool in full, and only the orchestrator text also points
    that tool at another checkout through `projectPath` (a sibling worktree or another
    git project) before it delegates an explorer there; no text mentions `init`, `sync` or an
    index fallback, because no agent prepares the index: the package does
    (invariant 19).

19. **CodeGraph runs only with its CLI, in the background, and writes one config
    entry.** `lib/codegraph-session.js` is the single wiring point (the extension
    calls `registerCodegraph(pi)` once) and registers nothing when the `codegraph`
    CLI is not installed; the probe runs once per process, so installing it needs a
    restart. With the CLI: (a) a primary session ensures, once per process,
    `mcpServers.codegraph` of `<agent dir>/mcp.json` (`command: "codegraph"`,
    `args: ["serve", "--mcp"]`, `toolExposure.codegraph_explore: "direct"`) — it adds
    the entry or fixes only the fields that differ, keeps every other server and
    field, rewrites only when something changed, atomically and with the file's
    permission bits, and leaves an invalid file untouched. It is the only writer of
    the user's configuration, and `tools/` never touches a real agent directory.
    (b) Session start (not `/reload`, not a subagent child, except a child in its own
    linked worktree) creates or syncs the session's index and warms its daemon; a
    linked worktree without an index is seeded from the main checkout's and never
    shares it. (c) A compaction requests one sync, never an init. (d) After a
    successful native `codegraph init` the package requests one coordinated sync and
    appends its honest outcome to the tool's result; a failed init keeps its error
    and starts no sync. (e) After a successful `edit` or `write` a debounced sync of
    that file's checkout is requested, unless a live daemon watches it. Every write
    goes through the one init lock and the per-project sync lease, so a queued,
    coalesced or failed run is never reported as synced. Verify and the judges (a
    command tool and no file-writing tool) never start an index write.
    `worktree_create` is not involved: it already starts CodeGraph for its checkout.
    Nothing awaits an index, a daemon or the configuration on the host's path, and
    every child is a fixed argv with a bounded timeout (invariant 9).

20. **The bash card only draws, and it draws what the classifier names.**
    `lib/bash-card-resolver.js` registers exactly one resolver through the host's
    `registerToolRenderer` hook, and chooses renderers for the `bash` tool alone:
    every other row is handed back exactly as the chain resolved it, and a host
    without that hook, or without a usable measurement seam, keeps drawing its own
    bash rows. While `/card:bash` is `own` every bash call is this card's
    (`lib/bash-card.js`), a `codegraph …` command included; while it is `default`
    the resolver steps aside and the host draws the row. Nothing here executes,
    spawns, guards, intercepts or shadows a tool — it is drawing only, and the
    destructive evidence of `lib/bash-destructive.js` is presentation: no
    permission, guard or execution decision may read it. The heading's identity is
    the classifier's (`lib/bash-activity.js`): a named family's mark and word, or
    the generic `$ bash` when any segment names nothing, and it is never invented
    at paint time. The mode is read when a row is created and again on every paint
    (the card builds its rows inside `render(width)`), so the toggle repaints rows
    this card already drew, while a row created during `default` stays the host's
    for its lifetime. The CodeGraph card is registered BEFORE this one on purpose
    (invariant 19): it claims its own `codegraph …` rows with its richer body and
    this card's slots are never asked for them; without the CLI no CodeGraph card
    exists, so those rows are drawn here with the `codegraph` identity.

21. **The two CodeGraph reminders advise; they never block and never add a surface.**
    `lib/codegraph-guard.js` decides, and `lib/codegraph-session.js` appends its
    sentence as ONE extra text part to the result of that finished tool call — never
    a separate message, never a block, and the result (its own parts and its
    structured content) is kept whole. No tool, command, card or notification is
    added, and nothing runs in the foreground beyond one bounded, cached git read.
    Both are gated like the prompt section: only with the `codegraph` CLI installed
    (invariant 19's registration) and only when the session holds a CodeGraph tool,
    which the wiring records from `before_agent_start`'s
    `systemPromptOptions.selectedTools` — no other source. They cite the CodeGraph
    rule, so `ODD_WORKTREE_PROMPT=0` silences them together with it.

    **Guard 1** is the primary session's alone and fires once per other checkout per
    session: `This call went to <path>, another checkout. Follow the CodeGraph rule:
    call mcp__codegraph__codegraph_explore with projectPath set to <path> first.` —
    with `mcp__codegraph__codegraph_explore` and `projectPath` in backticks and
    `<path>` the checkout's real git toplevel. It stays silent, using up no slot, for
    a checkout this session already explored with that tool's `projectPath` since the
    last compaction.
    **Guard 2** is the primary session's and every child's except a `review-*` agent,
    fires once per the session's own checkout, and is keyed by the checkout so a
    `/warp` re-arms it: the primary session and the explore agent get `Follow the
    CodeGraph rule: run codegraph query or explore first, if it applies.` (`codegraph`,
    `query` and `explore` in backticks, the native wording only for a role that holds
    the native tool), every other role `Follow the CodeGraph rule: call
    mcp__codegraph__codegraph_explore first, if it applies.` (`mcp__codegraph__codegraph_explore`
    in backticks). It stays silent once the session used `codegraph` or the MCP tool.

    **What counts as a call** is `grep`, `find`, `ls`, `read` and `bash`: `read` only
    for code, never for the `.md`/`.json`/`.yml`/`.yaml`/`.toml`/`.txt` the rule
    exempts, and `bash` only when a segment runs `grep`, `rg`, `find`, `fd`, `ls`,
    `cat`, `sed`, `head`, `tail`, `awk` or `tree` — and a verb right after a single
    pipe only filters the previous command's output, so `curl … | head` and
    `ps aux | grep node` are not reads, while `cat a.ts | head` still is (the `cat`
    counts). **Another checkout** is a different
    git toplevel (`git -C <dir> rev-parse --show-toplevel`, read once per directory
    and cached), from a tool's path or from a `cd` target or absolute path argument
    of a shell command; a path outside every checkout and a command that only
    mentions one (`git -C`, `curl`, `echo`) triggers nothing. A compaction forgets
    both guards and what the session used, and so does a new session in the same
    process (`session_start` new, resume or fork; not `/reload`). The reminder is
    advice, so no test may assert it blocks, refuses or notifies.

20. **The `bash` guards read text, fail open and add no surface.** The extension's
    `tool_call` handler refuses a `bash` call whose command contains `git … worktree
    add` or `git … worktree list` in any cwd, and, only when the session cwd is the
    principal checkout (its root is the parent of the git common dir), a branch
    creation or a switch to anything but the repository's default branch. The decision
    lives in `lib/worktree-guard.js`, a pure function over the command string and the
    injected `repoIdentity`, `defaultBranch` and `pathExists` seams. Detection is text
    only: no script, alias or file is read, and a command it cannot judge passes. It
    never throws (a throwing `tool_call` handler blocks the tool), an unreadable
    repository leaves only the worktree refusals active, and the default branch is
    resolved lazily and memoized per checkout. `ODD_WORKTREE_GUARD=0` is the one way
    to turn it off, like `ODD_WORKTREE_PROMPT=0` for the prompt blocks; no other
    value, option or config file does, and it registers no command or tool name
    (invariant 3). The refusal sentences name `worktree_list` first and
    `worktree_create` second; the prompt block (invariant 14) is what keeps the agent
    from reaching them, so a change to one is read against the other.

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
| README | Install, requirements, the shipped surface at a glance | [`README.md`](README.md) |
| Reference | Panel keys, how each surface behaves, its limits, tests and releases in detail | [`docs/reference.md`](docs/reference.md) |
| CI matrix and test command | What CI runs and on which Node versions | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| PR gates | Commit and PR-title conventions | [`.github/workflows/pr-check.yml`](.github/workflows/pr-check.yml) |
| Release flow | Tag, environment, OIDC publish, verification | [`.github/workflows/release.yml`](.github/workflows/release.yml) |
