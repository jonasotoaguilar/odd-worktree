# Invariants — do not break these

The question this page answers: which rules must every change preserve, and what does each one refuse?

1. **One extension entry point.** `package.json` `pi.extensions` is exactly
   `["./extensions/odd-worktree-tools.ts"]`, and `extensions/` holds no other
   file. A second entry point changes what the host loads.
2. **No customize / plugin-tools / Herdr-panel surface, and CodeGraph only as
   invariants 18 and 19 allow.** No customize COMMAND, no plugin-tools toggles, no
   Herdr plugin management, no `worktree-mode` file, no perf tracing, and no
   `herdr-gentle:` command name. This package owns exactly TWO preferences — the
   file cards' `Card skill` and `Card odd` switches (invariant 3, invariant 23) —
   and its customize-side contributions are only the rows that carry them and a
   bash DESIGN (the `activity` value) on gentle-shell-bridge's own `bash` line
   (invariant 3); the design is not a preference here, because the bridge owns
   that choice and its store. It registers no command, no page, no setting, no
   settings file and no key of its own beyond the file picker's ONE keymap action
   (invariant 3), and no other setting is read, written or offered. CodeGraph
   adds no command and no model-facing tool: no `/codegraph-*` command, no tool
   named `codegraph`, no override of another extension's tool.
   `tools/package-surface.test.js` asserts the loaded surface, the one-line
   registration in the extension, the closed list of `lib/codegraph-*` modules and
   what each may do.
