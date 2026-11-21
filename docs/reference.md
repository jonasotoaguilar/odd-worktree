# Reference

Detail behind the [README](../README.md): how each surface behaves, its keys, its limits and
how the package is tested and released. The repository invariants live in
[`codebase/invariants.md`](codebase/invariants.md).

## Create, list, move and delete, in detail

1. **Create** — `worktree_create` with an `odd` and a `branch`, or press `c` in
   `/warp`.
   - `odd` and `branch` are required; `copy_changes` and `base` are optional.
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
   - `base` (the agent tool only; the `/warp` create never takes one) starts the new
     branch from another branch instead: a `dev` branch in a git-flow repository, or
     the branch a piece of work resumes from. A local branch is used first, then
     `origin/<base>`; omitted, nothing changes. An unusable value is refused with
     `invalid base: …`, an unknown branch with `could not resolve base branch …:
     tried <base>, origin/<base>`, and a `base` given with a branch that already
     exists with `base only applies when the branch is created`, since an existing
     branch is checked out as it is. The base branch is still refused as the
     worktree's own branch.
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
   `a` in the panel) to also see the worktrees Git knows outside
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

Two host shortcuts are not panel keys at all: they are what OPENS a panel,
bound directly on the host at extension load rather than contributed to any shell
surface — `alt+p` for [the file
picker](#files-the-picker-its-scopes-and-its-orders) and `alt+i` for
[`/issues`](#issues-three-tabs-one-shortcut-one-filter). `GENTLE_PI_FILES_KEY`
and `GENTLE_PI_ISSUES_KEY` override them when they hold a non-empty value, and
`/files` and `/issues` stay reachable as commands with no key at all.

`/warp` selector — the footer legend is the key reference. Its top rule carries
the heading `Warp · n worktrees`, `n` being the checkouts its listing holds; the
extended list reads `Warp · all n worktrees`, that same count plus the checkouts
outside `<repo-name>-worktrees/`. Two detail lines sit under the heading, the
current checkout's own and the focused one's, which follows the selection; a blank
row separates them from the list, and a second one separates the list from the keys.
The list block is a budget of SEVEN lines shared with two fixed count lines,
`↑ n more` and `↓ n more`: both drawn leaves five checkout rows, one drawn leaves
six, and with nothing hidden it holds seven — or every checkout, when there are
fewer. Those two lines are text outside the selection space, never rows and never
selectable, so the cursor only ever lands on a real checkout.

| Key | Action |
| --- | --- |
| `↑`/`↓`, `j`/`k` | Move the selection |
| `enter` | Warp to the focused checkout |
| `c` | Open the create flow: answer `Branch` (the change type from the eleven-type list, then the name — composed as `<type>/<name>`, `feat` by default) and `Odd` (the checkout's directory) — `tab`/`←`/`→` switch between the two fields, `↑`/`↓` pick from the active list, typing fills the active name, the ODD list's first entry is `new odd` (the only one that takes a typed name) and its other entries are the ODDs that exist in `main` minus the ones whose checkout already exists, `enter` on the ODD creates, `esc` cancels. In BOTH typed names one or more consecutive spaces become a single `-` (`change    cost` is `change-cost`), and the typed row, the preview and the create always show and use the same name |
| `ctrl+d` | Ask to delete the focused checkout; the extension owns the confirmation, the evidence and the removal |
| `a` | Open the extended list of every other checkout (`↑`/`↓`, `pgUp`/`pgDn`, `enter`, `T` or `/` to filter, `esc` back). Its `a all` hint on the legend is painted only when a checkout other than this one stands outside `<repo-name>-worktrees/`, because only then does the list hold anything the panel does not |
| `r` | Reload the listing |
| `esc`, `ctrl+c` | Close the panel |

`/odd` — `↑`/`↓` select, `t` search (`T` and `/` also open the box), `o`
open the document in `$VISUAL`/`$EDITOR`, `s` toggles the order between `recent`
and `name`, `r` reload, `esc` close. `←`/`→` and `[`/`]` scroll the list; the
document pane pages with `ctrl+j`/`ctrl+k`.

`/files` — one option per key. The scope step is `↑`/`↓`, `enter`, `a` (the
session's checkouts, or every worktree Git lists for the clone) and `esc`.

| Key | Action |
| --- | --- |
| `↑`/`↓` | Move the selection |
| `tab` | Select or unselect the highlighted file |
| `ctrl+j`/`ctrl+k` | Scroll the preview one line |
| `ctrl+o` | Cycle the order: `files`, `tree`, `ext` |
| `space` | In `tree` and `ext`: fold or unfold the group holding the highlighted file |
| `shift+space` | In `tree` and `ext`: collapse every group, or expand them all when they are already collapsed — the label states which |
| `ctrl+u` | Clear the query |
| `ctrl+e` | Open the highlighted file in `$VISUAL`/`$EDITOR` |
| `enter` | Insert the selected files plus the highlighted file, and close |
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
first. When the `GITHUB` rail section has already read this checkout's repository,
the first frame is painted from that cache instead and ONE tab is read at mount —
the other two read the first time you open them; [the rail
section](#the-github-rail-section) describes the cache and what it changes. `All`
costs nothing until you ask for it, which is the point of the split:
the common case is your own issues, and reading every open issue of the
repository to paint three tabs was work nobody asked for.

- **`alt+i` opens it from anywhere.** The key is bound directly on the host at
  extension load, never contributed to a shell surface, and it invokes the
  command's own handler with the session context — so it opens exactly what
  `/issues` opens, with `/issues`' own refusals. `GENTLE_PI_ISSUES_KEY` overrides
  it when it holds a non-empty value, and it is bound only when the `gh` probe
  registered the command: without the CLI there is no key and no dead key either.
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

A NUMBERED open — `/issues <n>`, the form a rail click sends — first takes the
ROW's identity: the click carries the repository the rail proved when it READ that
row, and the open pins that exact `<host>/<owner>/<repo>` with no probe at all — no
`git`, no `gh` — so the first frame paints as soon as the TUI helper is loaded. The
number belongs to the repository the row was read from, so that is the right target
even if the checkout has moved since; the hint is used once, cleared with the click,
and only in the session generation that read the row, so a row the host retained
across a session boundary still dispatches its number but leaves no hint behind. The
identity is normalized with the same function every pinned read uses, and a value
that does not normalize into `<host>/<owner>/<repo>` records no hint at all.
Without it (a typed `/issues 12`, a hint that is gone) the open pins the checkout's
CACHED scope instead of forcing a fresh `git`/`gh` proof before the first frame, and
a cached pin that cannot be read falls back to the fresh proof once. A typed
`/issues` always proves freshly. The `o` opener binds the same identity to `-R`,
normalized the same way, so a raw value never reaches gh.
Nothing that mutates is loosened: every action re-proves the checkout with a fresh
read and refuses on drift, as above.

## The `GITHUB` rail section

When Gentle Shell draws its rail, a section headed `GITHUB` lists this checkout's
open issues that you AUTHORED (`author:@me`) or are ASSIGNED (`assignee:@me`),
merged into one list: deduplicated by issue number (an issue that is both keeps
the `assigned` row, since that is the tab its click opens), sorted by last update,
seven drawn, and when the read answered with more, an eighth and last dim row
reads `and N more issues` (`N+` when either contributing search was truncated at
its cap, because the real total is larger). The section's own meta reports what it
holds as the count the last read produced, with its unit — `8 issues`, never
`8 assigned` — and `8 issues · stale` while the rows on screen are the last good
ones.

- **One request per refresh.** A refresh is a single `gh api graphql` request with
  three aliased searches — `author:@me`, `assignee:@me` and
  `involves:@me -author:@me`, each open and each sorted by last update — and each
  answers its own `issueCount` and rows. The section draws the merged `mine` +
  `assigned` pair (the `involved` search is only cached, below), and `/issues`
  paints its first frame from that cache.
- **A row is an issue, and its one mark is a pull-request number.** It reads
  `#<number> <title>`, and when one of the issue's cross-reference events is a
  pull request (the read asks for the newest ten of them) its right-hand mark is
  `\ue726 #69`: the nerd-font pull-request glyph U+E726, one space, then `#` and
  the number of the MOST RECENT pull request among those events. It is painted in
  the bridge's own `muted` right-hand column — gray for that segment only, never
  the whole row. No pull request, no mark. That number arrives in the
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
- **One open at a time, and a swallowed click is invisible.** While a click is
  being opened, any further click — the same row, another issue, the overflow row
  — does NOTHING: no second `/issues` message, no second overlay, nothing painted
  or announced, and no refusal either; the click just has no effect. The effect
  comes back when the panel mounts, when an open ends without one (the command
  refused, the identity could not be proven, the dispatch threw), or after a
  bounded safety interval of about ten seconds if the host never ran the command
  at all. A typed `/issues` is never held back.
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
  ever schedule the refresh. The session's `gh` gate is dispatched startup work,
  never an awaited step: no child process and no network call sits on the path
  that opens a session or switches to another one, and `/issues` probes `gh`
  itself the moment you open it. A snapshot older than 60 s schedules exactly one
  deferred refresh, and only a drawn body frame schedules it at all — the header
  call never does. While the section is DRAWN it also re-reads on TIME: one
  self-scheduled, unref'd timer at a 20 s floor, re-armed only from its own fire
  and stopped by itself the moment the section leaves the drawn window — two
  minutes without a frame. A hidden section keeps no timer, spawns nothing and
  reads nothing, and showing it again starts from `loading…`. Each turn of yours
  (`before_agent_start`, then `turn_end`) can ask for a read too, behind a 30 s
  floor measured on the last ATTEMPT: a failed read starts that floor, so a `gh`
  that keeps failing is not retried every turn, and the in-frame TTL counts from
  the attempt rather than from the last success. It asks only while the section
  was drawn within those two minutes, and with the 20 s timer keeping the
  snapshot fresher than its floor it adds no read of its own. A `bash` result
  whose command mutates an issue or a pull request is the one event that FORCES a
  read right after it — it bypasses both floors and is capped to one per 5 s, so a
  script that runs several `gh` writes cannot storm the API. Only `bash` is
  classified, only its command text, and only while the section is drawn. A
  collapsed section is still drawn — its header is painted, and that stamps the
  frame — so the timed read applies to it too. `session_shutdown` and a session
  that starts in another checkout drop the snapshot, so the rail falls back to
  `loading…` instead of the previous checkout's rows; a read still in flight at
  that boundary paints nothing and writes nothing to the cache, and a refresh
  still queued dies with the generation it was queued under instead of reading
  with no context. A `/reload` fires no `session_start`; the section re-learns its
  session on the next turn, so it keeps reading the checkout the session runs in
  and not the host process's own directory.
- **A failed refresh keeps the rows.** Once a list is on screen, a refresh that
  fails does not replace it: the same rows, in the same order, with the same
  marks, stay where they are and the header reads `<n> issues · stale` instead.
  A transient `gh` stall is therefore a stale list, not an empty one, and
  the next successful read clears the mark.
- **Every state is a row, none is a throw.** `loading…` (dim) before the first
  answer, `no open issues` (dim) for an empty result, and one error row naming the
  failure — but only while there is nothing to show; after that, a failure is the
  stale state above. The error row covers a failed `gh` read and a checkout whose
  own repository cannot be resolved; the resolution fails closed, exactly as
  `/issues` reads it, and no `gh` call is made without a proven identity. A cwd
  that is not inside a repository is not that error: the section's one line is
  exactly `not a git repository`, in the `dim` gray role and with no path, while
  `/warp` and `/issues` keep their own, fuller sentence. Neither is a checkout that
  IS a repository but has no remote: there is no GitHub repository to read from, so
  its one line is exactly `not a GitHub repository`, in the same `dim` gray role.
  gh's own `no git remotes` answer becomes that state — no read, no timer, and never
  its long failure sentence in the error tone; `/issues` keeps its own wording. A missing `gh` CLI never
  reaches this section at all — without the CLI the extension never adds it to the
  rail, so there is no line to draw — and the one `dim` `gh CLI not installed` line
  is the fail-closed answer for a `gh` that disappeared after the extension loaded,
  with no read and no timer. A failing
  click is recorded instead of thrown, and it never turns the list into an error
  row.
- **One cache, two halves, per repository.** The three scoped views live in one
  cache keyed by the repository identity the read was proven against, so a session
  that moves between checkouts never shows one repository's rows under another's
  name. The first half is in-process (`lib/related-issues-cache.js`: no imports,
  no child process, no disk) and owns what a read MEANS — the plan, the merge,
  the count invariant. The second is on disk (`lib/issues-cache-store.js`): one
  versioned document, `issues-cache.json` under `$XDG_CACHE_HOME/odd-worktree/`
  (else `~/.cache/odd-worktree/`), one entry per identity under the same key,
  bounded to the eight most recent identities and written through a temp file and
  a rename, so a failed write leaves the previous document whole. Nothing there is
  on a paint path or on `session_start`: the loader hydrates an entry before its
  plan and queues the write fire-and-forget, one in flight, and a session boundary
  does NOT clear it — the entries are the point — so a warm identity's first read
  after a restart is already a delta. The first read takes up to 100 per view,
  later reads the newest 20, merged by issue number. A merge cannot see an issue
  that was closed or unassigned, so each view is held to one invariant: after a
  merge its cached count must equal the `issueCount` the same answer reported, and
  a mismatch makes the NEXT read a full one; so does an entry whose last FULL read
  is older than ten minutes, since a delta renews only the sync time and never
  that bound. Persistence never defeats either rule: an entry that is inconsistent
  or past that ten-minute bound is not hydrated at all, so it is read whole. A
  view with more than 100 issues is
  reported truncated — that is the `N+` in the overflow row — instead of being
  looped over, and a failed read leaves the cache untouched. A session boundary is
  durable: a read in flight when the session shuts down cannot repopulate the
  cache, and an answer older than one already applied is ignored rather than
  written over it.
- **`/issues` opens from this cache, and owns none of it.** When the rail has
  filled an entry for the repository the panel itself proves, `/issues` paints its
  first frame from it and reads ONE tab at mount instead of three: the tab on
  screen is read at mount, the other two are seeded and read the first time you
  open them, and every answer replaces the rows it seeded. With no entry for that
  repository the open is exactly the one it always was: three scoped reads at
  mount. The panel is a reader only — the rail keeps the entry's ownership (its
  read, its merge, the count invariant above, the persisted copy, its generation
  at a session boundary), and nothing
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
  a rail. `gh` decides whether the two issues surfaces EXIST at all: without it on
  `PATH`, `/issues` is never registered and this section is never added to the rail
  — no child, no read, no timer, nothing to refuse and no line to draw. Every other
  surface (`/warp`, `/odd`, `/files`, the tools, the cards, the bash design, the
  prompt append, CodeGraph) keeps working without it.
- **The `gh` check never delays a session.** Whether `gh` is usable (`gh api user`,
  `gh repo view`, plus the checkout's own git probes: about a second of network) is
  decided in the background: `session_start` dispatches it and returns at once, so
  opening Pi, resuming a session and switching sessions never wait for it. The one
  startup notice a failing check gives, and the refusal `/issues` gives, are the same
  sentences as before; only when they appear changed. `/issues` typed while the check
  is still running waits for that same check instead of starting a second one. The
  checkout is resolved FIRST, with one local `git rev-parse`, so a session outside a
  repository makes no `gh` call at all and says nothing about it. A verdict is reused
  for five minutes when `gh` works and thirty seconds when it does not (so a login you
  just fixed is noticed quickly), once per checkout and `GH_HOST`, at most eight
  checkouts at a time, and everything is dropped at `session_shutdown`. A verdict that
  lands after its session was replaced is discarded.

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

**A scope step, always.** `/files` first asks which checkout to browse — `main`
included, so an unregistered session chooses its own checkout instead of being
dropped straight into the current directory. The default rows are the session's
own: `main`, the checkout the session stands in (once, when that is `main`) and
the worktrees this session registered with `worktree_register`, each row reading
`<odd> · <branch>` and its `±n files` (`±1 file`). A worktree that only exists for
some ODD is not on that list. `a` widens it to every worktree Git lists for the
clone — the ODD ones and the ones created outside this package — and back, and the
footer names the list the key switches to (`a all`, then `a registered`); a
checkout both lists carry keeps the cursor. Above that card's
footer sits the focused scope's detail line: the last commit subject, then
`±n files`, the age of the last modification as `33s ago`, and `↑n main` / `↓n main` — the
`main` row compares with `origin/main`, every other checkout with the local
`main` — and a field that is zero or absent is not painted at all. The `a` list costs
two bounded Git reads per checkout before the step paints, which is why a clone
with many worktrees opens it a moment slower than the session's list alone.

**One option per key.** The footer names one binding per action even when several
work, and both keys stay live. The compatibility bindings it never names all
work: `home`/`end` (the first and last row), `pageup`/`pagedown` (a page of rows
at a time), `ctrl+home`/`ctrl+end` (the preview's first and last line),
`ctrl+shift+j`/`ctrl+shift+k` and `ctrl+c`.

**The three orders.** `ctrl+o` cycles `files` (the default: one flat list with no
groups, changed files first and the most recently modified first), `tree` (an IDE-style folder tree — inside a folder
its subfolders come first and then its own files, so at the top level every
folder group paints before the files at the repository root) and `ext` (one group
per extension named with its dot, alphabetical by path inside, the extensionless
group last). The active order is painted, once, at the right of the info row under the
search row (the footer does not repeat it), which also carries the counts: how many files the query lists out of
the whole listing and the Tab selection in parentheses (`202/202 (4)`). `tree` and
`ext` are foldable and open folded: every group row paints `▸` when it is
closed and `▾` when it is open, in the grey role so the structure reads apart
from the files. Choosing an order (or cycling to the other tree) leaves open only
the groups holding the highlighted file — `src` and `web` for `src/web/test.ts` in
`tree`, only `ts` in `ext` — and closes the rest. Every row takes the cursor — the
arrows, `home`/`end`, the wheel, a click and a query stop on a folder or extension
row exactly as on a file row — but a group row is never marked, inserted or
opened: `tab` on it marks nothing, and `enter` on it sends the `tab` selection
alone, closing with those files when there is at least one and inserting nothing
while the panel stays open when there is none. `space` folds the focused group, or
the one holding the highlighted file when the cursor is on a file (its parent
folder in `tree`, its extension group in `ext`), so a tree is reopened by focusing
its group row and
pressing `space`; a click on a group row focuses and folds it in one move, and the
row the key folds is the row the cursor keeps. `shift+space` collapses every group, the ones holding the
highlighted file included, and leaves the cursor on the group row that held it;
pressed again with every group collapsed, it expands them all. The footer labels
it `shift+space collapse all` or `shift+space expand all` to match what it will
do; it needs a terminal that reports the chord (Kitty keyboard protocol or xterm
`modifyOtherKeys`), and elsewhere `space` still folds one group at a time. In the
`files` order neither key does anything and the footer does not name them. A
non-empty query forces every group open, and the fold keys do nothing until it is
cleared. In `files` and `ext` a file row paints its parent directory at the
right; in `tree` it does not, because the tree already places the file under that
folder.

**What `enter` inserts.** `enter` is the insert key and nothing else: in every
order it never folds a group, which stays on `space`, `shift+space` and the
click. Its payload is every file selected with `tab` plus the highlighted file,
each once, in list order, space-separated — and nothing is sent: the panel
closes, focus stays in the input and the message still waits for you. A group
row adds no file of its own, so `enter` on a folder or extension row sends only
what `tab` marked. A file below the session's cwd is inserted as `@` plus its
path from that cwd (`@AGENTS.md`, `@lib/view-layout.js`); any other file — one of
another checkout,
or one outside the cwd — is inserted as its real absolute path, because `@`
resolves against the current directory and would name the wrong file.

**The layout.** The search row takes the list pane's width, the info row sits
directly under it, and the preview's box top border rides that info row while its
bottom border closes on the list's last row, so the preview uses the body's whole
height beside the list instead of sitting below the search. A full-width rule
then closes the body under both columns, aligning the separation below the list
with the preview. The title row carries the path being listed right after the
panel's name — `Files · /home/you/dev/odd-worktree`, elided from its left when the
card is narrow — with `esc` alone in the far corner.

**No file under the cursor.** While the cursor rests on a group row the preview
keeps its box and paints `No file selected.` instead of its `line/total` position,
so the pane never looks like a file it is not showing.

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

**Read-only, and one key.** The panel reads and paints: it writes nothing,
stages nothing and opens no network, and every child is a fixed argv with a
bounded timeout — `git` through this package's async runner, plus the one
`$VISUAL`/`$EDITOR` `ctrl+e` starts (a missing variable is reported in its own
sentence). `alt+p` opens it from anywhere: the key is bound directly on the host
at extension load, `GENTLE_PI_FILES_KEY` overrides it when it holds a non-empty
value, and it is bound once for the life of the process. The same seam binds
`alt+i` for [`/issues`](#issues-three-tabs-one-shortcut-one-filter), with
`GENTLE_PI_ISSUES_KEY` as its override. A host with no such
seam, or one that refuses the key, gets no shortcut and no message about it, and
`/files` keeps working as the command it is. The picker is contributed to no
shell surface of its own: this package claims no row a plugin would have to
publish, and nothing here needs `gentle-shell-bridge` to open. It mounts its own
overlay, so a host without `ctx.ui.custom` gets one line saying the picker needs
an interactive session with overlay support, and no second surface in its place.

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
  The painted strings the cards do measure are the host's own dim key hint and, on
  a file card, the document rows Pi's Markdown renderer painted (see
  [the file cards](#the-file-cards)) — both only with the host's ANSI-aware width. So the row is the same whatever measures
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

## The cards the `activity` design paints

The cards are a **design**, not a renderer and not a preference of this package.
`lib/bash-design.js` registers one design (`odd-worktree.bash-activity`, label
`activity`) through gentle-shell-bridge's `registerToolDesign`. The bridge owns Pi's one
tool-renderer resolver, builds the host's own card (whatever `Card style` and
`Card content` are chosen), reads its line in `/gentle:customize` → `Cards`
(`default` | `activity`; the bridge stores `default` as `native`) on every render pass, and hands the design the rows the host
drew. On a bridge that can put several tools on one line (`0.6.0` and later) that is ONE
`Card tags` row covering `bash`, the three read-only shell tools `grep`, `find`, `ls`, and
`read`, `write` and `edit`; on an older bridge the same design is registered for `bash` alone, the row is
`Card bash` and those six are drawn by the host (or, for a read, a write or an edit on a skill or an ODD
artifact, by the file card). `write` and `edit` are on that line through a SCOPE rather than a bare
claim (gentle-shell-bridge `0.9.0` and later): the line claims those two tools' calls only when
`args.path` is a skill or an ODD artifact, which is the file card's own rule (`fileCardIdentity`,
`lib/skill-odd-card.js`), so the design being asked about a write or an edit is the file card's
question and never a row of this design's own. A bridge older than `0.9.0` takes the same line
without the scope and without `edit`, exactly as it did before, because a scoped registration there
is refused WHOLE and would cost the `activity` design altogether; a release string that cannot be
read is read as that older shape for the same reason. `0.6.0` itself is compared by that same semver
order, so a `0.6.0-rc.1` bridge falls back to the single `tool: "bash"` design — where an earlier
release of this package still accepted the grouped shape, a deliberate narrowing because a
prerelease is BELOW its own release. Which shape is sent is decided from the
bridge's own `VERSION` before anything is registered, because a grouped registration on an
older one is refused and reported in `/bridge-status`. A release string that cannot be read
is not guessed: the bridge is asked once, with a throwaway design nobody selects and a line
no plugin would use, which is registered and immediately disposed, so the capability is the
bridge's own answer instead of a version number. A bridge without `registerToolDesign` gets
no design at all. So the choice is the bridge's, survives a restart there, repaints cards already
on screen as well as new ones, and does not depend on extension load order. With no
bridge, or one older than `registerToolDesign`, nothing is registered.

What the design changes is one thing on the card's heading row: bash's `$` mark becomes
the family the classifier (`lib/bash-activity.js`) names for the command —
`⌕ exploring`, `✓ checking`, `⚠ destructive`, and so on — and a read-only shell tool's own
`<glyph> <tool>` (`⌕ grep`, `⌖ find`, `☷ ls`) becomes `⌕ exploring`, because those three
only read and run no command at all. Nothing else is renamed: the arguments after the mark stay where the
host put them. The columns the longer mark adds are taken from the row's own fill, so the
row keeps its width. Every other row comes back byte for byte, results are never touched,
and the heading keeps the host's own paint. A `read` is one of those other rows whatever it
reads: the line declares it only so that the file card can be asked about it, and this design
paints nothing for it — a read of a skill or an ODD artifact is the file card's call, that
card draws its own heading, and a read of anything else is the host's own row, both parts
exactly as the host drew them, whichever resolver runs first.
The identity rule is the file card's own (`lib/skill-odd-card.js`), so the two surfaces
cannot disagree about which paths those are, and so is the list of tools that card claims
(`read`, `edit`, `write`): a `grep` or an `ls` that names a skill's path is no file card's
row, so this design keeps heading and framing it as it always did.

The rule is the classifier's: never guess. A bridge that hands the design the call's
render context (`ctx.render`: the arguments, `isPartial`, `isError`, `durationMs`) lets it
classify the REAL command, so a heading the host truncated, folded or wrapped is still
named; for a read-only shell tool that render context is only the proof that the heading is not
the whole evidence, since the word never depends on what it reads. That context is the
bridge's, and it is handed on BOTH registration shapes — the grouped `Card tags` line and
the historical per-tool one — with the call's own `args` by reference, exactly as Pi passes
them (`ToolRenderContext.args`); `ctx.render.args.command` is therefore the bash contract.
A reproduction that nests that object one level deeper (`{ args: { args: { command } } }`)
looks exactly like a bridge that stopped handing it: the command is unreadable, so a cut
heading falls back to `$ bash` and the frame and duration are left unpainted. Without it the drawn
heading is the only evidence and a call is named only when the heading provably shows the
WHOLE text: no `…` abbreviation, no `… +N lines` fold, no continuation row, and nothing
after it but the host's fill and hint. Either way, a bash command the classifier cannot
name keeps the generic heading, now drawn `$ bash` (in the host's `bashMode` role) instead
of a bare `$`, so a card never claims an activity it cannot prove; a read-only heading
that cannot be proved stays exactly as the host drew it, because those three have no
generic word of their own. A tool the line does not cover (every MCP tool) is
returned untouched, and so are `read`, `write` and `edit`, which the line declares for the file
card's question alone and this design draws nothing for.

Colour is a theme role, never a palette (`ctx.theme`): the label wears its family's role
(`exploring` `mdLink`, `checking` `mdHeading`, `formatting`/`preparing` `syntaxFunction`,
`publishing` `success`, `versioning` `warning`, `destructive` `error`, generic `bashMode`),
and the whole frame (`lib/bash-frame.js`) is repainted in ONE role so no row shows two
colours side by side. The call's state speaks first: a running call wears `warning` on the
frame, a failed one `error`, an idle one the family's role; the label keeps its family
colour in every state. A finished call's duration (`120ms`, `1.2s`, in `dim`) is written
into the closing rule right-aligned against the corner (neon `╰──── 120ms ╯`; float: the
bar row's end), only when it fits, never while running and never without a duration. A
theme that cannot paint, or no render context, leaves those rows exactly as the host
drew them. The default card is the host's own only for a user who already chose it. The bridge has no default design (an
absent value reads `native`), so on its first load with a bridge that has `createStore`,
this package selects `activity` for `bash` **once**: only when the bridge's
`bridge-tool-designs` store holds no `bash` choice, and it then writes its own marker
(`odd-worktree` store, `bashActivitySeeded`). It writes that choice BEFORE it registers the
design and never writes the bridge's reserved line key: a `0.6.0` bridge carries a joining
tool's per-tool choice over to its line's value at registration time, so a choice stored
afterwards would be missed, and the line would open on `default`. A choice already stored
(`default` included) is never overwritten, a later switch to `native` is never undone, and
a failed write leaves no marker so the next load tries again.

The row's own name is the bridge's: it is `Card ` + the line's key, a line carrying no label
of its own, so `Card tools` became `Card tags` when this package renamed its line, and the bridge
has no rename or alias path. That rename is carried over by this package and never left to the
bridge's registration-time migration: that migration runs only while the line has no value of its
own, and what it then copies is the legacy per-tool `bash` value — the `activity` this seed
stores — so a user who chose `default` would be handed `activity` back. Before it registers, this
package reads the same `bridge-tool-designs` document and, only when `selections.$lines` holds
`tools` and no `tags`, writes `tags` with the value it found and drops `tools`; the bridge then
finds the key taken and does nothing. A store that is absent, unreadable, of another shape, or a
`createStore` that throws, is no carry-over at all: nothing is written, nothing is thrown, and the
line still registers.

The room the longer label needs comes from the host's fill first and, when a long heading has
none left, from the tail of the text after the mark, which then ends in `…` (or keeps the
host's own `…`); the heading is a preview and the expanded call shows the whole command.
Less than eight columns of that text would be left, and the row is left as the host drew
it. A drawing is a pure function of the host's rows, which tool's card it is, what each
theme role paints and the call's arguments and state, so repeated frames of a retained card
are answered from a bounded memo (512 entries) instead of being classified and repainted
again: Pi repaints every retained card on every frame. The `/gentle:customize` preview is
one row, like the other `Cards` rows.

The roles come from the theme, so the colours are the theme's. In `TokyoNight`, for example,
`mdLink` and `syntaxFunction` are the same blue and `success` and `bashMode` are two close cyans,
so `exploring`, `formatting` and `preparing` read alike there; a theme that separates those roles
separates the cards.

The CodeGraph card is separate: with the `codegraph` CLI installed it still claims
`codegraph …` bash rows through its own resolver (invariant 19).

## The file cards

A `read`, `edit` or `write` call whose `path` names one of two things is drawn as
that file rather than as a bare tool row: a **customized skill** — anything below a
`skills` folder, its `SKILL.md`, its references and its scripts alike — or an **ODD
artifact**, anything below an `odd` folder. The convention is the FOLDER and nothing
else: the file's own name decides no identity, which is why
`skills/x/references/commands.md` is that skill's and `docs/SKILL.md` is an ordinary
file. The identity is the path's components (`lib/skill-odd-card.js`): both separators
are read, so a Windows path classifies like a POSIX one, and `lib/skillset/notes.md`
and `docs/oddity.md` are ordinary files because the folder name is a component, never
a substring. A path naming both kinds is decided by the marker closest to the file, so
a reference below `skills/` is a skill even when an `odd` folder sits above it, while a
file whose closest marker is `odd` is an ODD artifact.

The claim is exactly three tools — `read`, `edit` and `write` — read from that same
module (`FILE_CARD_TOOLS`), so editing a skill's reference heads as that skill too,
while a `grep` or an `ls` that names one of those paths is still the activity design's
row.

| The path names | Mark | Label | The role the mark and label wear |
| --- | --- | --- | --- |
| anything below a `skills` folder | `▤` | `skill` | the theme's `mdHeading` |
| anything below an `odd` folder | `📑` | `odd` | the theme's `mdHeading` |

**The heading** is that mark and label, then the tool, the path and — for a read
only — the line range the call asked for (`:10-39` for `offset: 10, limit: 30`,
`:7` for an `offset` alone). Every element wears the role the reference design
gives it (gentle-shell PR #3061): the glyph AND the label in `card.titleRole`
(`mdHeading` for both identities) with the label
additionally bold, the `·` separator in `muted`, the tool name in `dim`, the path in `accent`, the line
range in `warning`, and the card's whole closed box in the identity's role. Only a read states a range because only a read asks
for one: a write knows how many lines it writes, never where they land, and an
edit's real range is the diff its result carries. A range stated in a shape the
card cannot read names nothing rather than half of itself.

**Collapsed and expanded.** Collapsed, an ODD call names the file itself (`📑 odd ·
read cards-skill-odd.md`) because its folder is long and the file's own name is
what a reader looks for, while a skill names the path from its own folder down
(`▤ skill · read merge-pr/references/commands.md`) because the folders above
`skills` say nothing a reader of the workspace does not know. Expanding the call
draws the whole path in either case, so a deep path is never lost behind an
ellipsis. A call still running wears the warning tone and closes its
own frame; the result that follows closes it in the info tone (or the error tone)
and carries the elapsed time bottom-right, in the form the other cards use
(`61ms`, `1.2s`). The host's expand key hint is offered on a settled call, and the
host's `expanded` flag (`ctrl+o`) decides what is drawn.

**What the body is.** Collapsed it is the first three rows of the document, as
drawn — a document previews from its top, unlike a command's output, whose summary
is written last — and expanded it is the whole document. A call that failed says
why at either level and wears the `error` role. Markdown is the shape a document is
written in, not a property of where it lives: a `read` of any `.md` file, and a
`write` to one, are drawn by Pi's OWN renderer (`Markdown` from
`@earendil-works/pi-tui`, `lib/file-card-markdown.js`) with a theme table that
gives every Markdown element a theme role — `heading`→`mdHeading`,
`listBullet`→`mdListBullet`, `code`→`mdCode`, `codeBlock`→`mdCodeBlock`,
`codeBlockBorder`→`mdCodeBlockBorder`, `quote`→`mdQuote`, `quoteBorder`→`mdQuoteBorder`,
`link`→`mdLink`, `linkUrl`→`mdLinkUrl`, `hr`→`mdHr`, and bold/italic/underline/
strikethrough from the theme's own handlers. Those rows arrive already painted: the
card PLACES them, measuring them with the host's ANSI-aware width and never
painting a body role over them, while the frame, the background and the padding
stay the card's. A write draws the content its call carries, which the result does
not echo. A host with no TUI package, a renderer that throws and a document that
draws no row all fall back to the wrapped plain source, unstyled. A failed call
keeps its error rows, every non-Markdown file keeps its rows, and **an edit is
never a document**: its rows are the diff the host carries (`details.diff`) — its
own text when it carries none — and expanding it shows the whole diff.

**The switch is the bridge's.** The card owns no preference of its own. It is
painted while the bridge's `Card tags` line answers that this package's activity
design (`odd-worktree.bash-activity`) draws the tool being painted, and only then.

- **The question** is `api.resolveToolDesignSelection(tool, args)` on the bridge's
  published object (gentle-shell-bridge@0.7.0; the call's own `args` travel with it from
  `0.9.0`), reached exactly like the design's registration — the `gentle-shell-bridge/api/v1`
  slot, behind its schema and major version gate — never an import. The `args` are the CALL's,
  taken from the render context this card already holds, and they are what lets a scoped claim
  answer per call: a question asked without them cannot see a scope at all, and the row would be
  painted twice.
- **The answer** decides: `{ kind: "design", design }` with
  `design.id === "odd-worktree.bash-activity"` paints the card; `native`, `missing`,
  `not-covered` and every other design give the row back to the host, box and hint
  included.
- **It is asked per painted tool, on every frame, and never cached**: the answer is
  read inside the card's build, which the host calls on every frame, so a mid-session
  switch repaints a card already on screen.
- **It is optional.** A bridge older than 0.7.0 (or none at all) has no reader, and
  then the card paints exactly as it did before the switch was joined: an
  unavailable gate never hides a row. An answer this build cannot read keeps the
  card too, and nothing here throws.
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

## The diff card

A second design, `lib/diff-design.js`, registers on the line `diff` through the same
`registerToolDesign` API, so `/gentle:customize` → `Cards` grows the row `Card diff` over
`write` and `edit` with the host's own card as `default` (stored `native`) and this package's
`color` beside it. `color` is selected once, on the first load that finds no choice — the same
first-run seed the `activity` design does — and a later `default` is never undone. The choice
is read on every paint, so a mid-session switch repaints cards already on screen.

What `color` draws is the same highlighter `/files` previews with, and never a palette:
`agent.highlightCode(code, language)` answers one string per line with the ACTIVE theme's own
syntax roles already applied, and `agent.getLanguageFromPath(path)` names the language. The
seam is resolved once at registration and handed to the design, so the design itself imports
no host package and writes no colour of its own.

* A `write` is drawn as an IDE pane: the call's own `content`, behind a line-number gutter, in
the theme's syntax roles, painted INSIDE the host's own frame. The bridge hands the call half
and the result half separately, so the call half — the frame's top rule, which is where the
host states `ctrl+o to expand` — comes back byte for byte, and the pane replaces the body rows
on the result half, reusing the host's own frame bytes and its inner width. Rows are measured
and clipped as PLAIN text and painted afterwards (invariant 17), so a painted row is never cut.
The host's folded budget and its `… +N lines` fold row are kept, and `ctx.render.expanded`
shows all of it. A host whose rows carry no frame gets the whole pane on the call half, with
the host's own hint row kept after the fold row — and never a hint the host did not draw. An
error result, and a body the host draws empty, stay the host's rows.
* An `edit` is drawn from the diff the host already carries, like `git diff` in the theme's own
roles: a row the call DELETED is painted whole in `toolDiffRemoved` and a row it ADDED whole in
`toolDiffAdded` — marker, line number, divider and code — so a changed row carries no syntax colour
of its own, and a context row is `muted`/`text` with the code in the syntax roles of the language
`args.path` names. An `edit` row states its line behind the same `N │ code` gutter the `write` pane
draws, with the rule in the same `dim` role; a hunk header and a skip marker state no line, so they
keep the role they have. The divider is measured as PLAIN text, and the two columns it costs come out
of the row's own padding — a row with none loses the tail of its code to an ellipsis (measured as
plain text too, invariant 17) — so the row keeps the width the host gave it and the frame is never
pushed out. The row text and every cell of the host's frame are the host's; a row that is not a diff
row — a heading, a blank line, a fold notice, a line the host wrapped onto a continuation row — is
left exactly as drawn, and repainting a row that already wears this drawing answers it identically,
divider and colour included.

A call whose `args.path` is a skill or an ODD artifact comes back byte-identical, on both
halves and for both tools: those rows belong to the file card, and the `Card tags` line claims
exactly those calls through its scope, so the specific claim wins and the two designs can never
paint the same call. Choosing `default` keeps the host's own card for both tools and leaves
every other surface exactly as it was.

The line needs gentle-shell-bridge `0.9.0`, the release that introduced the per-`(line, tool)`
claim: on an older bridge, or one whose release string cannot be read, NOTHING is registered
and `Card diff` never appears, because a registration that release would refuse costs the
whole design. Releases are compared by semver order at both of this package's cutoffs, so a
release whose own numbers equal `0.9.0` but carry a prerelease or a build suffix
(`0.9.0-rc.1`, `0.9.0+build.7`) is BELOW it and registers nothing either, while `0.9.1-rc.1`
and `0.10.0+local.2` are newer and register. An absent `registerToolDesign` or a refused
registration is no design and never a throw; a bridge that cannot store the choice still gets
the row — `Card diff` IS registered and only the first-run seed writes nothing, so the line
opens on the host's own card (`default`) until a choice is made.

## The list

`worktree_list` prints the main checkout first and unnumbered, as the `base: <branch>@<sha>`
line `worktree_create` also prints (the branch it stands on is always named), then one numbered
row per checkout this package created under `<repo-name>-worktrees`, by name.
A row is its directory's basename — which IS the ODD — then ` · ` and the branch Git
reports. With `all: true`, the worktrees Git knows outside that directory follow,
and a footer counts them while they are hidden. The text is fixed-field and
undecorated, so it reads the same on every run:

```text
project: repo
path: /code/repo
base: main@1a2b3c4
1 worktree-tools · feat/worktree-tools
2 billing · feat/billing
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

One cache document lives outside the checkout and outside the host's session
files: the issues read cache, `issues-cache.json` under
`$XDG_CACHE_HOME/odd-worktree/` (`~/.cache/odd-worktree/` when `XDG_CACHE_HOME` is
unset), keyed by repository identity and bounded to the eight most recent ones.
It is a cache, not a preference: deleting it costs one full read and nothing else,
and a write it cannot commit is silence rather than an error ([the rail
section](#the-github-rail-section)).

This package writes no preference document of its own: the file cards obey the
bridge's `Card tags` choice, which belongs to the bridge and lives in its own
store ([the cards](#the-cards-the-activity-design-paints)), and
[the file cards](#the-file-cards) own no switch, no document and no customize
row. Nothing else in user configuration is written by this package, except — with
the `codegraph` CLI installed — the one `codegraph` entry of
`<agent dir>/mcp.json` (see [CodeGraph:
index, daemon and MCP entry](#codegraph-index-daemon-and-mcp-entry)); Gentle
Shell's own `card-style.json` is read here, never written.

## The `bash` guards

The extension watches every `bash` tool call and refuses three things before the command
runs. The refusal is the call's result: it says the command did not run and names the
single tool that replaces it, `worktree_list` for a listing and `worktree_create` for
the other two. The prompt block above is what is meant to keep the agent from ever
reaching them.

| Refused | Where |
| --- | --- |
| `git worktree add` | any cwd |
| `git worktree list` | any cwd |
| a command that leaves the branch the checkout is on (`checkout`/`switch <other>`, `-`, a detached checkout, `checkout -b/-B/--orphan`, `switch -c/-C/--create/--force-create`) | the principal checkout only, and only while that branch is the repository's default |

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
- **Default branch, and the branch the checkout is on.** The default is resolved like
  the create's base: the local `main`, else the branch `origin/HEAD` names, else
  `init.defaultBranch`, once per checkout. There is no `main`/`master` list. The branch
  the checkout is ON is read from the checkout itself (`git symbolic-ref --quiet
  --short HEAD`), fresh at each judgement and never cached, because it changes outside
  this process; a detached HEAD is not the default branch, so a switch there is allowed,
  and with no resolvable default no switch is refused.
- **The command's own `cd` decides.** Segments are walked in order and a `cd <literal
  path>` moves the effective cwd for the segments after it, so `cd <worktree> && git
  switch x` is judged against that worktree and refused by nothing. Only a `cd` a shell
  runs moves it: one inside a quoted argument (`echo 'cd <worktree>'`) is argument text
  and moves nothing, while one inside `bash -c '…'`, `$(…)` or backticks is run. A `cd`
  argument that is not a literal path (`$VAR`, `~`, `-`, a glob, a backtick) leaves the
  checkout unknown, and an unknown cwd refuses nothing of the branch rule.
- **`checkout <ref>`.** `git switch` never takes a path, so its argument is a ref. For
  `git checkout`, an argument is a restore only when that path exists in the cwd, which
  is how Git settles the ambiguity; `feat/x`, `origin/main` and a bare `develop` are refs.
  `git checkout <ref> -- <path>` and `git checkout -- <path>` are always restores. Every
  segment of a compound command counts, so an allowed switch never hides a later one.
- **Everything else passes**: `git status`, every `git branch` form — creating, moving,
  copying, deleting or listing a branch changes no checkout — `git restore`,
  `git worktree remove|prune|move`, and every tool but `bash`.
- `ODD_WORKTREE_GUARD=0` turns them off for the process, like `ODD_WORKTREE_PROMPT=0`
  for the prompt blocks. No other value does, and nothing else configures them.

## The `## ODD worktrees` block in the system prompt

The primary session's system prompt gains a short section that opens with the rule the
rest hangs from: an ODD writes only in its own worktree, never in the primary checkout or
on the default branch, and the feature branch lives there (reading anywhere is fine, and a
request that stays read-only needs no worktree). It then tells the agent where a worktree
lives and that the directory is the ODD it serves, to call `worktree_list` before the ODD's
first write (work in the ODD's worktree when it has one, `worktree_create` it when it has
none), to carry the current checkout's pending changes that belong to that work with
`copy_changes`, that an ODD is one request and its follow-ups, big or small, with one
worktree (an unrelated request is another ODD), to delegate the ODD's independent units of
behavior to agents in parallel, each with the `workspace_root` of that ODD's worktree and
never two on the same file, and that after the merge the default branch is always updated,
then the checkout is removed with its branch kept, unless its tree is dirty or a live
session stands in it. Moving the session stays the human's.

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
proof, and keep the other tools for what it does not index. The orchestrator's text also
sizes a change with the graph only when one read batch does not already explain it (a
known file or location needs no call), and points its look at the ODD's own worktree
through `projectPath` when the session runs elsewhere; the explorer's text gives its
second look a stop. Each role gets its
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

**A call that failed earns nothing.** A `grep` that errored or a `read` that found no such
file returned nothing the model could read, so no reminder rides that error result, no once-per-key
slot is spent, and a failed `codegraph` or `explore` call does not count as a use of the graph. The
next call that does answer is still reminded.

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
it, and [the design](#the-cards-the-activity-design-paints) may head it with the
classifier's `codegraph` identity.

## Deliberately absent

This package is the worktree / ODD / files / issues surface only: two agent
tools, four panels, one optional rail section and two tool designs on the bridge,
no preference of its own, no customize panel, no plugin-tools
toggles, no CodeGraph command or tool (only the prompt advice above), no
companion-app integration, and no worktree↔issue association. Its
customize-side contribution is the two values of the bridge's `Cards` page — `activity` on
the `Card tags` line (or its `Card bash` line, on a bridge older than 0.6.0) and `color` on
the `Card diff` line — which the skill/ODD file cards obey as well. It adds no command, tool
or row of its own, and the file
picker's `alt+p` and the issues panel's `alt+i` are bound on the host directly
rather than contributed to any shell surface. There is
nothing to configure here, and `/warp`, `/odd`, `/files` and `/issues` are always on. Paths, branches and arguments reach `git` and `gh` as fixed argv arrays,
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
`package.json` version — version 3.1.1 is `v3.1.1` — and preflight stops the run
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
