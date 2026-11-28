# pi-odd-worktree

A Pi package that gives an agent session Git worktrees, ODD documents, GitHub issues and pull requests, and draws their cards inside Gentle Shell.

## What It Does

Two agent tools, five panels, the `/identity` command, two sidebar sections and two tool designs, loaded from one extension entry point. Each ODD feature gets its own checkout beside the clone, and you move between checkouts and read your ODD documents, files, issues and pull requests without leaving Pi.

| Surface | Kind | What it does |
| --- | --- | --- |
| `worktree_create` | tool | Creates `<repo-parent>/<repo-name>-worktrees/<odd>` on a branch, prepares it and starts its install in the background. |
| `worktree_list` | tool | Read-only list of the checkouts this package created, each by its ODD and branch. |
| `/warp` | panel | Moves this session to another checkout, creates one, and removes one. |
| `/odd` | panel | Reads `odd/tasks/*.md`: list on the left, styled markdown on the right — ONE flat listing, newest document first, each row carrying `main` or the worktree's own name at its right the way the `ODD` rail does, and the model behind it keeps one copy per ODD name across main and the registered worktrees: identical bytes leave main's copy, different bytes the most recently modified one, and with no copy in main identical copies the ODD's own worktree. `a` widens the candidates from the session's checkouts to every worktree, folding nothing. One optional target — an ODD name or an ODD's name or the absolute path of a document that main or a worktree the session registered lists — opens it on that ODD; anything else is refused. |
| `/files` | panel | Browses one checkout's files with a live, language-coloured preview: `enter` pastes the chosen paths into your prompt, `ctrl+e` opens the file in `$EDITOR`. |
| `/identity` | command | Stores your name: `/identity Jona` heads your prompt cards with it instead of `You` and appends one line about it to the orchestrator's prompt, `/identity clear` unsets it, and `/identity` alone says which name is stored. |
| `/issues` | panel | Reads this checkout's GitHub issues — the three scoped tabs on open, every open issue behind `g` — and, when your role allows it, edits them. `enter` inserts the focused issue into the chat input as `ISSUE #63`, and each linked pull request in the pane is its own click that opens that pull request in `/prs`. |
| `/prs` | panel | The same reader for pull requests: `My Pull Request`, `Needs My Review` and `Involved` on open, every open pull request of the repository behind `g`, the pane's `Changes` and `Checks` summaries, and — when your role allows it — comment, labels, assignees, the linked issues, merge (after a confirmation naming the method and the commit message) and close. `enter` inserts the focused pull request as `PR #87`, and each linked issue in the pane is its own click that opens that issue in `/issues`. |
| `GITHUB` rail section | sidebar section | Lists the open issues of this checkout's repository you authored or are assigned, seven at a time plus a count of the rest, and its header counts the pull requests beside them (`7 issues · 3 pr`: your own plus the ones awaiting your review). A click opens that issue in `/issues` on `Assigned` — or, when the issue carries a linked pull request, that pull request in `/prs` on the bucket it belongs to; the overflow row opens `/issues`. Needs `gh`. |
| `ODD` rail section | sidebar section | Lists the ODDs this session is ASSOCIATED with — the ones it (or a subagent it ran) wrote or edited, rebuilt from its own active branch, so old and resumed sessions show theirs too — four at a time plus a count of the rest, right after the host's `AGENTS` part. One row per ODD name across main and the worktrees the session registered, with `main` or the worktree's own name at the far right saying which copy the click opens (the one the grouped model elected: main's when the bytes are identical, the most recently modified when they differ, the ODD's own worktree when main has none and the copies agree), and with nothing associated it draws one dim `no ODD associated` line instead of listing the disk. A click opens `/odd` on that document; the associated ODDs this session wrote or edited come first. Does not need `Worktrees+`: registration is what scopes it. Needs the rail a Gentle Shell draws. |
| `activity` card design | design on the shell API's `Card activity` line | Optional, and selected for you on the first run: a bash card's heading names the activity its command does, each family in its own theme colour, and — while that line answers for the tool being painted — the skill/ODD file cards, the background-job cards and the two advisory messages follow it. The user prompt card does NOT: it follows this package's own `Card message` switch. |
| `Card message` switch | Off/On line on `Cards`, this package's own | On by default, and it repaints live: On draws the user prompt and the assistant's final answer as cards and appends the `## User identity` block when a name is stored; Off leaves Pi's own prompt and Pi's own answer, and sets nothing of `/identity` aside. Its document is `card-message` in the shell API's own store. |
| `color` design | design on the shell API's `Card file` line | Optional, and selected for you on the first run: redraws `write` and `edit` as an IDE pane — a write's content behind a line-number gutter, an edit's diff — in the active theme's own syntax roles, and gives a `read` outside `skills/` and `odd/` the same gutter, highlight and `…` clip. |

