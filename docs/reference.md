# Reference

Detail behind the [README](../README.md): how each surface behaves, its keys, its limits and
how the package is tested and released. The repository invariants live in
[`codebase/invariants.md`](codebase/invariants.md).

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

`/files` — one option per key. The scope step, when it appears, is `↑`/`↓`,
`enter` and `esc`.

| Key | Action |
| --- | --- |
| `↑`/`↓` | Move the selection |
| `tab` | Select or unselect the highlighted file |
| `ctrl+j`/`ctrl+k` | Scroll the preview one line |
| `ctrl+o` | Cycle the order: `modified`, `path`, `ext` |
| `space` | Fold or unfold the focused group |
| `ctrl+u` | Clear the query |
| `ctrl+e` | Open the highlighted file in `$VISUAL`/`$EDITOR` |
| `enter` | Insert the selected files plus the highlighted one, and close |
| `esc`, `ctrl+c` | Close the panel |

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
| `o` | Open the issue in the browser through `gh issue view <n> --web -R` | a loaded issue |
| `r` | Re-read the list and the preview freshly, and re-read your repository role | — |
| `l` | Labels editor: apply or remove an existing label | triage and a loaded issue |
| `a` | Assignee editor | triage and a loaded issue |
| `c` | Comment | read access and a loaded issue |
| `x` (and `X`) | Close the issue, after the host's confirmation; only `x` rides the legend | triage and a loaded issue |
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

**The footer offers only what works now.** The five tokens that act on the
selected issue — `l labels`, `a assign`, `c comment`, `x close`, `o web` — are
painted only while an issue is focused AND loaded: an empty bucket, a read still
in flight and a failed read all drop them, and the three repository actions keep
their literal-`true` capability gate on top. Movement, the bucket switch, `t
search`, `g all issues` and `esc close` stay on the row either way, so a token on
it is always an action you can take at that moment. The keys keep their own
guards, so a hint that has left the row can never fire an action.

**A sub-mode's keys replace the legend.** While the labels, assignees or comment
editor holds the keyboard, the same footer row — same place, same left-to-right
shape — carries that editor's keys instead of the reading legend: `space toggle ·
n new · ctrl+s apply · esc back` for labels (`n new` only with `write`), `space
toggle · ctrl+s apply · esc back` for assignees, and `enter newline · ctrl+s post
· esc discard` for a comment. The editor's title is its name alone (`Labels`,
`Assignees`, `Leave a comment…`), so the keys are never in two places. Leaving
the sub-mode — apply, `esc back` or `esc discard` — restores the reading legend.
The search box keeps its own footer row, unchanged.

The two nested sub-modes follow the same rule: naming a new label carries `enter
add · esc cancel` on that row and the comment-discard ask carries `y discard ·
n/esc keep editing`, while their body says only what is happening (`new: …`,
`Discard this draft?`). While the labels or assignees list is still being read,
the handlers accept the exit and nothing else, so the footer offers `esc back`
alone; the editor's own keys arrive with the list.

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
first. When the `ISSUES` rail section has already read this checkout's repository,
the first frame is painted from that cache instead and ONE tab is read at mount —
the other two read the first time you open them; [the rail
section](#the-issues-rail-section) describes the cache and what it changes. `All`
costs nothing until you ask for it, which is the point of the split:
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
- **`/issues <number>` opens on one issue, loaded.** `/issues 42` and
  `/issues #42` open the panel on the tab the rail's cache says holds #42 —
  `Assigned` when it is there (an issue that is both yours and assigned opens on
  `Assigned`), `My issues` when it is only there, and `Assigned` when the cache is
  cold or unknown — with #42 selected and its detail read. The view pages up to
  five pages of that tab looking for it, the first page counting; when it is not
  there it looks ONCE in the other of those two tabs (`assigned`/`mine`) before it
  gives up, and only then leaves the first row of the requested tab selected and
  says so on the note row: `#42 is not in Assigned`. The first frame carries the
  facts the rail already knew — number, title, state, labels, assignees, author —
  with the read named below them, so the body following behind never begins as a
  bare `loading…` pane. Any other argument keeps the command's refusal,
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

## The `ISSUES` rail section

When Gentle Shell draws its rail, a section titled `ISSUES` lists this checkout's
open issues that you AUTHORED (`author:@me`) or are ASSIGNED (`assignee:@me`),
merged into one list: deduplicated by issue number (an issue that is both keeps
the `assigned` row, since that is the tab its click opens), sorted by last update,
seven drawn, and when the read answered with more, an eighth and last dim row
reads `and N more issues` (`N+` when either contributing search was truncated at
its cap, because the real total is larger). The section's own meta reports what it
holds as the bare count — `8`, never `8 assigned` — and `8 · stale` while the rows
on screen are the last good ones.

