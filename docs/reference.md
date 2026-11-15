# Reference

Detail behind the [README](../README.md): how each surface behaves, its keys, its limits and
how the package is tested and released. The repository invariants live in
[`AGENTS.md`](../AGENTS.md).

## Create, list, move and delete, in detail

1. **Create** — `worktree_create` with an `odd` and a `branch`, or press `c` in
   `/warp`.
   - `odd` and `branch` are required; `copy_changes` is optional.
   - `odd` IS the checkout's directory: one path segment (letters, digits, dash,
     underscore, dot), nothing that could escape the directory it names. The
     branch never names a directory, so `branch: feat/login` with
     `odd: login-ui` lands in `…-worktrees/login-ui`. The panel's two typed
     fields normalize one thing before they compose: one or more consecutive
     spaces become a single `-`, so a typed `change    cost` is `change-cost`
     (a name that leaves nothing behind after the trim still refuses with the
     field's own sentence). The tool takes its arguments as given — the panel is
     where a typed name is normalized.
   - The base is the local `main` when it resolves, else the branch `origin/HEAD`
     names, else `init.defaultBranch`. When none of them resolves, the create is
     refused with `could not resolve a base branch: tried main, origin/HEAD,
     init.defaultBranch` before anything is written.
   - Four refusals protect what already exists, each before a single write:
     `odd … already has a worktree: …` (use that worktree instead of creating
     another), `worktree path already exists: …` (remove it or pass a different
     odd), `branch … is already checked out in …` (use another branch, or work in
     that worktree), and `branch main is the base branch; pick the branch this
     worktree should work on`.
   - A whitespace-only or otherwise unusable `odd` is refused here with
     `invalid odd name: …` — a deliberate divergence from the reference branch,
     where it would create a directory nobody can see and a record the store must
     then refuse. An omitted `odd` gets the same sentence: the schema asks for it,
     and the plan refuses it if anything reaches the core directly.
   - An existing branch is adopted as-is — the answer's second line says
     `branch: <branch> (existing)`, and `(created)` when the branch was made from
     the base.
   - The answer prints the ODD once (`odd: <name>`). The list does not: a row's
     name IS the ODD, so printing the field again would repeat it.
   - `copy_changes: true` carries the uncommitted work of the checkout the call
     was made from — the one the session stands in, not necessarily the main
     checkout — into the new checkout: staged, unstaged and untracked
     non-ignored files. The source checkout keeps those changes.
   - **A create is instant.** The checkout, the session registration and the
     preparation hooks (submodules, local inputs, `copy_changes`, build-cache and
     asset links) settle before the answer. The slow half — the package manager
     the root's lockfile selects, or nothing when no lockfile matches — continues
     in one tracked background task with its own log under the system temp
     directory. At call time the create knows neither which hooks were skipped nor
     how setup went, so the answer says nothing about either: the one setup
     notification follows the child process outcome and belongs to the caller that
     asked for it. A setup problem is never reported as a failed create.
   - **The create writes nothing.** The checkout's directory
     (`<repo-name>-worktrees/<odd>`) is the whole record; there is no list file,
     no lock file and no record to keep in step.
2. **List** — `worktree_list`, or open `/warp`. Pass `all: true` to the tool (or
   `v` in the panel) to also see the worktrees Git knows outside
   `<repo-name>-worktrees`. The listing is read-only: it writes nothing and
   prunes nothing.
3. **Move** — `/warp <name>`, the selector's `enter`, or a typed name. The
   selector never offers the checkout you are already in; the exclusion is by
   resolved real path, so a differently-spelled path to the same checkout is
   excluded too. No agent tool moves the session.
4. **Delete** — `/warp`'s `ctrl+d` on the focused checkout, with a forced removal
   only for a dirty checkout. It asks for confirmation, then re-checks the
   identity of the checkout and the live-session guard immediately before the
   removal. No agent tool removes a checkout.

## Panel keys

`/warp` selector — the footer legend is the key reference.

| Key | Action |
| --- | --- |
| `↑`/`↓`, `j`/`k` | Move the selection |
| `enter` | Warp to the focused checkout (`enter` on the `view all worktrees` row opens the extended list) |
| `c` | Open the create flow: answer `Branch` (the change type from the eleven-type list, then the name — composed as `<type>/<name>`, `feat` by default) and `Odd` (the checkout's directory) — `tab`/`←`/`→` switch between the two fields, `↑`/`↓` pick from the active list, typing fills the active name, the ODD list's first entry is `new odd` (the only one that takes a typed name) and its other entries are the ODDs that exist in `main` minus the ones whose checkout already exists, `enter` on the ODD creates, `esc` cancels. In BOTH typed names one or more consecutive spaces become a single `-` (`change    cost` is `change-cost`), and the typed row, the preview and the create always show and use the same name |
| `ctrl+d` | Ask to delete the focused checkout; the extension owns the confirmation, the evidence and the removal |
| `v` | Open the extended list of every other checkout (`↑`/`↓`, `pgUp`/`pgDn`, `enter`, `T` or `/` to filter, `esc` back) |
| `r` | Reload the listing |
| `esc`, `ctrl+c` | Close the panel |

`/odd-list` — `↑`/`↓` select, `t` search (`T` and `/` also open the box), `o`
open the document in `$VISUAL`/`$EDITOR`, `s` toggles the order between `recent`
and `name`, `r` reload, `esc` close. `←`/`→` and `[`/`]` scroll the list; the
document pane pages with `ctrl+j`/`ctrl+k`.

`/issues` — the tab bar reads `My issues (<n>)`, `Assigned (<n>)` and
`Involved (<n>)`; `All` is not a tab, it is the `g` shortcut's own view, and there
the bar reads only `All (<n>)`.

| Key | Action | Needs |
| --- | --- | --- |
| `↑`/`↓`, `j`/`k` | Move the selection | — |
| `←`/`→` (also `tab`/`shift+tab`) | Cycle the three scoped tabs; inside `All` they do nothing | — |
| `g` | Enter `All`; the same key returns to the tab you came from. Inside the search box it types a letter | — |
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

**The shortcut teaches itself.** Outside `All` the footer reads `g all issues`;
inside it the same key reads `g related issues`, because there it goes back — to
the tab that was active when you entered, never always the first one. The key is
`g` and not `a` because `a` already assigns, and the letters the reading
interaction binds are taken anyway (`l` labels, `c` comments, `x` closes, `o`
opens the browser, `t` and `/` search, `r` refreshes, `j`/`k` move and scroll, `q`
closes). While a search box is open `g` is a letter of the query and moves
nothing.

**The legend drops hints rather than clipping them.** One row holds the keys:
while the full tokens fit it keeps them, then it compacts to its short spellings,
and past that it drops its lowest-priority hints first — `esc close` is dropped
last and `↑↓ move` just before it. The `g` hint sits below the editor hints in that
order, so a narrow row loses it before `c comment` or `a assign` does, and the
narrowest rows carry only `↑↓ move · esc close`: the key still works there, it is
simply not taught. The footer is a guide, not a complete key list — `]`/`[`, `T`,
`/`, `X`, `home`/`end`, `q` and the preview's paging alternates all work without a
token.

Creating a **new** label is a separate capability inside the labels editor and
needs `write`, so a triage-only viewer opens the editor normally and sees
neither a create row nor its `n` keybinding. Commenting is deliberately ungated:
GitHub lets anyone with read access comment, so requiring triage would hide an
action the viewer is allowed to take. Anything but a confirmed capability fails
closed — no hint, the key refuses on screen, no editor opens, no mutation is
attempted.

## The deletion guard, and its honest limit

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

## A warp waits for this session's own tools, agent tasks and background jobs

A warp never lands while this session still has a tool executing, running or
queued agent tasks, or a running background job — and it is never thrown away:
the request is **queued**.

- `/warp` — a typed name, the selector and a create's follow-up warp all share
  one path — reads all three sources **once, as they are**, and keeps the request
  **pending** straight away instead of switching: it never waits for them to
  drain. The session stays where it is, and a bounded background poller
  re-dispatches the SAME validated handoff once this session reports no tool
  still executing, no running or queued agent task and no running job. Nothing
  switches mid-work, and a dispatch is only ever attempted into an **idle** host:
  a poll that finds Pi still processing a run leaves the request pending and
  waits instead of starting a dispatch the host would refuse. A queued handoff
  never claims a move.
- **Queued means the end of the current turn.** A warp requested mid-run takes
  effect at the same boundary Pi uses for a queued input message: after the
  current assistant turn finishes executing its tool calls, before the next model
  call. When the run itself is the only thing still standing in the way (no tool
  executing, no running or queued agent task, no running job), the extension ends
  the run at that boundary (`ctx.abort()`, once), so the move starts by itself,
  without you stopping the agent. That abort lands the moment the turn ends,
  decided from the activity the queue already sampled, so it never cuts a
  provider request that is already streaming — and nothing is ever sent to the
  agent: no instruction, no hidden message. A turn that ends with no tool results
  is the agent's own last answer, so that boundary does nothing at all, and a
  request still waiting on real work waits for that work instead. A queued warp is
  also dispatched at the host's `agent_settled` boundary, so it starts when the
  session settles, not on the next poll.
- **Ask first, then queue.** The pending-changes question (`YES COPY` / `NO COPY`
  over the checkout you are standing in, Esc cancels the warp) is asked when the
  warp is **requested** — before the busy decision and before any work drains —
  and its answer travels in the queued handoff. So it is asked exactly once per
  request, a queued warp never asks it again when it finally runs, and a second
  warp (refused while one is pending, below) asks nothing at all. The summary,
  the question and the copy all use the checkout the session stands in, never
  the principal/main checkout, in the warp and in the `/warp` create panel's own
  question. The prompt opens on `NO COPY`, and it ignores the first few hundred
  milliseconds of keystrokes after it mounts, so a buffered or double-tapped
  Enter — the one that sent the command, or one meant for a message you were
  queueing while the agent was still running — can never answer it: only a
  keypress you make after the panel has had time to appear counts, Enter then
  confirms the highlighted answer, and Esc still cancels.
- **A copy the destination refuses never blocks the move.** If the carried
  changes cannot be copied — the destination has its own version of a file, a
  path cannot be proven identical, nothing was written — the warp still happens:
  it moves WITHOUT the copy, overwrites nothing in the destination, and says so
  in one line naming the copies it could not carry. Only a copy that actually
  landed something stops the move, because that is real state.
- **A queued warp is visible, in one brief line.** It is one dim row in the zone
  immediately above the input, in the same shape as Pi's own `Steering:` row:
  `Queued: warp <worktree> — waiting for <the work>`, naming the tools, agent
  tasks and jobs it is actually waiting for. That is the whole message, shown
  once: the row above the editor (or its one fixed fallback entry) IS the queued
  line, so nothing repeats it in the chat — no transcript copy, no caveat row and
  no editing hint — and only one warp can be queued at a time. On a
  narrow terminal the row is cut with an ellipsis instead of wrapping, it is
  repainted only when the reason changes, and it never says the session moved. It
  is removed when the queue dispatches, is refused, is cancelled, expires or the
  session shuts down. A host that cannot paint that zone gets the same one line
  as ONE fixed transcript entry instead, appended once per request — never a
  second line per poll — and only a host with no surface at all (no row and no
  entry) falls back to the one notice, so a queued request is never invisible.
- **One pending warp per session.** A second warp is refused while one is
  pending, with `a warp to <name> is already pending for this session — it runs
  when this session's tools, agent tasks and background jobs finish; wait for it
  or let it expire` — and the pending request is never replaced.
- The pending warp expires after `ODD_WORKTREE_WARP_PENDING_MS` (30 minutes by
  default, clamped to a day) and notifies that it expired with nothing moved. It
  re-reads all three sources every `ODD_WORKTREE_WARP_PENDING_POLL_MS` (2 s by
  default) and its timer never keeps the session alive. A warp that runs, is
  refused or expires clears the queue, so the next request is accepted again.
- The re-dispatched handoff re-checks that the destination checkout and the
  session are still where the request left them: drift refuses the move instead
  of guessing.

All three sources are read **best effort**, and none is ever guessed:

- **Tools executing in this session** come from the host's
  `tool_execution_start` / `tool_execution_end` pair, which fires for every tool
  of the session — its own `bash`, `read` and the rest, not only this package's
  tools. An execution with no end yet keeps the warp waiting; an end whose start
  was never seen is a no-op. Only top-level calls count: a nested call (a tool a
  tool ran) always runs inside a parent execution that is already counted, and
  so does this package's own `job_list` probe, which is why a warp never waits on
  itself. The counter is process memory with no unknown state: a host restart
  starts empty, a session shutdown clears it, and a tool that never really ends
  is bounded by the pending warp's own expiry.
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
  still runs, and the queued line never carries a caveat. The one place the
  unreadable job state is still disclosed is the expiry notice, which says
  nothing moved and names the state it could not read.

## `/issues`: three tabs, one shortcut, one filter

Opening the panel reads the three scoped buckets only — `My issues`
(`author:@me`), `Assigned` (`assignee:@me`) and `Involved`
(`involves:@me -author:@me`) — one cursor page each, open issues, newest update
first. `All` costs nothing until you ask for it, which is the point of the split:
the common case is your own issues, and reading every open issue of the
repository to paint three tabs was work nobody asked for.

- **`All` is read on first entry, then reused.** The `g` view reads its first page
  the first time you enter it and paints what it already holds on the way back, so
  moving in and out costs one read. A changed filter and a successful edit are
  what make it read again.
- **Two honest reads, and a note row that says which one is on screen.**
  Unfiltered, `All` reads the repository's issue connection: every open issue of
  the repository, paged to its end, with an exact total, and not deduplicated
  against the three scoped tabs. GitHub takes no search text on that connection, so
  a filtered `All` goes through the search path instead, which GitHub caps: its
  count wears a `+` (`n+`) rather than claiming a total it cannot know. The note
  row between the tabs and the list names the read — `via connection (exact
  total)` or `via search (total capped)` — and a save, an error, a notice or a
  read in flight outranks it there.
- **One filter, three tabs.** The search box's settled query is read by all three
  scoped tabs, not only the one on screen, and each tab's count is the FILTERED
  total. A tab that has not answered for the current filter shows `–` instead of a
  number from the previous one.
- **The filter travels into `All`, and `All`'s page does not survive it.** Entering
  `All` with a filter reads it with that filter, and editing the filter drops
  `All`'s loaded rows and total, so it can never list rows that belong to a
  previous one. Clearing the filter re-reads the three scoped tabs; `All` is read
  again when you enter it, or at once if you are in it when the query changes.
- **`/issues <number>` opens on one issue.** `/issues 42` and `/issues #42` open
  the panel on `Assigned` with #42 selected and its detail loaded. The view pages
  up to five pages of that tab looking for it, the first page counting; a number it
  does not find leaves the first row selected and says so on the note row:
  `#42 is not in Assigned`. Any other argument keeps the command's refusal,
  `Unknown option "<what you typed>". Use /issues.`, so a typo opens nothing. The
  selection is one-shot: the first key you press spends it, and a later filter,
  refresh, tab switch or page never moves the focus back to that number.

## `/issues` pins the repository

The repository identity (`<host>/<owner>/<repo>`) is pinned when the list loads,
and the host is part of it. Every page, detail, label, assignee and comment read
binds that pin, and so do every action and the `o` browser opener. If
the checkout's remote moves while the reader is open, mutations refuse with
`the checkout's repository changed since this issue list loaded (now … instead of
…); reopen /issues`, and the reads keep the displayed repository. An issue
number on screen can never be sent to another repository.

## Card style follows your shell

The worktree tool cards follow the card style chosen in Gentle Shell — the
rounded `╭ ╮ ╰ ╯` frame (`neon`) or the `▎` rail over a painted band (`float`,
the default). Content, order, truncation, the collapsed three-row preview and
the elapsed time are identical in both; only the chrome differs.

- **Live.** Gentle Shell keeps the resolved style in a process-wide slot and
  refreshes it at startup, on every `session_start` and right after its
  Customize save. The cards read it at each render, so a change reaches the next
  card with no restart and no file watcher.
- **Clicking expands that card.** A left click anywhere on a worktree card —
  `/warp`'s confirmation card and both tool cards alike — expands **that card
  only**, and the next click on it collapses it again. A click on one card never
  moves another one, and no click ever touches the session's expansion flag.
  `ctrl+o` remains the global toggle: it sets the flag on every card, so it still
  expands or collapses them all at once, and it wins over an earlier click. The
  card claims only its own drawn cells: the right button, the wheel, OSC 8 links
  and every cell outside the card stay the host's. A press inside the card belongs
  to that click (it is what makes the click reach the card at all), so start a
  drag-selection on a row outside the card.
- **Fallback.** With no shell running, the style comes from
  `<home>/card-style.json` — `{ "schema": "gentle-pi.card-style/v1", "style":
  "neon" | "float" }` — and `<home>` resolves `GENTLE_PI_CONFIG_HOME` →
  `GENTLE_SHELL_CONFIG_HOME` → `~/.pi/gentle-ai`. A missing, unreadable,
  malformed, wrong-schema or unknown-style document reads as `float`; nothing
  throws and nothing is guessed. While no host runs the document is read on every
  render, so an edit is visible on the next card — no watcher, and no cached copy
  between renders.
- **The tone is a theme role, never a colour.** A card paints the state's own
  theme role everywhere: the frame — the neon `╭ ╮ ╰ ╯` rule and the `float` `▎`
  rail alike — carries `warning` for the two worktree tools, running or settled, and
  for `/warp`'s confirmation, `error` when a call fails, and the plain `border` for
  an informational card. The CodeGraph card is the one exception: it paints its whole
  box in its own `mdCode` role, and a running call still wears `warning` and a failed
  one `error`. The heading label carries the same role, except on the
  informational card, whose label is the theme's `accent` on its plain border. A
  tool result's body is the theme's own `text` — and so is every row of `/warp`'s
  confirmation card — so a card's content never borrows the chrome's tone. The
  float band paints the tone's background role
  (`toolSuccessBg`, `toolPendingBg` for a running call, `toolErrorBg` for a
  failure). No hex value and no escape sequence is written by this package.
- **The card content level decides how much a collapsed card shows.** Gentle Shell
  publishes the level (`default` or `minimal`) and every card reads it on each paint,
  so a switch applies to the next paint. At `default` a collapsed card shows its
  heading and at most three body rows; at `minimal` it is the heading alone, closed by
  the rule that carries the elapsed time. A failure still says why at either level,
  and `ctrl+o` expands any card to everything. A host without Gentle Shell reads as
  `default`. This holds for `worktree_create`, `worktree_list`, `/warp` and the
  CodeGraph card alike.
- **A row is clipped while it is still plain, and painted after.** Text is
  wrapped, clipped to the card's inner width (with the `…` mark) and padded first;
  the role wraps that result and nothing this package painted is measured again.
  The one painted string the cards do measure is the host's own dim key hint, and
  only with the host's ANSI-aware width. So the row is the same whatever measures
  it: the `/warp` card's own fallback, which counts escape characters as columns,
  clips the same text as the host's ANSI-aware helpers instead of cutting into a
  sequence and losing characters — and follows the host's own truncation rule, so
  a row one column wide shows `…` rather than its first character.
- **The elapsed time is measured, never a clock read at paint time.** Both tool
  cards and `/warp`'s confirmation carry their real duration on the closing rule,
  bottom-right, in the same form (`61ms`, `1.2s`). For `/warp` that span runs from
  the moment the request was accepted — the moment it was queued, for a handoff
  that waited — to the last instant this session's code runs before the host
  returns from `switchSession`: the host applies the new session, awaits the
  callback that hands over the card, and only then returns, so the final hand-off
  and the return itself are not in the number (the label ends at the hand-off, not
  at the switch's return). A queued warp still counts its wait, and nothing is
  re-measured when the card is drawn. A card with no measured
  span shows no time at all: the queued announcement, a warp that sent no card
  (already there, refused, cancelled, an empty session) and a card replayed from
  a session written before this measurement. Never a stand-in `0ms`, never a
  placeholder clock.
- **Never a broken card.** A terminal narrower than ten columns, or a theme that
  cannot paint the background role, draws the `neon` outline instead of a
  half-drawn float card.

## The bash card, and its toggle

`/card:bash` is this package's fourth command and its one preference. With no
argument it flips between the two ways a `bash` tool call can be drawn — `own`,
this package's activity card, which is the default, and `default`, the host's own
drawing — reports the state in one line (`bash cards: own (activity)` or
`bash cards: gentle default`) and remembers it. An argument is refused with
`Unknown option "<what you typed>". Use /card:bash with no argument to flip the
bash card.`, so a mistyped option never flips the mode by surprise.

The choice lives in `<home>/card-bash.json`, and that document is strict: exactly
two keys, this package's schema string and one of the two modes.

```json
{ "schema": "gentle-pi.card-bash/v1", "mode": "own" }
```

- `<home>` is the one `card-style.json` resolves: `GENTLE_PI_CONFIG_HOME` →
  `GENTLE_SHELL_CONFIG_HOME` → `~/.pi/gentle-ai`.
- **The mode is read live.** The process-wide slot the toggle sets answers first,
  then the document read fresh on every call, then `own`; there is no cache, so
  no paint can answer with a mode the file no longer states. A missing,
  unreadable, malformed or wrong-schema document reads as `own`, and the reader
  reports which of those it was.
- **The write is atomic and owner-only.** A temporary file beside the document is
  written with `0o600` bits and renamed into place, so a reader sees the old
  document or the new one and never half of either. The document goes first and
  the live slot second, so a failure leaves both on the old mode and there is
  nothing to roll back.
- **A document this package cannot parse is never overwritten.** The toggle
  reports `bash cards: could not save <file> (the existing file is malformed);
  still own (activity)` and the state does not move.

**The heading names the activity, never a guess.** `lib/bash-activity.js` reads
the command alone and answers one family or nothing; `lib/bash-card.js` dresses
that answer and restates no family of its own, so a family added to the classifier
is drawn with no second table to keep in step.

| Mark | Heading | The commands it names |
| --- | --- | --- |
| `⚠` | destructive | A segment that deletes something irreversible: `rm`, `shred`, `truncate`, `dd` to a file or a device, `git reset --hard` / `clean -f` / a path checkout, a `docker` or `kubectl` removal or prune, a shell body or `eval` that does one, and the SQL a pipe or a heredoc feeds `psql`, `mysql`, `mariadb` or `sqlite3`. |
| `✓` | checking | The verification runners: `pnpm test`, `node --test`, `vitest`, `pytest`, `go test`, `cargo check`, `tsc`, `eslint`; a formatter told to report (`black --check`, `gofmt -l`); a listed `make` recipe or package-manager script; and a check behind `timeout`. |
| `≋` | formatting | A formatter or lint fixer that rewrites what it reads: `prettier --write`, `black`, `cargo fmt`, `go fmt`, `gofmt -w`, `ruff check --fix`, `deno fmt`. |
| `⚒ ` | preparing | Installing, scaffolding and storing configuration: `pnpm install`, `pip install`, `uv sync`, `brew install`, `cargo install`, `git init` / `clone`, `mkdir` / `touch` / `cp` / `ln`, `git config <key> <value>`, `pnpm config set`. |
| `↑` | publishing | Remote writes: `git push`, and the `gh` verbs that create, edit, close, merge or review a pull request, issue, label, release, repository or stack. |
| `⎇` | versioning | Local history: `git add`, `commit` (and `--amend`), `rebase`, `cherry-pick`, and a stack's local `gh stack init` / `add`. |
| `󰆼` | codegraph | A `codegraph …` command in the command position, read exactly as the CodeGraph card reads it. |
| `⌕` | exploring | Read-only inspection: `git status` / `log` / `diff` / `show`, `ls`, `cat`, `grep`, `head`, `find`, `gh pr view`, and `--help` on any program the classifier knows. |

Preparing's mark carries one trailing space of its own: U+2692 is painted two
cells wide by an emoji-fallback font while the host counts it as one, so the
heading's counted width matches what the terminal paints.

Among the segments of one command a deletion wins first, then CodeGraph: a call that
runs the program is its card whatever else it does, because the card's detail is the
command itself. Among the rest the strongest wins: a check, a remote write, a history
change, a rewrite, a build-up, and plain inspection last.

**The generic `$ bash` heading is what declining looks like.** A command no family
names keeps the shell tool's own mark, word and theme role — never a family's mark
with a generic word, because a reader must be able to tell a named activity from a
declined one at a glance. It declines rather than half-naming when any single
segment carries no reliable signal: an unknown program, a chain that mixes
`pnpm test` with `./scripts/deploy.sh`, a command hidden in a substitution the
segmenter does not follow (a backtick or `<(`), a redirect that puts the output in
a file, a family whose own flags say it is not the thing it looks like, or a
deletion it cannot prove. `lib/bash-destructive.js` is evidence, not a verdict: a
deletion whose evidence is not provable is not called destructive, and a help
request, a dry run or a recovery keeps the identity the call really has. Its
header states the rule the package keeps: no permission, guard or execution
decision may read it, because "would a reader want to see what this deletes?" is
a different question from "may this run?".

**Collapsed**, the card is one heading row with the command as its detail:

- A leading `cd X &&` chain is folded, because it is setup rather than the work;
  lines beyond the first are stated as `… +N lines` instead of swallowing the
  card; and a command still too wide for the rule ends in `…`. Expanding the call
  draws the complete command, so nothing is lost behind the ellipsis.
- The body is what the command printed, plus nothing else: no label, no summary
  and no invented line. Collapsed it is the last three rows — the end of an output
  is where a summary, a count or a failure is written — painted in the theme's
  `toolOutput` role, or in the `error` role when the call failed. An output with
  no text draws no body row at all.
- A call still running says `running…` in the muted role, is painted in the
  warning tone and closes its own frame; the result that follows closes it in the
  info tone (or the error tone) and carries the elapsed time bottom-right on the
  closing rule, in the form the other cards use (`61ms`, `1.2s`). A streamed
  result draws its rows and no closing rule: the rule and its time belong to the
  final one.

**Expanded**, the card draws the whole command on the rows below the heading and
the whole output, row for row. Expansion is the host's own: the card offers the
host's expand key hint on a settled call, and the host's `expanded` flag
(`ctrl+o`) decides what is drawn.

**The toggle repaints what is on screen.** The mode is read twice. When a row is
created the resolver asks it, so a row created while the mode was `default` is the
host's own row and stays the host's for its lifetime — its shell must never become
ours. And a card already on screen reads it again on every paint: the card builds
its rows inside the component's `render(width)`, which the host calls on every
frame, so flipping `/card:bash` repaints the bash rows this card drew. There is no
repaint hook to ask `ctx.ui` for, and the toggle does not pretend to have one: it
writes the mode, and the next frame decides.

**Composition with the CodeGraph card is load order.** `own` means every bash call
is ours, a `codegraph …` command included, and the CodeGraph card is registered
BEFORE this one, on purpose. With the `codegraph` CLI installed that card receives
these slots as the chain's `next()`, reads `codegraph …` as its own and claims the
row with its richer body, so this card's slots are never asked; without the CLI no
CodeGraph card is registered at all (invariant 19), so the same command is drawn
here with the `codegraph` identity. The two readers agree on which commands those
are (`lib/codegraph-card-preview.js` and `lib/bash-activity.js`; a test states
it), so no row falls between them, and there is no second copy of the rule to keep
in step. Both cards declare `renderShell: "self"`, so the host never draws its own
filled box under either of them.

**What this is not.**

- It only draws. The resolver chooses renderers for the `bash` tool and hands
  every other row back exactly as the chain resolved it; nothing is registered,
  spawned, guarded, intercepted or shadowed, and the command runs exactly as it
  would have.
- A host without the tool-renderer hook, or without a usable measurement seam,
  keeps drawing its own bash rows: the card is cosmetic and announces nothing.
- The gentle-shell reference's per-row reveal meter is dropped, not deferred: a
  collapsed card already states whether its input was folded (`…` on the row and a
  `… +N lines` suffix), so a measurement deciding whether to OFFER the expand key
  answers a question the drawing already answers. Its `activity|output` sub-modes are
  not ported either. The toggle here is ours-versus-the-host's, and the body is the
  output.
- A collapsed body states the last three output lines and does **not** announce the
  cut, so a two-line output and a two-hundred-line one draw the same body. Expansion
  is how a reader sees the rest; the count was left out on purpose, because the four
  limits above are about what the card refuses to claim and this one is about what it
  declines to add.
- `default` is a drawing preference, not a guard: it never makes anything run or
  stop running.

## The list

`worktree_list` prints the main checkout first and unnumbered, then one numbered
row per checkout this package created under `<repo-name>-worktrees`, by name.
A row is its directory's basename — which IS the ODD — and the branch Git
reports. With `all: true`, the worktrees Git knows outside that directory follow,
and a footer counts them while they are hidden. The text is fixed-field and
undecorated, so it reads the same on every run:

```text
project: repo
path: /code/repo
main: main 1a2b3c4
1 worktree-tools feat/worktree-tools
2 billing feat/billing
```

There is no `odd:` field, no date, no setup line, no hooks line and no stored
state: the name already says which ODD a checkout serves, and the path already
says whether it is one of ours. A directory that exists and is a worktree is
listed; one that does not exist, or that Git no longer knows, is simply not
listed. Nothing is reported as `gone` or `missing`, because nothing was stored
to go stale.

The listing is **read-only**: it reads Git's own worktree set, writes nothing and
prunes nothing.

## Where state lives

Nowhere for worktrees. A create always lands at
`<repo-parent>/<repo-name>-worktrees/<odd>`, so the directory is the record: the
list, `/warp` and the deletion guard all derive what exists from Git's listing
and that one path rule. There is no `<git-common-dir>/pi-worktrees.json`, no
lock file and no second document in its place, so two versions of this package
can never disagree about a stored row.

Session names derived from an ODD write, and the warp's fork/resume bookkeeping,
travel in the Pi session files the host already owns. The setup logs live under
the system temp directory (`odd-worktree-setup-*`), one directory per create.

One document holds a preference rather than worktrees: `<home>/card-bash.json`,
the bash card mode `/card:bash` flips. Its format, reader and writer are in [the
bash card, and its toggle](#the-bash-card-and-its-toggle). Nothing else in user
configuration is written by this package, except — with the `codegraph` CLI
installed — the one `codegraph` entry of `<agent dir>/mcp.json` (see [CodeGraph:
index, daemon and MCP entry](#codegraph-index-daemon-and-mcp-entry)); Gentle
Shell's own `card-style.json` is read here, never written.

## The `bash` guards

The extension watches every `bash` tool call and refuses four things before the command
runs. The refusal is the call's result: it says the command did not run and names the
order to follow, `worktree_list` first and `worktree_create` only when the ODD has no
checkout. The prompt block above is what is meant to keep the agent from ever reaching
them.

| Refused | Where |
| --- | --- |
| `git worktree add` | any cwd |
| `git worktree list` | any cwd |
| a command that creates a branch (`checkout -b/-B/--orphan`, `switch -c/-C`, `git branch <name>`) | the principal checkout only |
| a command that switches to anything but the repository's default branch (`checkout`/`switch <ref>`, `-`, a detached checkout) | the principal checkout only |

- **Text only.** The guard reads the command string and nothing else: it finds the
  `git` … `worktree` … `add|list` sequence anywhere in it, also after `&&`, `||`, `;`,
  `|`, a newline, a subshell, a line continuation, inside `$(…)` or inside a quoted
  `bash -c '…'`, and tolerates git's global options (`-C <dir>`, `--no-pager`) and a
  `git` given by path. It never opens a script, an alias or a file, so a script that
  runs `git worktree add` inside passes. A string that only prints the sequence
  (`echo git worktree add`) is refused too: what surrounds it never matters.
- **Principal checkout.** A linked worktree shares the principal's git common dir, so
  its root is never that dir's parent and the branch guards do nothing there. A cwd that
  is not a repository, or an identity that cannot be read, blocks nothing.
- **Default branch.** Resolved like the create's base: the local `main`, else the branch
  `origin/HEAD` names, else `init.defaultBranch`, once per checkout. There is no
  `main`/`master` list, and with no resolvable default a switch is not refused.
- **`checkout <ref>`.** `git switch` never takes a path, so its argument is a ref. For
  `git checkout`, an argument is a restore only when that path exists in the cwd, which
  is how Git settles the ambiguity; `feat/x`, `origin/main` and a bare `develop` are refs.
  `git checkout <ref> -- <path>` and `git checkout -- <path>` are always restores. Every
  segment of a compound command counts, so an allowed switch never hides a later one.
- **Everything else passes**: `git status`, `git branch` alone or with an option,
  `git restore`, `git worktree remove|prune|move`, and every tool but `bash`.
- `ODD_WORKTREE_GUARD=0` turns them off for the process, like `ODD_WORKTREE_PROMPT=0`
  for the prompt blocks. No other value does, and nothing else configures them.

## The `## ODD worktrees` block in the system prompt

The primary session's system prompt gains a short section telling the agent where
a worktree lives and that the directory is the ODD it serves, to call
`worktree_list` before it creates a worktree or starts or resumes an ODD (work in the
ODD's worktree when it has one, `worktree_create` it when it has none), to carry the
current checkout's pending changes that belong to that work with `copy_changes`, that an
ODD is an area of work with one worktree, to delegate agents in parallel unless they
would edit the same files, and that after the merge the branch is kept and the checkout
removed unless a live session stands in it. Moving the session stays the human's.

It is **appended**, never substituted: the block rides
`systemPromptOptions.appendSystemPrompt`, so whatever Gentle Shell (or any other
extension) put there is preserved verbatim and our text lands after it. There is
one text, read from `lib/odd-prompt/odd-worktrees.md` at load. Child and
named-agent sessions get nothing, because their own instructions are already the
bounded task they received. `ODD_WORKTREE_PROMPT=0` suppresses the block.

One limit, stated plainly: a string has no "must be last" flag, so the block's
position follows extension load order. It can sit before a later extension's
short hint; it can never land inside or in place of another extension's text.

## The `## CodeGraph` block in the system prompt

A session that already holds a CodeGraph tool (the native `codegraph` tool or
`mcp__codegraph__codegraph_explore`) gets a short section on how to use it: call
the graph before searching or reading code, treat its answer as a map and not as
proof, and keep the other tools for what it does not index. Each role gets its
own text, read from `lib/codegraph-prompt/<role>.md`: the primary session the
orchestrator's, a gentle-shell child (explore, verify, worker, fix, judges) its
own, chosen from the agent name in the child's own command line, and any other
child a generic one. A `review-*` agent and a session without a CodeGraph tool get
nothing.

It is appended the same way as the worktrees block, after whatever the host put
there, and skipped when its heading is already present. The prompt section only
advises and runs nothing; what the package does with CodeGraph itself is in
[CodeGraph: index, daemon and MCP entry](#codegraph-index-daemon-and-mcp-entry).
`ODD_WORKTREE_PROMPT=0` suppresses both blocks.

## The two CodeGraph reminders

A session that already holds a CodeGraph tool also gets two short reminders, appended as one extra
text part to the result of a finished tool call. They are advice in the same words the prompt block
uses: they never block a call, never replace a result, never arrive as a separate message, and add no
tool or command. Both are gated exactly like the prompt block — only with the `codegraph` CLI installed
and only when the session already holds a CodeGraph tool. They cite the CodeGraph rule, so
`ODD_WORKTREE_PROMPT=0` silences them together with it.

They cover `grep`, `find`, `ls`, `read` and `bash`, because those are the calls the rule asks the agent
to replace with a `codegraph` `query` or an `explore`. `read` counts only for code: `.md`, `.json`,
`.yml`, `.yaml`, `.toml` and `.txt` are the docs and configs the rule exempts. `bash` counts only when
the command searches or reads (a `grep`, `rg`, `find`, `fd`, `ls`, `cat`, `sed`, `head`, `tail`, `awk`
or `tree` segment); a command that merely mentions a checkout — `git -C`, `curl`, `echo` — is not a
search. A verb right after a single pipe only filters the output of the command before it, so
`curl … | head` and `ps aux | grep node` are not searches, while `cat src/a.ts | head` still is: the
`cat` is the read.

**Guard 1, another checkout.** The primary session, once per other checkout per session:

```text
This call went to <path>, another checkout. Follow the CodeGraph rule: call `mcp__codegraph__codegraph_explore` with `projectPath` set to <path> first.
```

`<path>` is the checkout's real git toplevel, so the reminder names the path the MCP call takes. It
fires for the same project's other worktree and for another repository alike, and never in a subagent
child. It stays silent, using up no slot, for a checkout this session already explored with
`projectPath` since the last compaction.

**Guard 2, the session's own checkout.** The primary session and every child except the `review-*`
agents, once per the checkout the session is in:

```text
Follow the CodeGraph rule: run `codegraph` `query` or `explore` first, if it applies.
```

for the primary session and the explore agent (the native wording only when that role holds the
native tool), and

```text
Follow the CodeGraph rule: call `mcp__codegraph__codegraph_explore` first, if it applies.
```

for every other role. It is keyed by the checkout, so a `/warp` re-arms it, and it stays silent once
the session used `codegraph` or the MCP tool.

**What is "another checkout".** A different git toplevel (`git -C <dir> rev-parse --show-toplevel`),
read once per directory and cached for the session. It comes from a tool's own path, or from a `cd`
target or an absolute path argument of a shell command. A path outside every git checkout (tmp, `/etc`,
your home) triggers nothing.

**What forgets a reminder.** A compaction forgets both guards and what the session already used, and so
does a new session in the same process (a new, resumed or forked session; a `/reload` keeps the current
one). A reminder that does not fire uses up no slot.

## CodeGraph: index, daemon and MCP entry

Everything here applies **only when the `codegraph` CLI is installed**. The CLI is probed
once per process, so installing it after a session started needs a restart. Without it the
package registers nothing for CodeGraph. Everything runs in the background behind bounded
children, and none of it can fail or wait for the host.

| When | What happens |
| --- | --- |
| Session start (new, resume, fork; not `/reload`, not a subagent child) | The global MCP entry is ensured once per process. Then the checkout's index is created (`init`) or synced, and its daemon is warmed. A linked worktree without an index is seeded from the main checkout's index and synced once; it never shares it. |
| A subagent child in its own linked worktree | The same seed or init for that worktree; any other child leaves the parent's index alone. |
| After a compaction | One background sync of an existing index, never an `init`. |
| After a successful native `codegraph init` | One coordinated sync, and its honest outcome appended to the tool's result. A failed init keeps its error and starts no sync. |
| After a successful `edit` or `write` | A debounced sync of the checkout of the edited file (its git toplevel), unless a live daemon already watches that checkout. |

**Coordination.** Every index write goes through one init lock and one per-project sync lease,
so two sessions never write the same index together. A request that cannot run now is
recorded and served later; a queued, coalesced or failed run is never reported as synced.

**Read-only roles.** Verify and the judges (a command tool and no file-writing tool) never
start an index write.

**The MCP entry.** In a primary session, once per process, the package makes sure
`mcpServers.codegraph` of `<agent dir>/mcp.json` (`~/.pi/agent` unless `PI_CODING_AGENT_DIR`
names another) has these fields:

```json
{
  "command": "codegraph",
  "args": ["serve", "--mcp"],
  "toolExposure": { "codegraph_explore": "direct" }
}
```

It adds the entry when it is missing, fixes only the fields that differ, and keeps every
other server and field. The file is rewritten only when something changed, atomically and
with its permission bits; the formatting is not preserved beyond its indentation. An
invalid file is left untouched and reported. After a change Pi must be reloaded for the MCP
tool to appear. A project-level MCP file is never edited.

**Daemon.** The daemon is resolved per checkout from CodeGraph's own registry
(`~/.codegraph/daemons`), a live one is reused before warming one through `codegraph serve
--mcp`, and a registered MCP entry is never taken as proof that a daemon is reachable. The
package never stops a daemon it did not start.

## The CodeGraph card

With the CLI installed the package also draws CodeGraph's tool rows as a card on the same card
substrate as the worktree tools: the native `codegraph` tool, the MCP `codegraph_explore` tool
(bare or `mcp__codegraph__codegraph_explore`) and a `bash` call that runs CodeGraph: any
command in which `codegraph` is the command word of some segment, with or without a launcher
such as `npx` or `pnpm exec`, in any pipeline or `;`/`&&` sequence. A command that only
mentions it (`echo codegraph init`, `cat codegraph.json`, `grep -r codegraph src`) stays the
host's own `bash` row. A `bash` card shows the command itself as its detail, on one line
collapsed and whole when expanded, with no operation label. It is registered through the host's tool-renderer hook, adds no tool or command, and
hands every other tool back exactly as the host resolved it; a `bash` command that is not
CodeGraph's is forwarded to the host's own renderer. A host without that hook draws nothing of
ours. Every card in this package, the two worktree tools and the CodeGraph rows alike, declares `renderShell: "self"`: it frames itself in float or neon, and the host's own filled box is never drawn under it. The collapsed card is one factual row per operation (an init, a sync, a query or explore
count); `ctrl+o` expands it to the whole output, and the Gentle Shell card content level
(`minimal`) hides the result body while a failure still says why. A `codegraph …`
`bash` call is that card's only while the CLI is installed; without it [the bash
card](#the-bash-card-and-its-toggle) draws the same command with the classifier's
`codegraph` identity.

## Deliberately absent

This package is the worktree / ODD / issues surface only: two agent tools, three
panels and the one bash-card preference, no customize panel, no plugin-tools
toggles, no CodeGraph command or tool (only the prompt advice above), no
companion-app integration, and no worktree↔issue association. There is nothing to
configure beyond `/card:bash`, and `/warp`, `/odd-list` and `/issues` are always
on. Paths, branches and arguments reach `git` and `gh` as fixed argv arrays,
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
[`AGENTS.md`](../AGENTS.md).