Moving the session and removing a checkout are human actions: only `/warp` does either, and no agent tool can. A checkout has one identity, its ODD: the directory name is the ODD it serves, and `branch` is only the git branch.

## Quick Start

### Requirements

| Requirement | Why it is needed |
| --- | --- |
| Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) | Peer dependencies supplied by the host; the package installs no runtime dependencies. |
| Node.js >= 18 and `git` | Every repository operation is a `git` child process. |
| Gentle Shell (`gentle-pi`) | Supplies the session records the deletion guard reads to see other sessions, the rail the `GITHUB` and `ODD` sections are drawn in, the `/gentle:customize` command the shell API checks before it arms any row, section or design, and the host theme those draw with. Without it the six commands, the two tools and this package's own cards still load; the customize rows, both rails and the `Card activity`/`Card file` designs stay off, and the package says so once, naming `gentle-pi`. |
| `gh`, authenticated (`gh auth login`) | `/issues`, `/prs` and the `GITHUB` rail section, and them alone. Without `gh` on `PATH` none of the three is registered at all — `/issues` and `/prs` never load and the section is never added to the rail, so there is nothing to refuse and no line to draw — and every other surface keeps working. |

### Install

`pi-odd-worktree` is the only install. It carries its own extension point for gentle-shell —
the shell API in `lib/shell-api/` — so nothing else goes first and no second plugin is needed.

```bash
pi install npm:pi-odd-worktree
```

Inside a Gentle Shell session use its launcher:

```bash
gentle-shell install npm:pi-odd-worktree
```

From a local clone, `pi install .` installs the working copy, and `gentle-shell install .` does the same from inside a Gentle Shell session.

The shell API ships inside this package, so no second package is needed.

### Expected result

`/warp`, `/odd`, `/files`, `/identity`, `/issues` and `/prs` are available as commands — `/issues`
and `/prs` only where `gh` is on `PATH` — the agent is offered `worktree_create` and
`worktree_list`, a Gentle Shell whose rail is drawn shows a `GITHUB` section for this checkout and an
`ODD` section listing the ODDs the session is working on, and its `/gentle:customize` → `Cards` page
offers `activity` on its `Card activity` line and `Card message` as this package's own Off/On switch.

### Shell API version

The shell API this package publishes reports `VERSION` `0.16.2`, so every floor the
[reference](docs/reference.md) names below it is already satisfied. The per-version notes there
describe gates that exist in the code, not a choice you make at install time.

## Extend gentle-shell through odd-worktree

A plugin reaches gentle-shell through this package alone. Read the slot:

```ts
const api = globalThis[Symbol.for("odd-worktree/shell-api/v1")];
```