- **One request per refresh.** A refresh is a single `gh api graphql` request with
  three aliased searches — `author:@me`, `assignee:@me` and
  `involves:@me -author:@me`, each open and each sorted by last update — and each
  answers its own `issueCount` and rows. The section draws the merged `mine` +
  `assigned` pair (the `involved` search is only cached, below), and `/issues`
  paints its first frame from that cache.
- **A row is an issue, and its one mark is a pull-request number.** It reads
  `#<number> <title>`, and when one of the issue's cross-reference events is a
  pull request (the read inspects the first ten of them) its right-hand mark is the
  FIRST such pull request's number, `#69`, painted in the bridge's own `muted`
  right-hand column — gray for that segment only, never the whole row. No pull
  request, no mark; nowhere does the rail print an icon. That number arrives in the
  same combined request as the rows, so a failed read takes the rows and their
  marks together and lands in the stale state below. The line keeps ONE click
  target — the issue — because a bridge row carries one `onClick` and has no
  per-segment handler, so clicking the number opens the issue too.
- **A row click opens the panel; the overflow row opens it with no number.**
  Clicking an issue row sends `/issues <n>` to the host at once, so the panel opens
  with that issue selected and its detail read — not in a browser. `/issues`' own
  `o` key is still the browser open,
  `gh issue view <n> --web -R <host>/<owner>/<repo>`. The click does NOT prove the
  repository: the panel pins and proves it itself when it opens, exactly like a
  typed `/issues <n>`, so a row retained across a checkout change still dispatches
  its number and the panel decides what it opens. What the click still refuses is a
  host that cannot dispatch at all, and that refusal is VISIBLE: one transcript
  entry through the host's `appendEntry` seam, or the host's notice seam when it
  has no entries — never only a field on the snapshot. The `and N more issues` row
  names no issue, so it sends plain `/issues`. Both are deferred off the paint
  path, run once per click, and a failure never escapes into the rail; a dispatch
  reports that the command was sent, never that a panel opened.
- **It reaches the host only through gentle-shell-bridge.** The section is read
  from that package's published sidebar-section API — the object in the
  `Symbol.for("gentle-shell-bridge/api/v1")` slot, after its schema and version gate
  — or from the one `gentle-shell-bridge:ready` announcement when the bridge
  publishes later. There is no dependency on that package and no import of it. With
  no bridge the section never appears at all: nothing is registered and no other
  surface changes. The one thing you are told is how to get it — a single warning
  per process, from a primary session only, naming
  `pi install npm:gentle-shell-bridge`; an empty slot at `session_start` may still
  be a bridge that has not loaded yet, so the warning waits out the announcement
  window, and a host with no event bus to announce on is told at once. A host that
  has the bridge but draws no rail registers the section and never paints it — that
  is the bridge's answer to a host without a sidebar, not a failure here. Its
  `/gentle:customize` → `Sections` visibility toggle belongs to the bridge, so a
  host without the bridge has neither the section nor the toggle. The section
  declares no preview of its own: every `Sections` row draws the host's single
  shared list of active sections — `[changes] [rdd] [agents] [todo] [usageCost] …` —
  and the bridge appends this section's `rowLabel` (`issues`) to it while the
  section is shown, leaving it out of a `hidden` row's hypothetical. There is
  nothing to opt into, and `registerSection` has no `preview` field.
- **A frame never waits on `gh`.** The host calls `lines()` and `meta()` once per
  frame and both return synchronously: they read one in-memory snapshot and only
  ever schedule the refresh. Nothing is read at `session_start`; a snapshot older
  than 60 s schedules exactly one deferred refresh, and only a drawn body frame
  schedules it at all — the header call never does. Each turn of yours
  (`before_agent_start`, then `turn_end`) asks for a read behind a 30 s floor
  measured on the last ATTEMPT: a failed read starts the floor too, so a `gh`
  that keeps failing is not retried every turn, and the in-frame TTL counts from
  the attempt rather than from the last success. It asks only while the section
  was drawn within the last two minutes — because a frame only exists when the
  host has a reason to produce one — so while frames keep coming and reads keep
  succeeding the rail does not stay stale. A hidden section draws nothing, so
  nothing stamps it afresh and it starts no timer of its own: once the two-minute
  window lapses it makes no call at all, while a collapsed section is still drawn
  — its header is painted, and that stamps the frame — so the activity read
  applies to it too. There is no polling and no repeating timer; the one
  deferral is a task scheduled off the paint path. `session_shutdown` and a session
  that starts in another checkout drop the snapshot, so the rail falls back to
  `loading…` instead of the previous checkout's rows; a read still in flight at
  that boundary paints nothing and writes nothing to the cache, and a refresh
  still queued dies with the generation it was queued under instead of reading
  with no context. A `/reload` fires no `session_start`; the section re-learns its
  session on the next turn, so it keeps reading the checkout the session runs in
  and not the host process's own directory.
