# Invariants — do not break these

The question this page answers: which rules must every change preserve, and what does each one refuse?

Where a rule below says "the API", it means the shell API this package owns (`lib/shell-api/`,
invariant 32). The one name it keeps from before is its store directory, spelled as it was so saved choices still load.

1. **One extension entry point.** `package.json` `pi.extensions` is exactly
   `["./extensions/odd-worktree-tools.ts"]`, and `extensions/` holds no other
   file. A second entry point changes what the host loads. `lib/shell-api/` has no
   manifest of its own: it is ordinary package code, reached through the root
   entry's own import and never loaded as a second package (invariant 32).
2. **No customize / plugin-tools / Herdr-panel surface, and CodeGraph only as
   invariants 18 and 19 allow.** No customize COMMAND, no plugin-tools toggles, no
   Herdr plugin management, no `worktree-mode` file, no perf tracing, and no
   `herdr-gentle:` command name. This package owns exactly FIVE preferences, each an
   Off/On row registered through the shell API and stored in its own store:
   `Codegraph+`, `Worktrees+` and `Skills+` (`Tools` page), `Deepseek peak` and
   `Claude peak` (`Alert` page). All five read Off until the human turns them on.
   Everything else it contributes to `/gentle:customize` is a DESIGN: the two
   (`activity` and `color`) on
   the shell API's own `Cards` page — a `Card activity` line, or its `Card bash`
   line on a published object older than 0.6.0, and a `Card file` line on 0.9.0 and later
   (invariant 3). The skill/ODD file cards obey the `activity` design's line
   (invariant 23) and contribute no row of their own, and never the `color` one; neither design is a
   preference here, because the shell API owns those choices and its store. It registers no customize
   COMMAND, no settings file of its own and no key of its own beyond the TWO host shortcuts, the file
   picker's `alt+p` and the issues panel's `alt+i` (invariant 3): its two menu pages (`Tools`, `Alert`)
   are row providers on the shell API's menu, never a command and never a store of this package's own. CodeGraph
   adds no command and no model-facing tool: no `/codegraph-*` command, no tool
   named `codegraph`, no override of another extension's tool.
   `tools/package-surface.test.js` asserts the loaded surface, the one-line
   registration in the extension, the closed list of `lib/codegraph-*` modules and
   what each may do.