Its identity is `schema: "odd-worktree/shell-api"`, `version: 1` and `VERSION` `0.16.2`, and it
offers settings rows and pages, sidebar sections, card styles, transcript transforms, per-tool and
per-message card designs, a repaint request and a small namespaced store. The contract is
[`docs/shell-api/contract.md`](https://github.com/jonasotoaguilar/odd-worktree/blob/main/docs/shell-api/contract.md),
with
[`architecture.md`](https://github.com/jonasotoaguilar/odd-worktree/blob/main/docs/shell-api/architecture.md),
[`state.md`](https://github.com/jonasotoaguilar/odd-worktree/blob/main/docs/shell-api/state.md) and a
worked example in
[`examples/bash-card.ts`](https://github.com/jonasotoaguilar/odd-worktree/blob/main/docs/shell-api/examples/bash-card.ts);
start at [`docs/shell-api/README.md`](https://github.com/jonasotoaguilar/odd-worktree/blob/main/docs/shell-api/README.md).
Those pages live in the repository, not in the published tarball.

The surfaces are still DRAWN by `gentle-pi`, the package registering `/gentle:customize`: without it
the API arms nothing, and this package says so once, naming `gentle-pi` and the rows, sections and
designs that are off. If another plugin published an incompatible object on the slot first, the
package registers no surface at all — its commands and tools included — and it says that once too,
naming the slot and the schema and version it actually holds. Neither message is silent, and in the
first case everything but the shell surfaces keeps working.

## Core Workflow

1. **Create** a checkout with `worktree_create` (an `odd` and a `branch`) or press `c` in `/warp`. It answers at once; the install continues in the background.
2. **List** with `worktree_list` or by opening `/warp`.
3. **Move** with `/warp <name>`, or pick a checkout in the selector.
4. **Delete** with `ctrl+d` on a checkout in `/warp`, after its confirmation.

The full rules of each step, including every refusal, are in [Create, list, move and delete, in detail](docs/reference.md#create-list-move-and-delete-in-detail).

## Key Capabilities

- **Three halves are optional.** On the shell API's `Tools` page in `/gentle:customize` there is an Off/On line for `Codegraph+` (the CodeGraph prompt text, reminders and wiring; its card follows the `Card activity` line like every other card), one for `Worktrees+` (the worktree tools, `/warp`, the worktree guards and prompt text) and one for `Skills+` (the skill-read guard and the whole-read rule for a skill's or an ODD's Markdown). `Codegraph+` and `Worktrees+` are On by default and `Skills+` is Off until you turn it on; a change needs `/reload` and a new session. See [the module switches](docs/reference.md#the-module-switches).
- **OpenCode Go usage comes built in, and every peak window has its own switch.** The `opencode-go` provider is registered on Gentle Shell's own usage event, so `/gentle:usage`, the status-bar segment and the panel's `r` refresh work exactly as they do for the providers the shell ships. Claude usage arrives the same way, under both provider ids `anthropic` and `claude-bridge` — one source per id, and one account answers once per refresh so the second id never repeats the numbers — reading the token from the Claude Code credentials file (or the key pi already holds), drawing `claude 5h` / `claude 7d`, and carrying the subscription tier when the file offers one: `max · off-peak 1d 17hr`. Above the editor, one row per provider whose peak window is running, in the registry's order: `peak · 2× deepseek · until 04:00` (OpenCode Go bills DeepSeek at double rate in weekdays 01:00–04:00 and 06:00–10:00 UTC) and `peak · claude · until 10:00` (weekdays 05:00–11:00 Pacific; Anthropic publishes no price multiplier there — the subscription window drains faster instead). A row never depends on the model the session uses or on a usage key: only that provider's switch and its window matter. `/gentle:customize` → `Alert`, between `Notifications` and `Layout`, holds one Off/On line per provider — `Deepseek peak`, `Claude peak` — **all Off on a first run**, applied without `/reload`. A third provider costs no change outside the registry. See [the usage source and the peak rows](docs/reference.md#the-opencode-go-usage-source-and-the-peak-rows-above-the-editor).
- **A create is instant and writes no state.** The directory is the whole record; there is no list file and no lock file.
- **Deleting refuses on a live session.** The guard reads Gentle Shell's presence records, discloses what it could not resolve, and never auto-warps. Removal is `git worktree remove` and the branch is kept. See [the deletion guard](docs/reference.md#the-deletion-guard-and-its-honest-limit).
- **A warp is queued, never dropped.** While this session's tools, agent tasks or background jobs are still running, `/warp` keeps the request pending and moves when they finish. See [the queued warp](docs/reference.md#a-warp-waits-for-this-sessions-own-tools-agent-tasks-and-background-jobs).
- **`/files` lists one checkout's files and pastes them.** It always asks for a checkout first — `main` included, even with nothing else registered — with `a` widening the list to every worktree Git lists for the clone; `ctrl+o` cycles `files`, `tree` and `ext`. The preview is read-only, bounded and coloured from your active theme, `enter` inserts `@`-prefixed paths (a file of another checkout travels as its absolute path), and `ctrl+e` opens the highlighted file in `$VISUAL`/`$EDITOR`. `alt+p` opens the picker from anywhere, and `GENTLE_PI_FILES_KEY` overrides the key. See [the file picker](docs/reference.md#files-the-picker-its-scopes-and-its-orders).
- **`/issues` opens on three tabs, not four.** The bar is `My issues`, `Assigned` and `Involved`; `All` is the `g` shortcut's own view, with the footer saying `g all issues` outside it and `g related issues` inside. A typed filter spans the three tabs and travels with you into `All`. `alt+i` opens the panel from anywhere, and `GENTLE_PI_ISSUES_KEY` overrides the key. See [the tabs, the shortcut and the filter](docs/reference.md#issues-three-tabs-one-shortcut-one-filter).
- **`/prs` is the same reader for pull requests.** Its three tabs are `My Pull Request`, `Needs My Review` and `Involved`, `All` is again the `g` shortcut's own view (there the footer reads `g related prs`), the search box reads the server like `/issues`, and `enter` inserts the focused pull request into the chat input as `PR #87` and closes the panel — nothing is sent to the agent. The pane opens with the state, labels, assignees, reviewers with their review state, author and ages, the linked issues and the two summaries `Changes` (`3 files changed +40 -5`, `7 commits`) and `Checks` (`5 checks · 1 failed`, `failing: build`). See [the `/prs` panel](docs/reference.md#prs-the-pull-request-panel).
- **`/prs` writes only what your role allows.** Commenting needs read access alone; labels and assignees need triage; closing, merging and editing the linked issues need write, and `m` is offered only for a pull request that is not a draft and a repository that allows at least one merge method. Anything but a confirmed capability paints no hint and refuses the key on screen. Merge is its own step — type (only the methods the repository allows), commit message, description, `Confirm merge #N` / `Cancel` — prefilled with GitHub's own proposals, and a rebase merge takes neither the message nor the description. See [the actions, gated by capability](docs/reference.md#the-prs-actions-gated-by-capability).
- **`/issues` and `/prs` link to each other.** In the issues pane every linked pull request number is its own click that opens `/prs` on it; in the pull request pane every linked issue number is its own click that opens `/issues` on it. The panel you clicked in closes first, so two panels never stack, and a line's label, its separators and a `#N` in a title or a body are not click targets. A linked reference is identified by repository AND number, so one that belongs to another repository is painted as `owner/repo#N` and is not a click at all: a same-numbered lookalike here is never opened by mistake. See [the cross-links](docs/reference.md#the-cross-links-between-the-two-panels).
- **`/issues` can open on one issue.** `/issues 42` (or `/issues #42`) opens the panel on `Assigned` with that issue selected, and a number that tab cannot find says so instead of guessing a row. `prs`'s sibling form is `/prs 42` (or `/prs #42`), which opens on `My Pull Request` with that pull request selected — on `Needs My Review` when a rail click named that bucket, saying `#42 is not in My Pull Request` when neither holds it.
- **`/issues` and `/prs` pin the repository.** Every read, mutation and browser open is bound to the repository that was loaded, and capabilities fail closed. See [the repository pin](docs/reference.md#issues-pins-the-repository).
- **The GitHub rail is checkout-scoped and optional.** When a Gentle Shell draws its rail, a `GITHUB` rail section lists the open issues of this checkout's repository you authored or are assigned — that one repository, not every issue across every repository you touch — seven at a time, with `and N more issues` for the rest and a pull-request mark on the issues that already have one, and its header counts the pull requests beside them (`7 issues · 3 pr`, the distinct rows of your own and the ones awaiting your review; the segment appears once that read lands, and a stalled list still reads `· stale`). A click on an issue that carries a linked pull request opens `/prs` on that pull request — `Needs My Review` winning when it belongs to both buckets, `My Pull Request` next, and the `all` view when the rail's read places it in neither — instead of the issue; every other row opens that issue in `/issues` on `Assigned`, in no case a browser. The click does not prove the repository itself — the panel it opens pins and proves the checkout, so a row left over from another checkout still dispatches its number and the panel decides — and `/issues`' own `o` key is still the browser. The overflow row opens `/issues` with no number. While the rail's cache holds this repository, `/issues` paints its first frame from it and reads one tab at mount instead of three, the other two reading the first time you open them; the cache outlives both the session and the process — one document under `$XDG_CACHE_HOME/odd-worktree/` — so a warm checkout's first read is already a delta, and the rail's pull requests are persisted the same way (`prs-rail.json`) so a cold start paints `N issues · M pr` at once. A frame never waits on `gh`, and neither does a session start: the `gh` gate is dispatched, never awaited, so no child process and no network call sits on opening or switching a session. While the section is drawn it re-reads on its own 20 s timer — the issues and the pull requests behind the same floor — keeps no timer while hidden, stops the moment it is no longer drawn, and a `bash` command that mutates an issue or a pull request forces one read behind a 5 s cap; a failed refresh keeps the rows and marks them `stale`, and a failed pull-request read keeps the count already painted. Without `gh` on `PATH` neither the section nor `/issues`/`/prs` exists at all — the commands are never registered and the section is never added to the rail — and every other surface keeps working. A host whose rail is not drawn registers the section and never paints it. See [the rail section](docs/reference.md#the-github-rail-section).
- **The ODD rail lists what this session is working on — and nothing else.** A second section, titled `ODD` and placed right after the host's own `AGENTS` part, lists ONLY the ODDs this session is associated with, four at a time, with `<N> more` for the rest, as ONE row per ODD name, never one per checkout: when the same ODD exists in main and in a worktree the row's right-hand gray cell says which copy the click opens, `main` or the worktree's own name, and the copy on offer is the ONE the grouped model elected: main's when the bytes are identical, the most recently modified when they differ, and the ODD's own worktree — the checkout named after it — when main has none and the copies agree. The association is by ODD name and is rebuilt from the session's own ACTIVE branch, so an old session written before the touch entry existed and a resumed one both show their ODDs: a successful `write`/`edit` on `odd/tasks/<name>.md`, the session's persisted touch entries, a subagent's `files_changed:` report and the `Spec:` line of the subagent task that started it (a subagent's write counts for the parent), while a failed write and an abandoned branch's work do not count. A document this session just wrote shows at once. A new session is associated with nothing on disk, so the body is ONE dim `no ODD associated` line instead of a bare box. The checkouts are the worktrees this session registered — the same session entries `/odd`, `/files` and this section all read — so a registered worktree whose `odd/tasks` has nothing new or different from main contributes nothing, a worktree registered only on an abandoned branch is out of scope, and the section keeps working with `Worktrees+` off. The associated ODDs this session wrote or edited come first and force an immediate re-read; attribution is the filter AND the order, and the grouped model still decides what exists and where. The `/odd` panel draws the same election as one flat listing, each row naming the checkout that holds it, so a name is drawn once there too and a worktree chained off another feature branch draws only the ODDs it wins, never the ones it inherited. A click sends `/odd <document>` to the host, so the panel opens on exactly that ODD, and a second click while an open is in flight does nothing. See [the ODD rail section](docs/reference.md#the-odd-rail-section).
- **Cards follow your shell.** Tool and warp cards use the card style Gentle Shell publishes, and a click expands that card only. See [card style](docs/reference.md#card-style-follows-your-shell).
- **Tool headings can name the activity.** With `activity` chosen on the `Card activity` line, a bash card whose heading shows the whole command is headed with the family its command names instead of `$`, and a `grep`, `find` or `ls` card is headed `⌕ exploring`; a command the classifier cannot name, or a heading that hides part of it, keeps the host's `$`. See [the cards the `activity` design paints](docs/reference.md#the-cards-the-activity-design-paints).
- **File calls on a skill or an ODD are cards too.** While that line answers with `activity` for the tool being painted, a `read`, `edit` or `write` whose path names a skill or an ODD heads as that file — its own mark and label, the tool, the path and a read's line range — and its Markdown body is drawn by Pi's own renderer in the theme's Markdown roles. Any other file call is the host's own row, except a `read` while `Card file` answers `color`. See [the file cards](docs/reference.md#the-file-cards).
- **Background-job tools are cards too.** While that line answers with `activity`, `bash_background`, `monitor`, `job_stop` and `job_list` are drawn in the shell's own card style instead of Pi's plain box, with the job's label, its command and its own answer. See [the jobs card](docs/reference.md#the-jobs-card).
- **The two advisory messages are cards too.** `gentle-pi.exploration-budget` and `gentle-pi.verifier-settle-reminder` are drawn as `⌕ Exploration budget` and `⚑ Verifier reminder`, the whole body at every content level. They follow that `Card activity` line, with no second switch and no row added to `Cards`. See [the message cards](docs/reference.md#the-message-cards).
- **Your own prompt can be a card too.** While this package's `Card message` switch is On — its own Off/On line on `/gentle:customize` → `Cards`, On by default — the message you sent is drawn as a `✿ Jona` card — your own name, stored with `/identity`, and `You` while none is stored, the title and the whole frame in the accent role, in whichever card style your shell uses — instead of Pi's plain background block, in the prompts already on screen too, because a name set or cleared and the switch itself repaint them. The `Card activity` line no longer decides this card. It is one of the two host classes this package patches, because Pi offers no hook for a `role: "user"` entry: switch `Card message` to Off and the prompt is Pi's own again, live, byte for byte. `/identity` keeps working whatever the switch says; without a published shell API the card stays off. See [the card message switch](docs/reference.md#the-card-message-switch) and [the user prompt card](docs/reference.md#the-user-prompt-card).
- **The assistant's final answer is a card too.** While `Card message` is On, a message that made no tool call — the final answer of a turn, in a resumed or an old session too — is drawn as `✿ Gentleman · 21:53 (17 turns · 58m20s)`: the fixed name, the time it answered, and how much work that answer closes, from the session history between the previous input and that answer. Frame and title wear the theme role the `checking` heading uses. Intermediate messages, a message with tool calls, and every answer while the switch is Off stay Pi's own, byte for byte. See [the assistant answer card](docs/reference.md#the-assistant-answer-card).
- **The `color` design is a card of the same kind.** `Card file` keeps `default` available and selects `color` once on the first run that finds no choice, so a write or an edit on a skill or an ODD stays the file card's row, because a specific claim wins over a generic one. It is also what draws a `read` outside `skills/` and `odd/`: the line supplies that read's selection, the file card draws it with the `write` pane's own gutter, syntax highlight and `…` clip — a `.md` file there is just a language — and the design itself claims no `read`, so one call is still drawn once. See [the Card file line](docs/reference.md#the-card-file-line) and [a read outside skills and ODD](docs/reference.md#a-read-outside-skills-and-odd).
- **`edit` and `write` cannot land in the principal checkout's default branch.** A write whose path is inside the principal checkout of the session's repository, while that checkout is on the default branch, is refused with one line pointing at `worktree_list` and `worktree_create`. Paths outside the repository, anything under the OS temp directories, ODD artifacts, other repositories and linked worktrees are never blocked. See [the guard](docs/reference.md#the-edit-and-write-guard).
- **A skill or an ODD is read whole.** A `read` of a `.md` below a `skills/` or an `odd/` folder drops its `offset` and `limit` before the tool runs, so the call delivers the whole document and never half a procedure. It follows the `Skills+` module, which is Off by default, like the other skill rule.
- **`bash` cannot leave the principal checkout's default branch.** A `git worktree add` is refused in any cwd and pointed at `worktree_create`; in the principal checkout, a switch that would leave the branch it is on is refused while that branch is the repository's default, and creating a branch is not blocked. See [the guards](docs/reference.md#the-bash-guards).
- **Three blocks in the system prompt.** `## ODD worktrees` tells the agent how worktrees and ODDs work. `## CodeGraph` tells a session that already holds a CodeGraph tool how to use it, with one text per role. `## User identity` states your name in one line, and it is there only while a name is stored AND the `Card message` switch is On; its text lives in `lib/identity-prompt/user-identity.md` with `{{name}}` where the name goes. All three are appended after the host's own text; `ODD_WORKTREE_PROMPT=0` suppresses the first two, and the third is the stored name's and the switch's business together. See [the prompt block](docs/reference.md#the--odd-worktrees-block-in-the-system-prompt) and [the user identity block](docs/reference.md#the--user-identity-block-in-the-system-prompt).
- **CodeGraph stays fresh, only when its CLI is installed.** At session start the package creates or syncs the checkout's index and warms its daemon, and makes sure your global `mcp.json` has the `codegraph` entry. It also syncs after a compaction, after a native `codegraph init` and after an `edit` or `write`, in the background and without ever blocking you. See [CodeGraph](docs/reference.md#codegraph-index-daemon-and-mcp-entry).
- **Two reminders keep a session on the CodeGraph rule.** The first `grep`, `find`, `ls`, `read` or `bash` search in a checkout gets one sentence appended to its result: use `codegraph` first, or — for another checkout — call `mcp__codegraph__codegraph_explore` with that path as `projectPath`. Neither is ever a block, and a subagent child hears neither. See [the reminders](docs/reference.md#the-two-codegraph-reminders).
- **Deliberately absent.** No customize panel of its own, no plugin-tools toggles, no companion-app integration and no worktree-to-issue association. There is nothing to configure here: the card designs are chosen on the shell API's own lines, so this package owns no preference of its own. See [deliberately absent](docs/reference.md#deliberately-absent).

## Documentation

| Your task | Start here |
| --- | --- |
| Look up a panel key | [Panel keys](docs/reference.md#panel-keys) |
| Read, merge or close a pull request | [`/prs`](docs/reference.md#prs-the-pull-request-panel) |
| Understand a create, a warp or a delete in detail | [Reference](docs/reference.md) |
| Run the suite or see what CI and releases do | [Tests](docs/reference.md#tests), [CI and releases](docs/reference.md#ci-and-releases) |
| Change the package, follow its invariants or cut a release | [`docs/codebase/mental-model.md`](docs/codebase/mental-model.md) |
| Extend gentle-shell from your own plugin | [`docs/shell-api/README.md`](https://github.com/jonasotoaguilar/odd-worktree/blob/main/docs/shell-api/README.md), then [`contract.md`](https://github.com/jonasotoaguilar/odd-worktree/blob/main/docs/shell-api/contract.md) |
| Report a bug or request a feature | [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) |
| Open a pull request | [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) |

## Next Steps

- Run `/warp` in a repository with at least one other checkout to see the selector, then `worktree_list` from the agent to confirm both surfaces agree.
- Install `gh` and run `gh auth login` once if you want `/issues`, `/prs` and the `GITHUB` rail section.
- Read [the reference](docs/reference.md) before changing a panel key, a guard or a card.

## License

[MIT](LICENSE) © 2026 Jonathan Soto.