- **A failed refresh keeps the rows.** Once a list is on screen, a refresh that
  fails does not replace it: the same rows, in the same order, with the same
  marks, stay where they are and the header reads `<n> · stale` instead. A transient `gh` stall is therefore a stale list, not an empty one, and
  the next successful read clears the mark.
- **Every state is a row, none is a throw.** `loading…` (dim) before the first
  answer, `no open issues` (dim) for an empty result, and one error row naming the
  failure — but only while there is nothing to show; after that, a failure is the
  stale state above. The error row covers a failed `gh` read and a checkout whose
  own repository cannot be resolved; the resolution fails closed, exactly as
  `/issues` reads it, and no `gh` call is made without a proven identity. A cwd
  that is not inside a repository is not that error: the section's one line is
  exactly `not a git repository`, in the `dim` gray role and with no path, while
  `/warp` and `/issues` keep their own, fuller sentence. A failing
  click is recorded instead of thrown, and it never turns the list into an error
  row.
- **One cache, in memory, per repository.** The three scoped views live in one
  in-process cache keyed by the repository identity the read was proven against;
  nothing is ever written to disk and a session shutdown clears it, so a session
  that moves between checkouts never shows one repository's rows under another's
  name. The first read takes up to 100 per view, later reads the newest 20, merged
  by issue number. A merge cannot see an issue that was closed or unassigned, so
  each view is held to one invariant: after a merge its cached count must equal the
  `issueCount` the same answer reported, and a mismatch makes the NEXT read a full
  one; so does an entry whose last FULL read is older than ten minutes, since a
  delta renews only the sync time and never that bound. A view with more than 100 issues is
  reported truncated — that is the `N+` in the overflow row — instead of being
  looped over, and a failed read leaves the cache untouched. Clearing it is durable:
  a read in flight when the session shuts down cannot repopulate it, and an answer
  older than one already applied is ignored rather than written over it.
- **`/issues` opens from this cache, and owns none of it.** When the rail has
  filled an entry for the repository the panel itself proves, `/issues` paints its
  first frame from it and reads ONE tab at mount instead of three: the tab on
  screen is read at mount, the other two are seeded and read the first time you
  open them, and every answer replaces the rows it seeded. With no entry for that
  repository the open is exactly the one it always was: three scoped reads at
  mount. The panel is a reader only — the rail keeps the entry's ownership (its
  read, its merge, the count invariant above, its clear at shutdown), and nothing
  the panel does adds, shrinks or rewrites it. `All` is never seeded: the cache
  holds the three scoped views only, so that view still costs its own read the
  first time you enter it. A seeded row is not an answer: it carries the query it
  actually answered (the empty one), so typing a filter stops painting it and its
  count becomes `–` until the filtered read answers, exactly as a freshly loaded
  page behaves. And a numbered open that has not yet proven its number refuses
  every one-row action — labels, assignees, comment, close and the browser — with a
  line naming the number, keeping your draft, so a click can never act on a row
  other than the one you asked for while the page is still loading. An entry the
  rail calls inconsistent, and a view it
  reports truncated, are seeded inexact — the tab's count wears a `+` — because a
  total derived from rows the rail itself does not trust is a number it refuses to
  report.
- **The scope is this checkout's repository, and nothing else moves.** It is the one
  repository the `/issues` reader is pinned to, not every issue across every
  repository you touch. `/issues` keeps its own four tabs, its own repository pin
  and its own reads; the only thing it takes from the section is the cache entry
  above, which it reads and never changes, so the section neither grows a second
  reader nor hands its state over.
- **What it needs.** `gh`, authenticated (`gh auth login`); a checkout whose own
  repository can be proven — a failed proof is the error row and makes no `gh`
  call; and a Gentle Shell whose `gentle-shell-bridge` published its API and draws
  a rail.