3. **The shipped surface is exactly six commands, two tools, TWO sidebar
   sections and two tool designs.** `/warp`, `/odd`,
   `/files`, `/identity`, `/issues`, `/prs` — six, with no diagnostics command among
   them: what the API reports to a user are the notices of invariant 32 and the ones
   its own surfaces raise, and nothing else; `worktree_create`, `worktree_list`; the one fourth kind of
   surface, a sidebar section — and there are TWO of them, each neither a command nor a
   tool and each registering no name the host or the agent can call: the issues rail
   (`lib/issues-section.js`, id `odd-worktree.issues`, headed `GITHUB`, `rowLabel`
   `github`, mounted only where the `gh` probe found the CLI) and the ODD rail
   (`lib/odd-rail-section.js` over the row model `lib/odd-rail-model.js`, id
   `odd-worktree.odd-rail`, headed `ODD`, `rowLabel` `odd`, `placement: { after:
   "agents" }`, scoped to the ODDs the SESSION is associated with inside its
   registered worktrees and therefore independent
   of `Worktrees+`); the two designs
   (`lib/bash-design.js`, `lib/diff-design.js`) on the two lines the shell API owns, one
   `Card activity` line over `bash`, `read`, `write`, `edit` and the three
   read-only shell tools `grep`, `find`, `ls` (the single `tool: "bash"` design on a shell API older
   than 0.6.0) and one `Card file` line over `write` and `edit`, the first claiming `write` and
   `edit` through a scope limited to skill and ODD paths so the file card's question is
   answered per call and the second claiming every other call of those two, which is
   neither a command nor a tool either and adds no name to either registry; and
   ONE plain `Cards` row of its own, the `Card message` Off/On switch
   (`lib/card-message.js`, below) — a row provider, never a design and never a third
   line, so the design count above stays two (the file cards add no row at all — see
   below).
   Neither moving the session nor
   removing a checkout is exposed to the agent: `/warp` is the person's front for
   both (its `ctrl+d`, the selector, a typed name, a queued handoff for moving; its
   `ctrl+d` for removing). That is a rule about this package's surface, not about
   what an agent may run itself — invariant 5 says how a merged checkout is
   removed. Each command and tool keeps its declared name and label.

   **The `ODD` rail draws only what the session is ASSOCIATED with, and never
   "everything on disk".** Association is by ODD NAME (`odd/tasks/<name>.md`), and
   attribution is the FILTER, not an ordering key: the row model draws a name only
   while the association or the live touch record holds it, so a new session draws
   the ONE dim `no ODD associated` line (the `EMPTY_ROW` mirror of
   `lib/issues-section.js`) instead of the documents the checkout happens to have.
   The association is rebuilt from the ACTIVE branch (`getBranch()`, never the
   append-only `getEntries()`) and is unioned with the live touch record, which is
   what covers OLD sessions written before the `odd-worktree.odd-touch` entry
   existed and RESUMED ones. What it reads is `lib/odd-session.js`'s
   `associatedFromHistory`: a successful `write`/`edit` toolCall (its matching
   `toolResult` by `toolCallId`, `isError: false` — a failed or unanswered call
   never counts), the persisted touch entries, the `files_changed:` paths of a
   `gentle-agents.result` `custom_message`, and the `Spec: odd/tasks/<name>.md` line
   of a successful `subagent_run`/`subagent_continue` task — so a subagent's write
   counts for the parent. A path with `..` or one that is not exactly
   `odd/tasks/<name>.md` associates nothing. Within that scope the election, the
   order and the four-row body are unchanged, a touched name no longer on disk stays
   hidden, and the `/odd` panel is untouched (it still lists main whole plus each
   worktree's delta). `filesSessionWorktreeRoots` reads the same active branch, so a
   worktree registered only on an abandoned branch is out of scope.

   **Four switches are optional, and nothing else is.** The `Tools` page of
   `/gentle:customize` (`lib/modules.js`, a plain `registerRows` provider) holds the
   `Codegraph+`, `Worktrees+` and `Skills+` Off/On lines. They are read once, when the surface
   registers, from the package's own store; `Worktrees+` Off leaves out `/warp`, its
   card, the two tools, the worktree guards (the active-session guard a removal runs included)
   and prompt text, `Skills+` Off leaves out the two read rules, and `Codegraph+` Off leaves
   out the CodeGraph wiring, prompt text and reminders. The CodeGraph CARD is not one of
   these: it is a design of the `Card activity` line and follows that switch. A change lands on
   the next load, so each one says so. None adds a command or a tool name. `Codegraph+` and
   `Worktrees+` are ON unless the stored value is exactly `false`; `Skills+` is OFF unless it is
   exactly `true`, so an unset, malformed or unreadable document leaves the read rules out.

   **`Card message` is this package's own line, applied live.** The
   `Cards` page gains one `registerRows` provider — `lib/card-message.js`, the setting
   `Card message`, Off then On, On unless the stored document says exactly `on: false` —
   persisted as `card-message` in the shell API's own store beside `modules` and
   `identity`, and read on every paint. It gates the user prompt card, the assistant
   card and the `## User identity` block; its action asks the shell API for one
   `requestRepaint` and says nothing, so a change applies at once with no `/reload`.
   `Card activity` keeps the other cards (invariant 23).

   **The peak rows have one switch per provider, applied live.** `lib/alert-rows.js`
   contributes the `Alert` page of `/gentle:customize` with one line per entry of
   `lib/peak-providers.js` — `Deepseek peak`, `Claude peak` — every one of them Off on a
   first run, placed `categoryPlacement: { after: "Notifications" }` so the page opens
   between `Notifications` and `Layout`. A switch gates ONLY its provider's row above the
   editor: the `opencode-go` usage source, its panel, its status-bar segment and the other
   providers are unaffected, and nothing here depends on the session's model or on a usage
   key being present. Unlike the two module switches these land in the session in progress:
   the extension reads them on every sync, and a row's own action re-syncs. The values are
   booleans in the shell API's store (`odd-worktree` → `alerts` → `{ peaks: { … } }`), and an
   absent, malformed or unreadable document reads Off; nothing is written at load.

   **The shell API is native, and the sections reach the host only through it.** Both
   the issues rail and the ODD rail are published through the shell API's
   sidebar-section API alone: the object read from its
   `Symbol.for("odd-worktree/shell-api/v1")` slot after its schema and version
   gate, or the one `odd-worktree:shell-ready` announcement when an API
   publishes later. That API SHIPS IN THIS PACKAGE — this package's own code at
   `lib/shell-api/`, imported by the entry as `../lib/shell-api/extension.ts`
   (invariant 32) — so no host installs anything for this package's surface to
   exist, the slot is published at module load, and the package is reached by
   RELATIVE import, never by the package name and never through a runtime
   dependency. An INCOMPATIBLE object on the slot — another plugin published
   first — leaves this package's whole surface unregistered: no command, no
   tool, no section, no design, no row, no second attempt. The package says so ONCE
   in its own words, naming the slot, the schema and version it actually holds, and
   the surfaces it turned off. What the host still supplies is
   `gentle-pi`, the package registering `/gentle:customize`: rows and the rail arm only
   when the context has a UI AND that host is present, and without it nothing
   arms and the package says so once, naming `gentle-pi` and the surfaces that are
   off — its own text, never an install line.
   A host
   that has the API but draws no rail registers the section and never paints it,
   which is the API's business and not an error here. Its `/gentle:customize` → `Sections` visibility toggle is
   contributed by the shell API, not by this package (invariant 2 keeps every customize
   surface out of it except the two tool-design rows this package puts on the shell API's
   own `Card activity` and `Card file` lines), and the section declares NO
   preview: every `Sections` row draws the host's one shared list of active sections
   and the API adds this section's `rowLabel` to it itself, shown or left out
   with the row's own hypothetical (`registerSection` has no `preview` field — do
   not add one).
   `tools/issues-section.test.js` pins the slot gate from the outside — an
   incompatible object registers nothing and says so once, an announcement alone
   registers nothing until it fires —
   and `tools/package-surface.test.js` pins that the shell API is imported from
   `lib/shell-api/` only and never by the package name.

   **`/files` is a panel and nothing else.** It mounts its OWN overlay through
   `ctx.ui.custom` (the scope step's small card, then the picker), and a host with
   no such seam gets one honest line — `files: the file picker needs an interactive
   session with overlay support` — and no second surface in its place: no
   transcript dump, no sub-command, nothing written. Being a command, it needs no
   other package to DRAW: its overlay comes from the host's own `ctx.ui.custom`,
   not from the shell API — although, like every surface here, it is registered only
   once the API is published (invariant 3). This package binds exactly TWO host
   shortcuts, and each one keeps every property below: the picker's `alt+p` and
   the issues panel's `alt+i` (invariant 28). The picker's key is bound DIRECTLY
   on the host, at extension load, through `pi.registerShortcut`: `alt+p` by default
   (Pi claims `alt+p` on Windows and WSL) and `GENTLE_PI_FILES_KEY` whenever that
   environment variable holds a non-empty string. It is bound once,
   and the handler is the command's own, invoked with no argument and the session
   context the host hands a shortcut. A host with no `registerShortcut`, a host
   that throws from it and a missing command handler are the same silence: no key,
   no message, nothing else touched. It registers NO keymap action and NO palette
   row — through this package's shell API or otherwise — because no installed host lists
   a row a plugin contributes, so such a row could never appear and claiming it
   would be false. The command itself registers no store and writes nothing: it
   reads Git through the ordinary fixed argv (invariant 9) and paints.

   **The cards are a design on the shell API, not a preference here.**
   `lib/bash-design.js` registers ONE design (id `odd-worktree.bash-activity`, label
   `activity`) through the shell API's published `registerToolDesign`, at most once per
   process, with an idempotent disposer, and does nothing at all when the API is absent or
   older — no throw, no command, no warning beyond the section's own discoverability one.
   The shape follows the shell API's own `VERSION` and is decided BEFORE anything is
   registered: one line over `bash`, `grep`, `find`, `ls`, `read` and `write` on `0.6.0` and
   later (one `Card activity` row), gaining `edit`, and the scope on `write` and `edit` limited to skill
   and ODD paths, from `0.9.0` on — six tools there, seven here — and the single `tool: "bash"` design on anything older (one
   `Card bash` row) or on a release it cannot read — never a grouped registration an older
   shell API would refuse. A second design (`lib/diff-design.js`, id `odd-worktree.file`, label
   `color`) registers on its own `Card file` line over `write` and `edit`, on `0.9.0` and later
   only, and draws nothing for a skill or an ODD path because those rows are the file card's. The shell API owns Pi's one tool-renderer resolver, builds the host's
   own card, reads the line it is painting (`default` | `activity`, or `default` | `color` on
   `file`, stored as `native` | the design id) on
   every render pass and persists each choice in its own store. This package writes exactly three
   things to that store. The first is the first-run `activity` seed: `seedBashDesignSelection` selects `activity`
   once, for `bash`, only when the API holds no `bash` choice, and it does so BEFORE the
   registration, because a `0.6.0` shell API carries that choice over to its line's value at
   registration time; it records `bashActivitySeeded` in its own `odd-worktree` store so a
   later `native` is never undone. The second is the one-time line-key carry-over, which moves a
   value stored at `selections.$lines.tools` — the line's row was `Card tools` before the rename —
   to `selections.$lines.tags`, ONLY when `tags` is absent, and BEFORE the registration, so the
   API's own migration finds the key taken and copies nothing over it; a store that is absent,
   unreadable, of another shape or that throws carries nothing over and throws nothing. The third
   is the `file` line's own first-run seed: `seedDiffDesignSelection` selects `color` on `file`
   once, only when the API holds no `file` choice, carrying a value stored under the line's previous
   key `diff` over to `file` — the id `odd-worktree.diff` mapped to `odd-worktree.file`, any other
   stored value (`native` included) copied as it stands — and leaving the old key exactly as it
   found it, never deleted, so a user's choice survives the rename; and — because there is no legacy
   per-tool value for that line to inherit — it runs AFTER the registration the API accepted, so a
   refused registration never leaves a value naming a design nobody registered; its
   `fileDesignSeeded` marker (the older `diffDesignSeeded` one is no longer read) lives in that same
   `odd-worktree` store. A stored
   choice is never overwritten, a reserved line
   key is never written by the seed, a failure seeds nothing. It reads no other file, has no
   `/card:bash` command and depends on no extension load order.
   The design is pure: `apply(lines, ctx)` swaps the host's `$` on the heading
   row of a `call` part for the family `lib/bash-activity.js` names (or `$ bash`
   when nothing names it), swaps a read-only shell tool's `<glyph> <tool>` for the constant
   `⌕ exploring`, taking the added columns from the row's own fill, and
   through `lib/bash-frame.js` repaints the frame cells in one theme role and
   writes a finished call's duration into the closing rule. It changes colour and
   those cells only: no row's width changes, no text of the command, the arguments or the output
   is rewritten, and without a theme, a render context or room every row is
   returned byte for byte (invariant 20). Its only state is two bounded memos (512
   entries each: the classification of one command, and the answer for one
   tool/rows/theme/call key); a cache hit is byte-identical to a fresh drawing and a
   caller always gets a new array.

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
   the generation and the normalization. `/prs` opens through the SAME one-at-a-time
   guard (`dispatchPrsPanel`, its own token, the same ~10 s backstop) and pins its
   own repository with the same function, taking a numbered open's cached scope
   first and the fresh proof for a typed plain `/prs`; a rail click on an issue
   that carries a linked pull request leaves the bucket hint
   (`review` | `mine` | `all`) for that one number, in that generation.
   `tools/prs-command.test.js` pins it.

   **`/prs` is a panel and nothing else, exactly like `/files`.** It mounts its own
   full-screen overlay through `ctx.ui.custom`, and a host that rejects the overlay
   gets its own one honest line (`prs: the viewer could not open in this session`)
   and no second surface in its place. It registers no key of its own, and its
   capabilities are invariant 7's.

   **The file cards add no surface and own no switch.** They obey the shell API's own
   `Card activity` line: the card is painted while that line answers with this
   package's activity design (`odd-worktree.bash-activity`), so the file cards
   contribute no `Cards` row, no preference and no document of their own, and they
   are read through the same published object the design registers through. The
   gate itself — its reader, the id it accepts and its fail-open rule — is
   invariant 23.
4. **Deletion refuses on a live session.** The only surface that removes a checkout
   is `/warp`'s `ctrl+d`, and it goes through `lib/worktree-session-guard.js`
   before the pending-change question and again immediately before removal. This
   session's own checkout is refused with "warp first"; another session's is
   refused naming its real session id, or the presence hash plus an explicit
   "could not be resolved". Nothing is auto-warped. The check is best effort:
   stale, unattributable and truncated evidence is disclosed — the panel notifies
   each caveat the guard could not resolve, one notice per caveat — never
   silently dropped and never left blocking forever. The check belongs to the worktree
   half: it runs while `Worktrees+` is on, and with that module off the removal surface it
   guards is not registered either.
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
   repository. `lib/gh-prs.js` carries the SAME rule for `/prs` — one pin for every
   page, detail, label and assignee read, the same scope-drift refusal before a
   write — and `tools/gh-prs.test.js` and `tools/prs-command.test.js` pin both the
   pin and the refusal. A linked reference is identified by repository AND number
   on every surface that routes it: the rail's read and both issue reads ask for
   the reference's `repository { nameWithOwner }`, and one that names another
   repository gets no rail mark, no `/prs` dispatch and no pane click range
   (it is painted as `owner/repo#N`), so a same-numbered lookalike in this
   checkout is never opened, commented on or closed.
7. **`/issues` capabilities fail closed.** Close, labels and assignees need
   `TRIAGE`; creating a label needs `WRITE`; commenting is ungated. Anything but
   a literal `true` capability means no hint, no editor, no mutation. `/prs`
   reads its own map the same way (`pullRequestPermissions` in `lib/gh-prs.js`, into
   the view's `permissions`): labels and assignees need one of
   `TRIAGE|WRITE|MAINTAIN|ADMIN`, closing, merging and editing the linked issues
   need `WRITE|MAINTAIN|ADMIN` (so does creating a label, `canCreateLabels`, re-checked at the save), commenting stays ungated in every pull request state, every write re-reads the role — with the pull request's own state in that same round trip, so a non-open one keeps only its comment key — and writes under the ONE scope that read resolved, and `canMerge` is only
   true for a pull request that is not a draft in a repository that allows at least
   one merge method, with the merge form's chosen method re-checked against the freshly read `mergeMethods` before the seam. A refused key paints no hint and reaches no seam;
   `tools/prs-view.test.js` pins every refusal sentence and that no seam is called.
8. **The package ships `extensions`, `lib`, `tools` and `README.md`.** `files[]` is exactly
   `["extensions", "lib", "tools", "README.md"]`. Adding a
   shipped path means changing `files[]` and the package-surface test together.
   `docs/` is repo-only — it is not in the tarball — so a plugin author reads
   `docs/shell-api/` in the repository (the README links those GitHub paths), while
   the suites ship beside the code they test, under `tools/`.
9. **Fixed argv, never a shell string.** Every child (`git`, `gh`, package
   managers) gets a binary plus an argument array with a bounded timeout. Both
   `gh` seams — `lib/gh-issues.js` and `lib/gh-prs.js` — spawn through the same
   `execFile`-shaped runner with its argv array and its bound.
   Interactive paths await the async runner; nothing blocks the host event loop
   with `spawnSync`. The API host is part of that fixed argv: `gh api`/GraphQL
   never read it from `GH_REPO`, so every `/prs` `api` child carries
   `--hostname <host>` and its scope's `GH_HOST`, github.com included, and an
   ambient repository's host is read from `gh repo view --json nameWithOwner,url`
   rather than assumed.
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
    `<repo-name>-worktrees` in name order, and `all: true` adds the worktrees Git knows
    outside that directory. A row is the checkout's absolute path — whose last segment
    IS the ODD — and its branch; there is no `odd:` field, no date, no setup or hooks line and no
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
    returns a replacement `systemPrompt` (the API drops it) and no existing
    text is removed. The primary session gets one text
    (`lib/odd-prompt/odd-worktrees.md`); a child and a named agent get none. It is
    idempotent by content and `ODD_WORKTREE_PROMPT=0` suppresses it.
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
17. **This repo paints last; the only painted inputs it measures are the host's
    key hint and Pi's own Markdown rows.** Rows are wrapped, clipped to the inner
    width with the `…` mark and
    padded as PLAIN text and painted in their role afterwards (`cardBodyRows`,
    `cardLine`), so no painted string this repo composes is ever measured or
    clipped — which is why the `/warp` card's ANSI-unaware fallback clip draws the
    same text as the host's ANSI-aware helpers and copies the host's truncation
    rule (a width of zero or less is nothing; an ellipsis too wide for the budget
    is clipped and emitted itself). One painted input it measures is the host's
    `keyHint`, which the host paints before handing it over (`keyHint` returns
    `fg("dim", …) + fg("muted", …)`): `lib/worktree-cards.js:185` forwards it, it
    is measured only by `metrics.visibleWidth` at `lib/shell-card.js:218`, `:378`
    and `:424`, and the `/warp` path strips that paint at
    `lib/worktree-card.js:158`. The other is the file card's document body, which
    Pi's Markdown renderer painted: the card PLACES those rows with the ANSI-aware
    helpers (`cardPaintedRows`, `lib/shell-card.js:461`) and never paints them
    again (invariant 23). `tools/warp-fallback-regression.test.js` states
    both halves: the two seams draw the same text at the same width, and no body
    row ever hands a helper a string THIS REPO painted. The host's key hint is one
    of the two named exceptions above: it arrives already painted, it is measured
    here with the host's ANSI-aware width functions, and this repo then wraps it
    ONCE MORE in
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

20. **The design only draws, and it draws what the classifier names.**
    `lib/bash-design.js` changes nothing but a heading row: it executes, spawns,
    guards, intercepts and shadows nothing, and the destructive evidence of
    `lib/bash-destructive.js` is presentation: no permission, guard or execution
    decision may read it. A shell API that hands over the call's arguments makes them
    the evidence; without them the heading is the only evidence and a call is named
    only when the heading provably shows the WHOLE text — no `…` abbreviation, no
    `… +N lines` fold, no continuation row, nothing after it but the host's fill and
    hint — and the classifier (`lib/bash-activity.js`) names exactly one family for
    it. The classifier decides by text and by one order: a deletion outranks everything,
    even a segment nothing can name (the heading claims only what the call provably did);
    below it a segment nothing can name keeps the call generic (a call that runs CodeGraph
    stays `codegraph`), and among the named
    families `codegraph`, `publishing`, `versioning`, `checking`, `formatting`,
    `preparing` and `exploring` rank in that order. What it reads is text it can follow:
    a quoted heredoc body is data (never a flag, a redirect or a substitution), a redirect
    into a file from a read or from plain text is `preparing`, and an inline script is
    named only by what its own text proves (`lib/bash-inline-script.js`). The three read-only shell tools the same design paints (`grep`, `find`, `ls`)
    are headed `exploring` whatever they read, and a read-only heading that cannot be
    proved is returned unchanged: those three have no generic word of their own. The
    line also declares `read` and `write` (`lib/bash-design.js`) even though the design draws
    nothing for either: `exploring` names what a SHELL COMMAND does, and a read runs no
    command. The declaration is what lets the file card ask the API about a read or a
    write, and the rows of both come back byte for byte. Any
    other case, a row with no fill to pay for the word included, keeps the host's `$`
    or its own `<glyph> <tool>` exactly as drawn, and a tool the design does not cover
    is returned untouched. The design never throws and never mutates its input. The
    CodeGraph card (invariant 19) keeps its own resolver for `codegraph …` rows and follows
    this same line, never a module switch;
    this package registers no other tool-renderer resolver for `bash`.

21. **The two CodeGraph reminders advise, never block, add no surface, and belong to the primary session.**
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
    **Guard 2** is the primary session's alone: a child lives a message or two and its own
    `## CodeGraph` text already states the rule, so it hears no reminder at all.
    It fires once per checkout per request, on the first search of the session's own
    checkout while CodeGraph is unused in that request (keyed by the checkout, so a
    `/warp` re-arms it); no later search of the same request repeats it, and a use of
    `codegraph` or the MCP tool after it changes nothing.
    Its first-search slot and its `used` flag are per request: every
    new request (`before_agent_start`) forgets them, while guard 1's slots and the
    explored checkouts stay per session, and a compaction or a new session forgets
    everything. The primary session gets `Follow the CodeGraph rule: run codegraph query
    or explore first.` (`codegraph`, `query` and `explore` in backticks; with only the MCP
    tool, `Follow the CodeGraph rule: call mcp__codegraph__codegraph_explore first.`).
    It is advice: it never blocks.

    **A call that failed is no subject at all**: the model got no result to read, so
    no reminder rides an error result, no once-per-key slot is spent, and a failed
    `codegraph` or explore call is no use of the graph either.
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

22. **The tool guards read text and paths, fail open and add no surface.** The
    extension's `tool_call` handlers decide three things — two in
    `lib/worktree-guard.js`, one in `lib/skill-read-guard.js` — as pure functions, and a
    call they cannot judge passes.

    **`bash`** (`decideBashGuard`): a call whose command contains `git … worktree
    add` in any cwd is refused, and, only when the command
    runs in the principal checkout (its root is the parent of the git common dir) AND
    that checkout is on the repository's default branch, so is a switch that leaves
    that branch. Detection is text only: no script, alias or file is read. Seams:
    `repoIdentity`, `defaultBranch`, `currentBranch`, `pathExists`.

    **`edit` and `write`** (`decideWriteGuard`): a call whose `path` lies inside the
    principal checkout of the SAME repository as the session's cwd, while that
    checkout's current branch (read fresh, never cached) is the repository's default
    branch, is refused with one sentence: `<path> is in the primary checkout on
    \`<default>\`. Work in a worktree (\`worktree_list\` / \`worktree_create\`).` The
    path is judged by its existing parent directory, realpath-resolved (the only disk
    read: no file content), and by the checkout that owns that directory, so a linked
    worktree or nested repository inside the principal directory passes. Everything
    it cannot place passes: a path outside every repository, **a path under the OS
    temp directories (`os.tmpdir()`, `TMPDIR`, `/tmp`, `/var/tmp`) even when a
    scratch repository lives there**, a path in another repository, a path in a linked
    worktree, a session cwd outside version control, an unreadable identity, a detached
    HEAD, another branch, an unresolvable default branch and a bare or separate git
    dir. A temp path is settled before any git read, and so is an ODD artifact: **a path
    below an `odd/` folder is never refused**, on any branch, because that is where an
    ODD is written down — the folders decide, by the file card's own identity
    (invariant 23), so a nested `odd/` is one and a file named `odd` is not.

    **A skill read** (`decideSkillReadGuard`, registered after the worktree guard's so that
    one decides first): a `bash` call whose reader (`cat`, `head`, `tail`, `less`, `more`,
    `bat`, `batcat`, `nl`, `awk`, `sed` without in-place, also behind `timeout`, `sudo`,
    `env`, `command` or `bash -c`) takes a skill file — a path below a `skills` folder, by
    the file card's own identity (invariant 23) — is refused whole, naming the first such
    path and the `read` tool. It reads no file and spawns no child; a quoted mention, a
    heredoc body, `grep`, `rg`, a write and a `$VAR` path pass. **And the same rule's other half**
    (`lib/artifact-read-full.js`): a `read` of a `.md` below a `skills/` or an `odd/` folder has its
    `offset` and `limit` DELETED from the host's `event.input` before the tool runs, so a skill or an
    ODD is delivered whole and never half a procedure. It blocks nothing and answers nothing. Both
    observations follow the `Skills+` module switch — OFF by default — and touch no worktree surface.

    **Both worktree guards (the `bash` one and the `edit`/`write` one) judge the primary session only**:
    creating a worktree and leaving the default branch are the orchestrator's actions, so a subagent
    child (`GENTLE_PI_AGENTS_CHILD=1`, read per call) passes both. The skill-read guard and the
    whole-read rule still apply to every session that has `Skills+` on.

    No guard ever throws (a throwing `tool_call` handler blocks the tool), an
    unreadable repository leaves only the `bash` worktree refusal active, and the
    default branch is resolved lazily and memoized per checkout.
    `ODD_WORKTREE_GUARD=0` takes the two worktree guards and the skill-read refusal away, like
    `ODD_WORKTREE_PROMPT=0` for the prompt blocks, and the switches decide first:
    `Worktrees+` off leaves the two worktree guards out at registration and `Skills+` off —
    its default — leaves the two read rules out, each at registration, so neither the
    module nor the environment variable can be worked around from a call; no
    other value, option or config file does, and they register no command or tool name (invariant 3). Each refusal
    names the tool that replaces the blocked action, and the prompt block (invariant
    14) is what keeps the agent from reaching them, so a change to one is read
    against the other.

23. **The file card only draws, and it claims exactly three tools.** `read`, `edit`
    and `write`, and no fourth: `lib/file-card-resolver.js` registers one resolver
    through the host's `registerToolRenderer` hook, hands every row of every other
    tool back exactly as the chain resolved it, registers nothing when that hook is
    absent, and leaves a host without a usable measurement seam its own rows. What a
    call heads as comes from its `path` alone, through the pure functions of
    `lib/skill-odd-card.js`: a skill is anything below a `skills` folder, an ODD
    artifact is anything below an `odd` folder, both read as path components with
    both separators, and a path that names both is decided by the marker closest to
    the file. The file's own name decides no identity — a skill's references are part
    of the skill — and the three tools are one shared claim (`FILE_CARD_TOOLS`), so a
    `grep` or an `ls` that names such a path is still the activity design's row. The card states that identity's mark and label, the tool,
    the path and — for a read only — the line range the call asked for. A path
    naming neither identity is the chain's own row, and so is a row of one of these
    three tools while the API's line answers with anything but this design.

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

    **The jobs and CodeGraph cards claim their tools on every answer, because Pi
    never asks twice.** The host resolves a tool's renderers ONCE, when it mounts
    the card (`interactive-mode.js` hands the definition it resolved to
    `ToolExecutionComponent`), so a `Card activity` gate read at resolver time could
    only ever reach the next card. Both gates are therefore read INSIDE the
    component's `render(width)`, which the host does run on every frame, and both
    cards draw the host's own rows for every answer but `activity`:
    `bash_background`, `monitor`, `job_stop` and `job_list` have no renderer of their
    own, so `lib/file-card.js` reproduces the host's fallback itself —
    `formatToolCallWithArgs` for the call, `createResultFallback` for the result
    (read with the host's own `sanitizeBinaryOutput(stripAnsi(...))`), inside the
    same reproduced box, whose ONE closing blank is the call's only while no result
    follows and the result's afterwards; the CodeGraph card hands the row to the
    chain's own renderers, captured by reference when the card was built, and
    reproduces that same fallback for a tool whose definition resolved none (Pi's
    own `codegraph`, which declares `renderShell: "self"`: its rows are drawn bare,
    with no box) or whose renderer throws, exactly as the host catches it. `bash` is
    the exception: its call is decided per COMMAND, which a resolver never sees, so a
    bash row is wrapped only while the line already claims it and a bash call that
    runs no CodeGraph keeps the host's very component — rows, mouse handling and all
    — on every answer. One row of difference is expected and is the host's own: a
    self-framed tool gets the host's separator blank row above it, exactly as the
    file card's forwarded rows already do.

    **The API's design selection is the one switch, and this card owns none of
    it.** The card is painted while — and only while — the API's published
    reader answers that this package's activity design draws the tool being
    painted. That reader is `api.resolveToolDesignSelection(tool)`, reached from
    the `Symbol.for("odd-worktree/shell-api/v1")` slot after its schema and version
    gate (`lib/file-card-resolver.js:51`, `:160`) and never imported, and the
    answer that paints is `{ kind: "design", design }` with
    `design.id === "odd-worktree.bash-activity"` (the id at
    `lib/file-card-resolver.js:54`, the decision at `:78`). `native`, `missing`,
    `not-covered` and any other design hand the row back to the host, its box and
    its key hint included. The question is asked per painted tool, on every frame,
    never cached, which is what repaints a card already on screen after a
    mid-session switch. It fails OPEN: the reader is an
    OPTIONAL member of the published object, so a shell API older than 0.7.0 — or none
    at all — cannot answer and an answer this build cannot read is unreadable, and
    in both cases the card paints exactly as it did before it joined that line: an
    unavailable gate never hides a row, and nothing here throws. The answer, the
    card style slot (`lib/card-style.js`) and the content level
    (`lib/card-content.js`) are read at paint time, inside the component's
    `render(width)`. The card only draws: it adds no command, no tool and no
    customize row of its own.

    **The document body is Pi's own renderer.** An expanded — or previewed —
    Markdown document is drawn by `Markdown` from `@earendil-works/pi-tui`
    (`markdownRows`, `lib/file-card-markdown.js:116`) with a theme table
    (`fileCardMarkdownTheme`, `:82`) that gives every Markdown element a theme ROLE
    (the table is `MARKDOWN_ROLES`, `lib/file-card-markdown.js:26`:
    `heading`→`mdHeading`, `listBullet`→`mdListBullet`,
    `code`→`mdCode`, `codeBlock`→`mdCodeBlock`, `codeBlockBorder`→`mdCodeBlockBorder`,
    `quote`→`mdQuote`, `quoteBorder`→`mdQuoteBorder`, `link`→`mdLink`,
    `linkUrl`→`mdLinkUrl`, `hr`→`mdHr`, and the text attributes from the theme's own
    handlers). Those rows arrive ALREADY PAINTED, so invariant 17's exception is the
    host's own: the substrate PLACES them with the injected ANSI-aware width
    (`cardPaintedRows`, `lib/shell-card.js:461`) and never re-paints them with a
    body role, while the frame, the background and the padding stay ours. A host
    with no TUI package, a renderer that throws and a document that draws no row
    all fall back to the wrapped plain source, unstyled.

    **What document a call draws is its own answer.** A `read` draws the text it
    returned, a `write` the content its call carried, and an `edit` the fragment it
    leaves behind (`editedFragment`, `lib/skill-odd-card.js`): its `edits[].newText`
    in the call's own array order, joined with one newline, or the legacy top-level
    `newText` when the call states no array, with no non-string entry stringified.
    `oldText` is never read, because the removed text is exactly what that document
    must not show — no hunk header, no gutter, no `+`/`-` marker. That fragment is
    also the edit's plain fallback, so a host without the renderer is answered by the
    same text rather than by the diff. An edit that leaves no non-whitespace text (a
    pure deletion) draws no document at all: it keeps the rows it has, the diff the
    host carries (`details.diff`) — its own text when it carries none — with no
    invented placeholder, and a failed edit keeps its error rows.

24. **No session path waits on `gh`, and every `gh` reach is deferred.**
    `session_start` DISPATCHES the `gh` gate as tracked startup work under the
    generation the dispatch captured and never awaits it, so opening a session or
    switching to another one spends no child process and no network call there —
    and a host without the CLI dispatches no gate at all, because the three GitHub
    surfaces were never registered. What the gate does off that path is one local
    `git rev-parse` for repository-ness and the `gh` health read only when that
    answers yes; a late answer from a session that has ended sets no state and
    notifies no UI. `/issues` and `/prs` take that same verdict when they open
    instead of
    starting a second probe, and each asks its own question about its OWN cwd when the
    session's answer was only a non-repository state. In the rail, `lines()` and
    `meta()` keep their synchronous contract: they read ONE in-memory snapshot and
    only schedule the refresh — and the second read (the rail's pull requests,
    `lib/gh-prs.js` `listRailPullRequests`) is only ever SCHEDULED by a frame:
    the work itself runs through the extension's async loader, and the persisted
    entry is touched there alone.
    `tools/issues-command.test.js` pins it with "the
    awaited session_start resolves while the injected gh runner is still pending"
    and "a session outside a repository makes no gh call at startup, and stays
    silent"; `tools/issues-section.test.js` with "a frame never waits" and "without
    the gh CLI the GITHUB section is never added to the rail";
    `tools/prs-command.test.js` with "a section the host was drawing asks for a
    read, dispatched and never awaited" and "a hidden section starts no read at
    session start".

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

    **The rail's pull-request entry cannot fake a number either.**
    `lib/prs-rail-store.js` persists the two bucket ROWS, each bucket's TOTAL and
    when they were read, never the count: the header's `M` is the distinct numbers
    in mine ∪ review plus the remainder of each total, DERIVED on load from what the
    document holds (the count itself is never written), so a stored entry can never
    contradict what is painted. A total below the rows it came with, or one that is
    not a count, is ignored and the rows stay the floor — exactly the rule the live
    read obeys — so 50 rows with a total of 52 is `52 pr` before a restart and after
    it. The document is versioned (the totals moved it to version 2, and a document
    of an older version is SILENCE, a cold cache, never an error). The extension
    hydrates the stored entry from the section's async loader so a cold start paints
    it at once, under its own `syncedAt` (it never passes for a fresh read and never
    defeats the TTL) and never for a settled state; the live read then replaces it,
    it is also the fallback for a read that failed, and the extension writes an
    entry only from a successful read in the generation that asked, and drops the
    entry's identity (so it is never hydrated back) after a mutation made in
    `/prs`. Both settlements of that read — the stored one and the live one — ask
    the section's own notifier (`onRefreshed`) for the frame the new count is
    painted by, exactly like the issues read, so the header never keeps an old
    number until some unrelated event produces a frame; a frame itself never asks.
    Keyed exactly as the rail keys its own reads (`<host>/<owner>/<repo>`),
    bounded to the eight most recent identities, written as a temp file plus a
    rename, and read only from the async loader. `tools/prs-rail-store.test.js`
    pins the document, the totals it derives from and its silence;
    `tools/prs-command.test.js` pins the fallback paint, the totals that survive a
    restart, the invalidation after a mutation, the repaint the settled read asks
    for and that no temp file is left behind.

26. **The rail's timed refresh exists only while the section is drawn.** With a
    floor named, `lib/issues-section.js` keeps ONE self-scheduled, unref'd timer at
    that floor: a DRAW arms it (`lines()` or `meta()` — a collapsed section is a
    painted frame too), its own fire re-arms the next floor, a read already in
    flight owns that instant, and it stops by itself the moment the section leaves
    the drawn window, so a section the host stops painting keeps it no longer than
    that window. `invalidate()` and `dispose()` clear it, which is what a session
    boundary performs. That one timer serves BOTH reads: the pull-request read is
    asked behind its own TTL and its own one-read-in-flight guard, inside the same
    drawn window, so a fresh issues snapshot never keeps an aged `pr` count on
    screen and a hidden section asks for neither. A section nobody draws keeps no
    timer, spawns nothing and
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
    so one result starts at most one read per cap. Both reads go with it: the
    forced read also asks the pull requests (`ensureFreshPullRequests(0)`), behind
    their own one-in-flight guard, which the issues cap does not govern. The
    classifier is text only: no
    child, no file, no clock, no cache, and it never throws; a mutation merely
    MENTIONED in an argument, and a read such as `gh issue list`, names no write.
    `tools/issues-bash-mutation.test.js` pins the classifier;
    `tools/issues-section.test.js` pins "a mutating bash result forces one read,
    capped to one per 5 s", "a mutating bash named under `tool`/`args` forces the
    same read" and "a hidden section forces no read, and a mutating result after
    shutdown does nothing".

28. **A missing `gh` CLI removes the three GitHub surfaces; a non-repository cwd is a
    settled state.** The CLI question is answered ONCE, at registration, by a local
    `PATH` walk (`lib/which-command.js`) with no child process: absent, `/issues`
    and `/prs` are never registered and the `GITHUB` section is never added to the
    rail, so there
    is no line, notice or refusal to draw for it — nothing appears, because nothing
    was registered — and every other surface keeps working. The panel's own host
    shortcut is bound only when that command actually registered, so the gate
    leaves no dead key behind: `alt+i` by default, `GENTLE_PI_ISSUES_KEY`
    overriding it when that variable holds a non-empty string, bound once at load
    through `pi.registerShortcut`, its handler the command's own invoked with no
    argument and the session context — the picker's silence applies unchanged to a
    host with no `registerShortcut` and to one that throws from it. `/prs` has no
    host shortcut at all, so the gate has no key to leave behind for it. The path
    guards that
    remain (the gate, either command's own probe, the rail's read) are defence in depth
    for a `gh` that disappears after load: they still fail closed with no child, and
    the rail's `gh CLI not installed` `dim` line is that case alone. A cwd outside a
    repository is one short `dim` line — `not a git repository` — and a checkout that
    IS a repository but has no remote is its neighbour: one short `dim` line, `not a
    GitHub repository`, drawn from gh's own `no git remotes` refusal (there is
    nothing to resolve FROM) instead of its long failure sentence.
    A `dim`/`muted` error snapshot is a STATE, not a failure to retry: no later frame,
    no activity read, no timer and no forced read starts there, and only a session
    boundary supersedes it; a non-repository cwd costs the one local `rev-parse`
    every surface makes and no `gh` call, and the no-remote one costs that plus the
    `gh repo view` probe the session gate already runs and never a read. `tools/which-command.test.js`
    pins the lookup;
    `tools/issues-section.test.js` pins "a non-repository line is a state, so no
    frame and no activity read", "a settled (dim) state owns no floor timer" and
    "without the gh CLI the GITHUB section is never added to the rail";
    `tools/issues-command.test.js` pins "without the CLI neither the command nor the
    rail section exists" and "the decision costs no child process, at load or at
    session start".
29. **The two message cards are DRAWING shims, gated by this package's own `Card
    message` switch and never touching the host's text.** `lib/user-prompt-card.js` wraps
    `UserMessageComponent.prototype.render` and `lib/assistant-message-card.js` wraps
    `AssistantMessageComponent.prototype.render`, the two host classes this package
    patches, because Pi publishes no extension seam for a `role: "user"` entry nor for an
    assistant message: each class is handed in from the extension's lazy `import()`, so
    `lib/` imports no Pi package and a host without the export installs nothing. Both
    wrappers come from `lib/host-render-shim.js` with the card's own `Symbol.for` cell, so
    the two cards install and uninstall independently and `/reload` replaces only the live
    logic. The assistant card draws a message ONLY while its own `hasToolCalls` is
    `false` — the final answer of a turn, in a resumed or an old session alike, never an
    intermediate one — and the "no job or sub-agent pending" filter is NOT applied
    because a transcript cannot prove it, so a message that ends a turn while a background
    sub-agent is still running is drawn as final. Its heading is the fixed `✿ Gentleman`,
    the clock and the turn stats of the session history (`turnStats` over the extension's
    `entries` seam, the current session's own `getEntries()`), frame and title in the
    theme role `mdHeading`, and its body is Pi's own rendering placed at the frame's inner
    width, never repainted. The card it draws is a
    `✿ Jona · HH:MM` card — the name `/identity` stored, `You` while none is stored —
    on the card substrate (`float`/`neon` read live, tone `info`,
    the whole frame and the title in `accent`, the separator and the clock in
    `muted` — the component's own `timestamp` when Pi restored the prompt, else the
    clock captured once at its first paint, else no subtitle at all — and the body
    Pi's own Markdown clone with the
    user-message background dropped and its painted rows placed, never repainted).
    The ONE stated exception to "never touching the host's text": the ` ❯ ` mark an
    extension markdown transformer prepends to a user message (pi-pretty's
    ` ❯ ${markdown}`) is dropped, because the card's Markdown clone wraps the host's
    composed `transform` and consumes exactly ONE leading ` ❯ ` from its answer — the
    component's own `text` is never rewritten, a person who typed `❯` at the start of
    their own prompt keeps their own character (their run arrives after the
    decoration), and a prompt no transformer decorated is drawn byte for byte as
    before, so the body re-wraps at the frame's full inner width instead of hanging
    below a mark nothing indents.
    A successful install asks the API for ONE `requestRepaint` (a differential
    frame) so a transcript restored before the deferred host import resolves comes
    back as cards instead of waiting for unrelated input; a refused install, a
    closed session and an API without that member request nothing.
    It adds no row, command or design of its own: the one `Cards` row it follows is the
    `Card message` switch's, which the surface invariant 3 lists once. The
    gate is `cardMessageOn()`, asked INSIDE the patched `render` on every paint and never
    cached, which is what repaints a prompt already on screen: with the switch Off — and
    for an absent or throwing shell API, a width below six columns, or a component whose
    Markdown shape is not Pi's — the host's own rows come back BYTE FOR BYTE, fail
    CLOSED. The shell API's `Card activity` line no longer decides this card; it keeps the
    file, jobs, CodeGraph and message cards (invariant 23).
    Pi's OSC 133 prompt-zone markers are re-emitted once on the card's first and last
    row and never on the native path, so shell integration is not degraded. The
    wrapper is installed once per process through a `Symbol.for` slot (a second
    evaluation, `/reload` or a second session replaces only the live logic), never
    throws, is re-installed on `session_start` and restored to the original `render`
    by reference on `session_shutdown`, and its memo is keyed on everything that
    changes a row (the width the frame really draws at, the resolved paint, the stored
    name, the rendered Markdown rows), so a style change, or a name set or cleared,
    always recomposes. An ACTIVE card paint pays three live reads and nothing else: the
    gate itself — the live `card-message` document, asked on every paint including the
    native one — the stored name (`lib/user-identity.js`, one synchronous document
    read, made only once the gate has answered On and the width and the
    body can draw), and, only while the card actually draws, the shell's style (the
    published slot, or `<home>/card-style.json` when none is published), which is the
    price of a prompt that repaints the moment any of them changes;
    the drawing
    recomputes nothing on a steady frame. `tools/user-prompt-card.test.js` pins the
    gate and its live flip on
    one instance, the byte-for-byte native answers, the accent cells in both styles,
    the zone markers and the wrap-once/uninstall-by-reference claims.

30. **ODD activity does not set the session name.** Task writes and edits are
    recorded for the ODD rail only; session naming belongs to the host's session
    identity tool. `tools/session-name-ownership.test.js` pins this boundary.

31. **The ODD panel folds by default, counts what it lists, and lines a document up
    under its group's name.** `lib/odd-view.js` keeps the OPENED checkouts in one
    set (`expandedCheckouts`), so a group is folded unless something opened it: the
    panel mounts with every group folded, and a target expands ONLY the group that
    owns that document. Each header carries its group's TOTAL as `(N odd)`, the title
    sums those totals (folding never moves the number), and a document row is
    indented so its text starts at the column its group's name starts at — the flat,
    ungrouped listing stays byte-identical, which is what the pinned frames measure.
    A group whose filtered rows are empty is not drawn, no worktree group means a flat
    listing, and two drawn groups sharing a name are qualified with their parent
    directory so a folded header is never its twin's equal. The rail's heading answers
    the same count through `meta()` — `N odd`, `N odd · stale` — and starts no read.
    `tools/odd-view.test.js` (S1-S5 of odd-panel-groups) and
    `tools/odd-rail-section.test.js` (S7) pin the shapes; `tools/odd-panel-wiring.test.js`
    pins that a scope is read from the headers it draws.

32. **The shell API is native.** `lib/shell-api/` is this package's own code — no
    nested package, no manifest of its own, no second copy anywhere, and no
    copy-into-this-package rule: it is edited like any other module (its public entry
    is `lib/shell-api/index.ts`, its Pi-side factory `lib/shell-api/extension.ts`).
    What never changes is the COMPATIBILITY SURFACE, because third-party plugins and
    users' saved choices depend on it: the slot
    `Symbol.for("odd-worktree/shell-api/v1")` publishing a frozen object at module
    load (schema `odd-worktree/shell-api`, version 1, `VERSION` 0.16.2, twelve
    members), every `Symbol.for("odd-worktree…")` key, the
    `odd-worktree:shell-ready` event, `shellApi()`/`onShellApi`, and the
    `<config home>/gentle-shell-bridge` store directory — all exactly as they were, so
    a plugin that reads the slot keeps working through this package alone and a user
    keeps every saved choice. The entry loads it FIRST —
    `extensions/odd-worktree-tools.ts` imports `../lib/shell-api/extension.ts` and
    calls that factory before any surface of its own — so the slot is published before
    anything here looks for its object. There is NO external dependency and NO import
    by package name anywhere: the root manifest names no `dependencies` at all. An
    INCOMPATIBLE object already on the slot (another plugin published first) leaves
    this package's whole surface UNREGISTERED — no command, no tool, no section, no
    design, no row of its own, no second attempt (the API's own plumbing rows, such
    as the `Sections` visibility line, still arm for a host that has `gentle-pi`, as
    they always did) — and the package says so ONCE in its own
    words, naming the slot, the schema and version it actually holds, and the
    surfaces that are off. Its surfaces still arm only for a host that has
    `gentle-pi`, the package registering `/gentle:customize`: without it nothing arms
    and the package says so once per continuous absence (a host that appears and
    disappears again earns a new notice), naming `gentle-pi` and what is off. Neither
    notice is silent. The missing-host case leaves the commands and tools working; the
    foreign-object case does not (it takes the whole surface down, as stated above),
    and describing that object can never throw, because it is another plugin's. Its tests are
    `tools/shell-api/*.test.ts` and `tools/shell-api/*.test.mjs`, run by
    `npm run test:shell-api` on Node >= 22.18 (the suite is TypeScript) in CI on 22.x
    and 24.x, while its core never runs in the plain-JS suite at all (the fixture
    stubs the one import). A second copy of this API loaded in the same process
    shares the global state ("first wins"), so this package's own surfaces are unaffected;
    the only visible difference is which copy's words a shared notice such as the
    missing-`gentle-pi` warning uses (whoever runs it first). That
    harmlessness is a property of the shared state, so the SHAPE of every
    `Symbol.for` slot is frozen too, not only its key — including the values cached in
    it. An older copy re-validates a slot by a field and overwrites it when the field
    is missing, so a field nothing here reads any more (`adoptedMessages` in the
    message-design adoption state, `owner` in the tool-design index and its
    `TOOL_DESIGN_INDEX_SHAPE` stamp) stays, and the plugin-line attribution kind
    stays `shell-api`, because an older copy writes and reads it.
    `tools/shell-api/message-design-adoption.test.ts` and
    `tools/shell-api/compatibility-regression.test.mjs` pin the adoption slot, the
    attribution kind and a foreign object that throws when described.