3. **The shipped surface is exactly four commands, two tools, one sidebar
   section, one bash design and the one `Cards` row group.** `/warp`, `/odd-list`,
   `/files`, `/issues`; `worktree_create`, `worktree_list`; the one fourth kind of
   surface, a sidebar section (`lib/issues-section.js`) that is neither a command nor a tool and
   registers no name the host or the agent can call; the one bash design
   (`lib/bash-design.js`) and the one `Cards` row group (`lib/cards-customize.js`,
   which carries `Card skill` and `Card odd`), which are neither commands nor tools
   either and add no name to either registry. Neither moving the session nor
   removing a checkout is exposed to the agent: `/warp` is the person's front for
   both (its `ctrl+d`, the selector, a typed name, a queued handoff for moving; its
   `ctrl+d` for removing). That is a rule about this package's surface, not about
   what an agent may run itself — invariant 5 says how a merged checkout is
   removed. Each command and tool keeps its declared name and label.

   **The section reaches the host only through gentle-shell-bridge.** It is
   published through that package's sidebar-section API alone: the object read from
   its `Symbol.for("gentle-shell-bridge/api/v1")` slot after its schema and version
   gate, or the one `gentle-shell-bridge:ready` announcement when the bridge
   publishes later. There is NO dependency on that package and no import of it
   anywhere in this repo. Without a bridge this package loads NOTHING — no command,
   no tool, no message or entry renderer, no card, no rail, no hook and no prompt
   append: the whole surface is deferred behind that gate and registers the moment
   the bridge is known present (published at load, or announced later), at most
   once. What stays registered while the gate is closed is the ONE `session_start`
   observer the missing-plugin notice needs, because `ctx.ui.notify` lives on a
   session; it is released when the surface registers. A host
   that HAS the bridge but draws no rail registers the section and never paints it,
   which is the bridge's business and not an error here. Its `/gentle:customize` → `Sections` visibility toggle is
   contributed by the bridge, not by this package (invariant 2 keeps every customize
   surface out of it except the `Cards` row group), and the section declares NO
   preview: every `Sections` row draws the host's one shared list of active sections
   and the bridge adds this section's `rowLabel` to it itself, shown or left out
   with the row's own hypothetical (`registerSection` has no `preview` field — do
   not add one). A host without the bridge otherwise hears nothing about it;
   the one warning it can get is discoverability — once per process, from a primary
   session only (`GENTLE_PI_AGENTS_CHILD` is not `1`), naming
   `pi install npm:gentle-shell-bridge`, timed after the announcement window because
   an empty slot at `session_start` may still be a bridge that has not loaded, and
   immediate on a host with no event bus to announce on. That warning is the ONLY
   thing a host without the bridge ever receives from this package.
   `tools/issues-section.test.js` pins the gate from the outside — no bridge and no
   bus registers nothing, an announcement alone registers nothing until it fires —
   and `tools/package-surface.test.js` pins that the bridge is never imported.

   **`/files` is a panel and nothing else.** It mounts its OWN overlay through
   `ctx.ui.custom` (the scope step's small card, then the picker), and a host with
   no such seam gets one honest line — `files: the file picker needs an interactive
   session with overlay support` — and no second surface in its place: no
   transcript dump, no sub-command, nothing written. Being a command, it needs no
   other package to DRAW: its overlay comes from the host's own `ctx.ui.custom`,
   not from the bridge that registered it. Its ONLY Gentle Shell hooks are those
   optional additions, and they go through the same published object as every other
   bridge surface: the `files` keymap action (label `File picker`, env
   `GENTLE_PI_FILES_KEY`, default `alt+p`) and the palette row in `Session`, both
   via `registerKeymap` / `registerCommands`, with the key bound here from
   `resolveKeymap`; a bridge that publishes the object without them simply leaves
   them absent, not an error. The
   command itself registers no store and writes nothing: it reads Git through the
   ordinary fixed argv (invariant 9) and paints.

   **The bash card is a design on the bridge, not a preference here.**
   `lib/bash-design.js` registers ONE design (`tool: "bash"`, id
   `odd-worktree.bash-activity`, label `activity`) through the bridge's published
   `registerToolDesign` API, at most once per process, with an idempotent
   disposer, and does nothing at all when the API is absent or older — no throw,
   no command, no warning beyond the section's own discoverability one. The bridge
   owns Pi's one tool-renderer resolver, builds the host's own card, reads its
   `bash` line (`native` | `activity`, default `native`) on every render pass and
   persists the choice in its own store, so this package stores no document for it,
   reads no file for it, has no `/card:bash` command and depends on no extension
   load order.
   The design is pure: `apply(lines, ctx)` rewrites only the heading row of a
   `call` part, swapping the host's `$` for the family `lib/bash-activity.js`
   names, taking the added columns from the row's own fill; every other row, every
   result and every unproven heading is returned byte for byte (invariant 20).

   **One rail open at a time, and the click's own identity.** A click on a rail row
   opens one panel at a time: while it is in flight every further click has no
   effect, and the effect returns when the panel mounts, on every exit of the
   command that never mounted one (a refusal, an unproven identity, a throw), and
   after the bounded safety interval of about ten seconds that covers a command the
   host never ran. The numbered open pins the identity the CLICKED ROW was read from
   with no probe at all; without that one-shot hint it pins the checkout's cached
   scope, while a typed plain `/issues` keeps the fresh proof. The hint is used once,
   only for its own number, only while the generation that READ the row is still the
   current one — a row the host retained across a session boundary still dispatches
   its number but leaves no hint — and only when the identity normalizes to
   `<host>/<owner>/<repo>` with the same function every pinned read uses. Both pins
   are reads: every action still re-proves the checkout fresh and refuses on drift, so
   no mutation rides a pin. Accepted limit: `pi.sendUserMessage` is `void` and the
   command it dispatches has no out-of-band channel from it, so a typed `/issues <n>`
   of the same number run between the click's hint and its dispatched command can
   consume that hint; the open then pins the repository the user just clicked, and
   every write still re-proves the checkout fresh.
   `tools/issues-open-guard.test.js` pins the guard, its release points, both pins,
   the generation and the normalization.

   **The two file-card switches are the only preferences this package owns.**
   `lib/cards-customize.js` registers ONE row provider
   (`odd-worktree.cards.file-switches`) through the same published `registerRows`
   API, into the same `Cards` page, at most once per process: each switch is two
   consecutive rows sharing one `choice.setting` — an `on` row then an `off` row —
   a `current()` that reads the live switch and an `action()` that persists before
   the host repaints. `Card skill` and `Card odd` are both on by default, add no
   command, tool or key, and their whole state is one strict document,
   `<home>/card-files.json`
   (`{"schema":"gentle-pi.card-files/v1","skill":true,"odd":false}` and nothing
   else), written only by `lib/card-files-mode.js` — atomically, owner-only,
   document first and slot second, and never over a document it cannot parse — in
   the one `<home>` `lib/card-style.js` resolves (`GENTLE_PI_CONFIG_HOME` →
   `GENTLE_SHELL_CONFIG_HOME` → `~/.pi/gentle-ai`). A missing, unreadable,
   malformed, wrong-schema or non-boolean document reads as both on. A refused
   write leaves the row's `action` as a throw, which the customize menu reports as
   ONE error notice, with the stored value and the drawn switch unchanged
   (invariant 23). Without the bridge neither switch has a control surface, and
   nothing throws.
4. **Deletion refuses on a live session.** The only surface that removes a checkout
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
   The post-merge cleanup of an ODD uses that same argv: an agent first updates the
   default branch, then removes its
   checkout with `git worktree remove <absolute path>` once the branch tip is an
   ancestor of `origin/<default>` and the tree is clean, and the branch survives.
   It is reported and skipped — never forced — when the checkout is dirty or when a
   live session stands in it; those are the only two reasons to leave it in place.
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
    successful native `codegraph init` the package requests one coordinated sync in
    the background and appends NOTHING to the tool result when it completes: the
    tool's own content is the whole answer. Only a sync that did not complete appends
    one short line naming that failure, with no `pi-odd-worktree:` prefix and no
    second paragraph; a failed init keeps its error and starts no sync. (e) After a
    successful `edit` or `write` a debounced sync of
    that file's checkout is requested, unless a live daemon watches it. Every write
    goes through the one init lock and the per-project sync lease, so a queued,
    coalesced or failed run is never reported as synced. Verify and the judges (a
    command tool and no file-writing tool) never start an index write.
    `worktree_create` is not involved: it already starts CodeGraph for its checkout.
    Nothing awaits an index, a daemon or the configuration on the host's path, and
    every child is a fixed argv with a bounded timeout (invariant 9).

20. **The bash design only draws, and it draws what the classifier names.**
    `lib/bash-design.js` changes nothing but a heading row: it executes, spawns,
    guards, intercepts and shadows nothing, and the destructive evidence of
    `lib/bash-destructive.js` is presentation: no permission, guard or execution
    decision may read it. The design context carries no arguments, so the
    heading is the only evidence and a call is named only when the heading provably
    shows the WHOLE command — no `…` abbreviation, no `… +N lines` fold, no
    continuation row, nothing after the command but the host's fill and hint — and
    the classifier (`lib/bash-activity.js`) names exactly one family for it. Any
    other case, a row with no fill to pay for the word included, keeps the host's
    `$` exactly as drawn. The design never throws and never mutates its input. The
    CodeGraph card (invariant 19) keeps its own resolver for `codegraph …` rows;
    this package registers no other tool-renderer resolver for `bash`.

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

22. **The `bash` guards read text, fail open and add no surface.** The extension's
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

23. **The file card only draws, and it claims exactly three tools.** `read`, `edit`
    and `write`, and no fourth: `lib/file-card-resolver.js` registers one resolver
    through the host's `registerToolRenderer` hook, hands every row of every other
    tool back exactly as the chain resolved it, registers nothing when that hook is
    absent, and leaves a host without a usable measurement seam its own rows. What a
    call heads as comes from its `path` alone, through the pure functions of
    `lib/skill-odd-card.js`: a skill is a `SKILL.md` a `skills` folder holds, an ODD
    artifact is any file below an `odd/tasks` folder, both read as path components
    with both separators, and a path that names both is decided by the marker
    closest to the file. The card states that identity's mark and label, the tool,
    the path and — for a read only — the line range the call asked for. A path
    naming neither identity, and a call whose switch is off, is the chain's own row.

    **The host's shell is fixed per tool name, so the card reproduces its box.**
    `registerToolRenderer` decides per TOOL NAME and never sees a call's arguments,
    so a resolver's `renderShell` is fixed for every call of a tool. Declaring
    `self` — which this card does for the rows it draws — takes the host's own box
    off all of them, so a forwarded row is drawn as the host would have drawn it:
    inside the host's box — `Box(outputPad, 1, bgFn)`, one painted blank row above
    the call and one below the result, in `toolPendingBg` while the call streams,
    `toolErrorBg` once its result failed and `toolSuccessBg` otherwise — for a row of
    a default-shell renderer (`read`, `write`), and untouched, with no box, no
    padding and no background, for one that frames itself (Pi's `edit`).

    Both switches (`Card skill`, `Card odd`, read through `lib/card-files-mode.js`),
    the card style slot (`lib/card-style.js`) and the content level
    (`lib/card-content.js`) are read at paint time, inside the component's
    `render(width)`, so a flip repaints rows already drawn. The card only draws: it
    adds no command and no tool, and its only customize surface is the bridge's
    `Cards` rows (`lib/cards-customize.js`).

24. **No session path waits on `gh`, and every `gh` reach is deferred.**
    `session_start` DISPATCHES the issues gate as tracked startup work under the
    module's epoch and never awaits it, so opening a session or switching to
    another one spends no child process and no network call there. What the gate
    does off that path is one local `git rev-parse` for repository-ness, one local
    `PATH` walk (`lib/which-command.js`) for the CLI, and the `gh` health read only
    when both answer yes; a late answer from a session that has ended sets no state
    and notifies no UI. `/issues` probes `gh` itself when it opens. In the rail,
    `lines()` and `meta()` keep their synchronous contract: they read ONE in-memory
    snapshot and only schedule the refresh. `tools/issues-command.test.js` pins it
    with "the awaited session_start resolves while the injected gh runner is still
    pending" and "a session outside a repository makes no gh call at startup, and
    stays silent"; `tools/issues-section.test.js` with "a frame never waits" and "a
    missing gh CLI paints one dim line and spawns no gh child at all".

25. **A persisted cache entry never defeats the count invariant or the full-read
    TTL.** The disk half (`lib/issues-cache-store.js`) stores what the plan needs
    and moves `fullAt` only on a full apply, exactly like the in-memory clock. The
    loader hydrates an entry only for the identity it just proved, only while the
    in-memory cache is cold for it, only when its stored `fullAt` is inside the
    ten-minute bound, and never when it is `inconsistent`: an entry that fails any
    of those is not hydrated at all, so `plan` still answers a FULL read and
    persistence cannot turn a stale or untrustworthy entry into a fresh one. The
    document is keyed exactly as the memory cache keys its own entry
    (`<host>/<owner>/<repo>`), so no entry is served under another repository's
    name. The write is fire-and-forget — one in flight, one latest-wins pending
    slot, offered only by a read that is still the newest one STARTED — so a slow
    disk postpones no read and an older answer never overwrites a newer one.
    `tools/issues-cache-store.test.js` pins the document (round trip, a delta keeps
    `fullAt`, the identity bound, and silence on a malformed, hostile or
    uncommittable document); `tools/issues-section.test.js` pins "a warm identity
    survives a process restart, so its first read is a delta", "a stored entry past
    its full TTL, or inconsistent, is still read whole", "a held save defers no
    read, and the newest entry waits behind it instead of interleaving" and "the
    cache survives a session_shutdown/start pair, so the next read is a delta".

26. **The rail's timed refresh exists only while the section is drawn.** With a
    floor named, `lib/issues-section.js` keeps ONE self-scheduled, unref'd timer at
    that floor: a DRAW arms it (`lines()` or `meta()` — a collapsed section is a
    painted frame too), its own fire re-arms the next floor, a read already in
    flight owns that instant, and it stops by itself the moment the section leaves
    the drawn window, so a section the host stops painting keeps it no longer than
    that window. `invalidate()` and `dispose()` clear it, which is what a session
    boundary performs. A section nobody draws keeps no timer, spawns nothing and
    reads nothing. `tools/issues-section.test.js` pins "a drawn section reads on its
    own timer at the floor, one read per floor", "the timer never overlaps a read,
    and it stops once the section is not drawn", "invalidate and dispose clear the
    timer, and a queued callback is inert", "a drawn section reads on the
    extension's own 20 s timer, and activity adds nothing" and "a hidden section
    makes no gh call, and the drawn window gates the activity hooks".

27. **A forced refresh happens only after a mutating `bash`, behind its cap.**
    Two conditions are required together: the finished tool is a `bash` call whose
    command text the pure classifier (`lib/issues-bash-mutation.js`) proves writes
    an issue or a pull request, and the section is drawn — inside its window, for
    the session this rail belongs to. It bypasses the frame TTL and the activity
    floor, never the caller's anti-storm cap, and never a read already in flight,
    so one result starts at most one read per cap. The classifier is text only: no
    child, no file, no clock, no cache, and it never throws; a mutation merely
    MENTIONED in an argument, and a read such as `gh issue list`, names no write.
    `tools/issues-bash-mutation.test.js` pins the classifier;
    `tools/issues-section.test.js` pins "a mutating bash result forces one read,
    capped to one per 5 s", "a mutating bash named under `tool`/`args` forces the
    same read" and "a hidden section forces no read, and a mutating result after
    shutdown does nothing".

28. **The `gh`-absent and non-repository states are settled.** Both are one short
    `dim` line — `gh CLI not installed` and `not a git repository` — and a
    `dim`/`muted` error snapshot is a STATE, not a failure to retry: no later frame,
    no activity read, no timer and no forced read starts there, and only a session
    boundary supersedes it. The CLI question is answered by a local `PATH` walk
    (`lib/which-command.js`) before any child, so the absent state costs zero child
    processes and stops the read before the checkout probe; the non-repository
    state costs the one local `rev-parse` every surface makes and no `gh` call.
    `tools/which-command.test.js` pins the lookup;
    `tools/issues-section.test.js` pins "a non-repository line is a state, so no
    frame and no activity read" and "a settled (dim) state owns no floor timer";
    `tools/issues-command.test.js` pins "the session gate stops before any gh child
    and says the one line once".