## `/files`: the picker, its scopes and its orders

`/files` browses one checkout's files: the list on the left, a live preview on
the right, and a search row that is always active directly under the title.
Typing filters immediately — there is no mode to enter and no "type to search"
hint — so navigation and scrolling use modifier combinations, and a query that
matches nothing paints `No files match "<query>"`. The list is Git's own
(`git ls-files --cached --others --exclude-standard`), so tracked files and
untracked-but-not-ignored files appear and `.gitignore` is respected. A file
changed in the working tree sorts above the unchanged ones, wears this package's
own badge — `M` for a tracked file with an uncommitted change, `U` for an
untracked one — and its age in `s`/`h`/`d` at the right; the ages are computed
when the panel opens and never refreshed live.

**A scope step, only when there is a choice.** When this clone has more than its
principal checkout, `/files` first asks which one to browse: `main` first, then
every other checkout this package created, most recently modified first, each row
reading `<odd> · <branch>` and its `±n files` (`±1 file`). Above that card's
footer sits the focused scope's detail line: the last commit subject, then
`±n files`, the age of the last modification, and `↑n main` / `↓n main` — the
`main` row compares with `origin/main`, every other checkout with the local
`main` — and a field that is zero or absent is not painted at all. With no other
checkout the step never appears and the picker opens on the principal checkout.

**One option per key.** The footer names one binding per action even when several
work, and both keys stay live. The compatibility bindings it never names all
work: `home`/`end` (first and last file), `ctrl+home`/`ctrl+end` (the preview's
first and last line), `ctrl+shift+j`/`ctrl+shift+k` and `ctrl+c`.

**The three orders.** `ctrl+o` cycles `modified` (the default: one flat list,
most recently modified first), `path` (an IDE-style folder tree — inside a folder
its subfolders come first and then its own files, so at the top level every
folder group paints before the files at the repository root) and `ext` (one group
per extension named with its dot, alphabetical by path inside, the extensionless
group last). The active order is painted at the right of the footer. `path` and
`ext` are foldable: groups start expanded, the fold state is kept per order while
the panel is open, `space` toggles the focused group and `enter` on a group does
the same while `enter` on a file still inserts. A non-empty query forces every
group open, and the fold keys do nothing until it is cleared. In `modified` and
`ext` a file row paints its parent directory at the right; in `path` it does not,
because the tree already places the file under that folder.

**What `enter` inserts.** Every file selected with `tab` plus the highlighted
one, each once, in list order, space-separated — and nothing is sent: the panel
closes, focus stays in the input and the message still waits for you. A file
below the session's cwd is inserted as `@` plus its path from that cwd
(`@AGENTS.md`, `@lib/view-layout.js`); any other file — one of another checkout,
or one outside the cwd — is inserted as its real absolute path, because `@`
resolves against the current directory and would name the wrong file.

**The preview is bounded.** It is one `open`/`read` of at most 64 KiB, at most
200 lines and at most 400 columns per line, so no file can stall a paint: a file
the read cut short ends with `… preview truncated.`, and a binary file paints
`Binary file — preview not available.` instead of its bytes. The pane sits in its
own rounded box, with the top visible line as `line/total` on that box's top
border and a dim gutter numbering each line once; a line wider than the pane
wraps onto continuation rows aligned under the same text column instead of being
cut with an ellipsis, and when the body is too short for the box plus one content
row the preview paints unbordered rather than squeezing its content.

**Coloured, from your theme.** The preview paints the file's syntax through the
host's own `highlightCode` / `getLanguageFromPath`, so the colours are the active
theme's and never a foreign palette; the gutter keeps its dim tone and is never
highlighted. An unknown language, a grammar the host has not loaded, an absent
highlighter and a highlighter that throws all degrade to plain text — never
blank, never an error, never a partial line — and highlighting runs once per
preview load, never per repaint.

**Read-only, and reachable from Gentle Shell.** The panel reads and paints: it writes
nothing, stages nothing and opens no network, and every child is a fixed argv
with a bounded timeout — `git` through this package's async runner, plus the one
`$VISUAL`/`$EDITOR` `ctrl+e` starts (a missing variable is reported in its own
sentence). With `gentle-shell-bridge` published, `/files` contributes one keymap
action (`files`, "File picker", default `alt+p`, overridable in
`/gentle:customize` → `Keymaps` and through `GENTLE_PI_FILES_KEY`; a changed key
applies after `/reload`) and one row in the command palette's `Session` section.
The bridge carries no handler, so this package asks `resolveKeymap("files")` for the
effective key and binds it itself; without the bridge nothing is registered, bound
or announced, and `/files` still opens from the palette and as a command.
It mounts its own overlay, so a host without `ctx.ui.custom` gets one line saying
the picker needs an interactive session with overlay support, and no second
surface in its place.

## Card style follows your shell

The tool cards — the two worktree tools, the file cards and CodeGraph's rows —
follow the card style chosen in Gentle Shell — the
rounded `╭ ╮ ╰ ╯` frame (`neon`) or the `▎` rail over a painted band (`float`,
the default). Content, order, truncation, the collapsed three-row preview and
the elapsed time are identical in both; only the chrome differs.

- **A collapsed result keeps three info rows in both content levels.** A
  `worktree_create` result draws the created checkout's path, the branch with
  `(created)`/`(adopted)`, and the odd; a `worktree_list` result draws its worktree
  rows first — the main checkout's branch row included — and the `project:`/`path:`
  metadata after them, and still expands to every row. The Gentle Shell
  `minimal` level does not withhold those rows: they are the information the card
  exists to show. A failure still says why, and `ctrl+o` still shows everything.

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
  publishes the level (`default` or `minimal`) and the cards that honor it read it on
  each paint, so a switch applies to the next paint. At `default` a collapsed card
  shows its heading and at most three body rows; at `minimal` it is the heading
  alone, closed by the rule that carries the elapsed time. A failure still says why at
  either level, and `ctrl+o` expands any card to everything. A host without Gentle
  Shell reads as `default`. This holds for `/warp`, the CodeGraph card and the
  file cards. The two worktree tool cards are the exception (S2): their three info
  rows are their point, so a collapsed `worktree_create`/`worktree_list` result
  keeps them at both levels.
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

## The bash card, and its preference

The bash card is a **design**, not a renderer and not a preference of this package.
`lib/bash-design.js` registers one design (`odd-worktree.bash-activity`, label
`activity`) through gentle-shell-bridge's `registerToolDesign`. The bridge owns Pi's one
tool-renderer resolver, builds the host's own card (whatever `Card style` and
`Card content` are chosen), reads its `bash` line in `/gentle:customize` → `Cards`
(`native` | `activity`) on every render pass, and hands the design the rows the host
drew. So the choice is the bridge's, survives a restart there, repaints cards already
on screen as well as new ones, and does not depend on extension load order. With no
bridge, or one older than `registerToolDesign`, nothing is registered.

What the design changes is one thing on the card's heading row: the host's `$` mark
becomes the family the classifier (`lib/bash-activity.js`) names for the command —
`⌕ exploring`, `✓ checking`, `⚠ destructive`, and so on — and the columns the longer
mark adds are taken from the row's own fill, so the row keeps its width. Every other
row comes back byte for byte, results are never touched, and the heading keeps the
host's own paint.

The rule is the classifier's: never guess. The design context carries no arguments, so
the heading is the only evidence, and a call is named only when the heading provably
shows the WHOLE command: no `…` abbreviation, no `… +N lines` fold, no continuation
row, and nothing after the command but the host's fill and hint. A command the
classifier cannot name, a heading that hides part of the command and a row with no
fill to pay for the word all keep the host's `$` exactly as drawn. The default is
`native`; the design draws nothing until the user picks `activity`.

The CodeGraph card is separate: with the `codegraph` CLI installed it still claims
`codegraph …` bash rows through its own resolver (invariant 19).

## The file cards and their switches

A `read`, `edit` or `write` call whose `path` names one of two things is drawn as
that file rather than as a bare tool row: a **customized skill** — a file called
`SKILL.md`, in any case, that a `skills` folder holds — or an **ODD artifact**,
any file below an `odd/tasks` folder. The identity is the path's components and
nothing else (`lib/skill-odd-card.js`): both separators are read, so a Windows
path classifies like a POSIX one; `lib/skillset/notes.md`, `docs/oddity.md`, the
notes beside a skill and a `SKILL.md` outside a `skills` folder are ordinary
files. A path naming both kinds is decided by the marker closest to the file, so
a `SKILL.md` below a `skills` folder is a skill even when an `odd/tasks` folder
sits above it, while one whose closest marker is `odd/tasks` is an ODD artifact
like every other file there.

| The path names | Mark | Label | The role the label wears |
| --- | --- | --- | --- |
| a `SKILL.md` a `skills` folder holds | `▤` | `skill` | the theme's `toolTitle` |
| any file below an `odd/tasks` folder | `📑` | `odd` | the theme's `mdHeading` |

**The heading** is that mark and label, then the tool, the path and — for a read
only — the line range the call asked for (`:10-39` for `offset: 10, limit: 30`,
`:7` for an `offset` alone). Only a read states a range because only a read asks
for one: a write knows how many lines it writes, never where they land, and an
edit's real range is the diff its result carries. A range stated in a shape the
card cannot read names nothing rather than half of itself.

**Collapsed and expanded.** Collapsed, an ODD call names the file itself (`📑 odd ·
read cards-skill-odd.md`) because its folder is long and the file's own name is
what a reader looks for; expanding the call draws the whole path in its place, so
a deep path is never lost behind an ellipsis. A skill's path is short enough to
be stated either way. A call still running wears the warning tone and closes its
own frame; the result that follows closes it in the info tone (or the error tone)
and carries the elapsed time bottom-right, in the form the other cards use
(`61ms`, `1.2s`). The host's expand key hint is offered on a settled call, and the
host's `expanded` flag (`ctrl+o`) decides what is drawn.

**What the body is.** Collapsed it is the first three rows of what the result
reported — a document previews from its top, unlike a command's output, whose
summary is written last — and expanded it is the whole text. A call that failed
says why at either level and wears the `error` role. Markdown is the shape a
document is written in, not a property of where it lives: an expanded `read` of
any `.md` file, and an expanded `write` to one, render as a document through the
package's own renderer (`lib/odd-markdown.js`) — headings, bullets, fences — with
the card's body role as the token colour, and a write draws the content its call
carries, which the result does not echo. A collapsed card keeps its rows, because
its preview is the first rows of the file; a failed one keeps its error; every
non-Markdown file keeps its rows. **An edit is never a document**: its rows are
the diff the host carries (`details.diff`) — its own text when it carries none —
and expanding it shows the whole diff.

**The two switches.** Each card has one, labelled `Card skill` and `Card odd`,
both in `/gentle:customize` → `Cards` and both on by default.

```json
{ "schema": "gentle-pi.card-files/v1", "skill": true, "odd": true }
```

- **The document** is `<home>/card-files.json`, and it is strict: that schema
  string, the two booleans and nothing else. `<home>` is the one `card-style.json`
  resolves: `GENTLE_PI_CONFIG_HOME` → `GENTLE_SHELL_CONFIG_HOME` →
  `~/.pi/gentle-ai`.
- **The switch is read live**, in the order and with the reasons the card style
  uses: the process-wide slot a toggle sets, then the document read fresh, then
  both on. A missing, unreadable, malformed, wrong-schema or non-boolean document
  reads as on, and an unknown name is never on.
- **The write is atomic and owner-only**, document first and slot second, so a
  failed write leaves both on the old state and there is nothing to roll back. It
  merges the one switch into the state it can see, so saving `odd` keeps `skill`
  as it was, and a document it cannot parse is never overwritten.
- **The rows.** The switches reach `/gentle:customize` → `Cards` through
  gentle-shell-bridge's `registerRows` alone (`lib/cards-customize.js`, provider
  `odd-worktree.cards.file-switches`): each setting is two consecutive rows, `on`
  then `off`, sharing one setting name under the bridge's own cursor, with a
  `current()` read at build time and an `action()` that persists before the host
  repaints. A refusal is a throw from that action — the writer refused, so nothing
  was saved — and the customize menu catches it and shows its message (`Card odd
  was not switched on: the card-files document is malformed (malformed_file); the
  switch is unchanged.`) as one error notice, with the stored value and the drawn
  switch exactly as they were. The bridge gate is the issues section's: the
  published API's schema and major version, then the one hook used, and the one
  `gentle-shell-bridge:ready` announcement for a bridge that publishes later. With
  no bridge nothing registers and no other surface changes; there is no customize
  command, no tool and no settings file here.
- **A flip repaints what is on screen.** Both switches are read inside the card's
  build, which the host calls on every frame, so flipping one repaints the rows
  already drawn.
- **Style and content level are the shell's.** The cards are on the same substrate
  as the others, so `float`'s painted band (the default) and `neon`'s rounded
  frame draw the same content. The content level applies too: at `default` a
  collapsed result shows at most three body rows, at `minimal` it draws no body at
  all — its closing rule, with the elapsed time, is the one row — while the call
  above it keeps its heading; `ctrl+o` expands it to everything, and a failure
  still says why at either level. Both slots are read at paint time, so a change
  reaches a card already on screen.

**The host's box is reproduced, because the hook decides per tool name.** The host
resolves a tool's renderers by NAME (`registerToolRenderer`) and never shows them
a call's arguments, so the shell a resolver declares is fixed for every call of
that tool. Declaring `self` — which this card does for the rows it draws — takes
the host's own box off all of them, so a forwarded row is drawn exactly as the
host would have drawn it: inside the host's box — `Box(outputPad, 1, bgFn)`,
`outputPad` columns of padding each side, one painted blank row above the call and
one below the result, in `toolPendingBg` while the call streams, `toolErrorBg`
once its result failed and `toolSuccessBg` otherwise — for a row of a renderer
whose own shell is the default (`read`, `write`), and untouched, with no box, no
padding and no background, for one that frames itself (Pi's `edit`). A path that
names neither identity is that same forwarded row, so an ordinary file call looks
exactly as it did before the card existed.

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
main: 1a2b3c4
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

One document holds a preference rather than worktrees: `<home>/card-files.json`,
the two file-card switches the `Cards` rows write; its format, reader and writer
are in [the file cards and their switches](#the-file-cards-and-their-switches).
The bash design's choice is not stored here at all: it belongs to the bridge
([the bash card](#the-bash-card-and-its-preference)). Nothing else in user
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
would edit the same files, and that after the merge the default branch is updated, then the
checkout is removed and its branch kept, unless a live session stands in it. Moving the
session stays the human's.

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
| After a successful native `codegraph init` | One coordinated sync, in the background. A completed sync appends nothing to the tool result; a sync that did not complete appends one short line naming that failure. A failed init keeps its error and starts no sync. |
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
such as `npx`, `pnpm exec`, `yarn` or `bunx`, in any pipeline or `;`/`&&`/`|`/`||`
sequence, with or without arguments after the subcommand. A command that only
mentions it (`echo codegraph init`, `git -C codegraph status`, `cat codegraph.json`,
`grep -r codegraph src`) stays the host's own `bash` row. A `bash` card names the
input after its program word (`codegraph status .` reads `· status .`), on one line
collapsed and whole when expanded, with no operation label. The MCP explore card's
heading is `codegraph · explore <query>` and continues ` · <last path segment>` only
when its `projectPath` names a checkout other than the session's cwd; the full path
never appears, and an absent, empty or same-checkout argument adds nothing. The
comparison resolves `.` and `..` lexically and reads a relative argument against the
session cwd, so `/work/repo/../repo`, `/work/repo/.` and `../repo` from `/work/repo`
are all that same checkout and add no segment, while a resolved sibling still names
its own last segment. No filesystem is read to decide it. It is
registered through the host's tool-renderer hook, adds no tool or command, and
hands every other tool back exactly as the host resolved it; a `bash` command that is not
CodeGraph's is forwarded to the host's own renderer. A host without that hook draws nothing of
ours. Every card in this package, the two worktree tools, the file cards and the CodeGraph rows alike, declares `renderShell: "self"`: it frames itself in float or neon, and the host's own filled box is never drawn under it. The collapsed card is one factual row per operation (an init, a sync, a query or explore
count); `ctrl+o` expands it to the whole output, except an `init`, which expands to
its `→ initialized`/`→ already initialized` row plus the index facts it printed and
never the CLI's `Use "codegraph index" …` advisory. The Gentle Shell card content
level (`minimal`) hides the result body while a failure still says why — except an
init's one outcome row (`→ initialized` / `→ already initialized`), which is what
the call did rather than its body and is drawn at BOTH levels; a minimized init
keeps that row alone and its index facts wait for the expansion. A `codegraph …`
`bash` call is that card's only while the CLI is installed; without it the host draws
it, and [the bash design](#the-bash-card-and-its-preference) may head it with the
classifier's `codegraph` identity.

## Deliberately absent

This package is the worktree / ODD / files / issues surface only: two agent
tools, four panels, one optional rail section, one bash design on the bridge and
the two file-card switches, no customize panel, no plugin-tools
toggles, no CodeGraph command or tool (only the prompt advice above), no
companion-app integration, and no worktree↔issue association. Its
customize-side contributions are the `activity` value of the bridge's `bash` line,
the `Card skill` / `Card odd` rows and the file picker's `files` keymap action
with its palette row, none of which adds a command or tool of its own.
There is nothing to configure here beyond those two switches, and `/warp`,
`/odd-list`, `/files` and `/issues` are always
on. Paths, branches and arguments reach `git` and `gh` as fixed argv arrays,
never as a shell string.
never as a shell string.

## Tests

```bash
node --test tools/*.test.js                # the whole suite (package.json `test`)
node --test tools/issues-command.test.js   # one suite while iterating
```

The suite uses Node builtins only — no install step, no lockfile, no network —
and adding a dependency so a test passes is not an option. Node 18 is the floor
`engines` declares; CI additionally runs 20, 22 and 24. Keep it green at the
whole-suite level: run the focused file while iterating, then the full command.

- **Test the public surface.** Assert what a caller observes: the registered
  commands/tools, the manifest, the command handlers' results, the view's
  rendered lines, the files on disk. Do not read module-internal state.
- **Inject the runners.** Every child process sits behind a seam (`runAsync`, an
  injected `runner`, `hasBinary`, the TUI loader). Tests pass fakes; they never
  spawn real `gh`, a package manager, or anything that reaches the network.
  `tools/fixtures/load-extension.js` copies `extensions/odd-worktree-tools.ts` to
  a scratch `.mjs` with the two Pi imports stubbed, loads it against a fake host,
  and points it at this package's `lib/` through `GENTLE_WORKTREE_LIB_DIR` — which
  is how the registered commands, tools and manifest are asserted from the
  outside.
- **No network, no live tools.** GitHub responses come from
  `tools/fixtures/gh-*.json` through the injected runner.
- **Temporary state lives outside the worktree.** Every temporary repository,
  stub binary and extension copy lives under the system temp directory and is
  removed on exit: use `fs.mkdtempSync(path.join(os.tmpdir(), …))`, remove it in
  teardown/`after()`, and never point `TMPDIR` or a cache directory into the
  repository. A test that must write inside the repository removes the path
  before it ends.

## CI and releases

| Workflow | Trigger | What it runs |
| --- | --- | --- |
| `ci.yml` | push to `main`, every pull request | `node --test tools/*.test.js` on Node 18, 20, 22 and 24 — the range `engines` declares, 18 as its floor |
| `pr-check.yml` | pull request opened, edited, reopened or synchronized | the PR title and every non-merge commit subject must follow [Conventional Commits](https://www.conventionalcommits.org/), plus one suite run on Node 22 |
| `release.yml` | tag `v*` push (a `v*-*` tag is excluded), or a manual dispatch naming an existing tag | tag/`package.json` version parity, the suite, the GitHub Release, then `npm publish`, then verification |

The npm package is `pi-odd-worktree`. A release is the tag `v` plus the exact
`package.json` version — version 2.1.0 is `v2.1.0` — and preflight stops the run
when the two disagree. Publication uses
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers): `id-token:
write` is the only such grant in the repository and belongs to the `release` job,
which also holds `contents: write`; no npm credential exists in the workflow or
in the protected environment. A version npm already serves is reported and left
alone; a published version is immutable, so fix the cause and cut the next patch
tag.

The `release` environment must exist in the repository: it is where a release
waits for approval, so attach reviewers there if a release should pause. The
trusted publisher binds to this workflow file plus that environment name.
Publication therefore needs the trusted publisher bound to this repository,
`release.yml` and the `release` environment, and the provenance attestation binds
to the public `repository` `package.json` names, case-sensitively.
`npm pack --dry-run` is the check that `files[]` still lists every shipped
surface.

Release notes are generated when the GitHub Release is created and curated
afterwards by editing the published release
(`gh release edit v1.0.0 --title … --notes-file …`); no notes file is committed.

### Commits and pull requests

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
rewrite the commits locally and force-push the branch. Name the invariant you are
honouring or changing when a commit or a PR explains itself by one; the numbers
in [`codebase/invariants.md`](codebase/invariants.md) are how this repository
refers to them.

### Cut a release

1. Bump `version` in `package.json`, commit, and tag the exact commit:
   `git tag -a v1.0.0 -m v1.0.0 && git push origin v1.0.0`.
2. Preflight requires the tag to be `v` plus the `package.json` version and
   stops the run otherwise; then the suite runs.
3. The `release` job creates the GitHub Release, then publishes to npm with
   provenance over OIDC Trusted Publishing, and `verify` reads the registry from
   outside and confirms the release is published for the tag.

The repository invariants are in [`codebase/invariants.md`](codebase/invariants.md),
and the boundaries they defend are in
[`codebase/mental-model.md`](codebase/mental-model.md).
