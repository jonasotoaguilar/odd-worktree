# pi-odd-worktree

A Pi package that gives an agent session Git worktrees, ODD documents, GitHub issues and pull requests, and draws their cards inside Gentle Shell.

## What It Does

Two agent tools, five panels, the `/identity` command, two sidebar sections and two tool designs, loaded from one extension entry point. Each ODD feature gets its own checkout beside the clone, and you move between checkouts and read your ODD documents, files, issues and pull requests without leaving Pi.

| Surface | Kind | What it does |
| --- | --- | --- |
| `worktree_create` | tool | Creates `<repo-parent>/<repo-name>-worktrees/<odd>` on a branch, prepares it and starts its install in the background. |
| `worktree_list` | tool | Read-only list of the checkouts this package created, each by its ODD and branch. |
| `/warp` | panel | Moves this session to another checkout, creates one, and removes one. |
| `/odd` | panel | Reads `odd/tasks/*.md`: list on the left, styled markdown on the right — main's whole listing, plus one collapsible group per worktree the session registered with only what that worktree has that main does not, and `a` toggles between the session's checkouts and every worktree. One optional target — an ODD name or an ODD's name or the absolute path of a document that main or a worktree the session registered lists — opens it on that ODD; anything else is refused. |
| `/files` | panel | Browses one checkout's files with a live, language-coloured preview: `enter` pastes the chosen paths into your prompt, `ctrl+e` opens the file in `$EDITOR`. |
| `/identity` | command | Stores your name: `/identity Jona` heads your prompt cards with it instead of `You` and appends one line about it to the orchestrator's prompt, `/identity clear` unsets it, and `/identity` alone says which name is stored. |
| `/issues` | panel | Reads this checkout's GitHub issues — the three scoped tabs on open, every open issue behind `g` — and, when your role allows it, edits them. `enter` inserts the focused issue into the chat input as `ISSUE #63`, and each linked pull request in the pane is its own click that opens that pull request in `/prs`. |
| `/prs` | panel | The same reader for pull requests: `My Pull Request`, `Needs My Review` and `Involved` on open, every open pull request of the repository behind `g`, the pane's `Changes` and `Checks` summaries, and — when your role allows it — comment, labels, assignees, the linked issues, merge (after a confirmation naming the method and the commit message) and close. `enter` inserts the focused pull request as `PR #87`, and each linked issue in the pane is its own click that opens that issue in `/issues`. |
| `GITHUB` rail section | sidebar section | Lists the open issues of this checkout's repository you authored or are assigned, seven at a time plus a count of the rest, and its header counts the pull requests beside them (`7 issues · 3 pr`: your own plus the ones awaiting your review). A click opens that issue in `/issues` on `Assigned` — or, when the issue carries a linked pull request, that pull request in `/prs` on the bucket it belongs to; the overflow row opens `/issues`. Needs `gh`. |
| `ODD` rail section | sidebar section | Lists the ODDs this session is ASSOCIATED with — the ones it (or a subagent it ran) wrote or edited, rebuilt from its own active branch, so old and resumed sessions show theirs too — four at a time plus a count of the rest, right after the host's `AGENTS` part. One row per ODD name across main and the worktrees the session registered, with `main` or the worktree's own name at the far right saying which copy the click opens (the most recently modified one; `main` breaks an exact tie), and with nothing associated it draws one dim `no ODD associated` line instead of listing the disk. A click opens `/odd` on that document; the associated ODDs this session wrote or edited come first. Does not need `Worktrees+`: registration is what scopes it. Needs gentle-shell-bridge with its rail. |
| `activity` card design | design on the bridge's `Card activity` line | Optional, and selected for you on the first run: a bash card's heading names the activity its command does, each family in its own theme colour, and — while that line answers for the tool being painted — the skill/ODD file cards, the background-job cards and the two advisory messages follow it. |
| `color` diff design | design on the bridge's `Card diff` line | Optional, and selected for you on the first run: redraws `write` and `edit` as an IDE pane — a write's content behind a line-number gutter, an edit's diff — in the active theme's own syntax roles. |

Moving the session and removing a checkout are human actions: only `/warp` does either, and no agent tool can. A checkout has one identity, its ODD: the directory name is the ODD it serves, and `branch` is only the git branch.

## Quick Start

### Requirements

| Requirement | Why it is needed |
| --- | --- |
| [`gentle-shell-bridge`](https://github.com/jonasotoaguilar/gentle-shell-bridge), installed **first** | Every surface this package registers. Without it the package loads nothing at all — no command, no tool, no card, no rail — and only names that install line, in a primary session. |
| Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) | Peer dependencies supplied by the host; the package installs no runtime dependencies. |
| Node.js >= 18 and `git` | Every repository operation is a `git` child process. |
| Gentle Shell (recommended) | Supplies the session records the deletion guard reads to see other sessions, and the rail the `GITHUB` and `ODD` sections are drawn in. |
| `gh`, authenticated (`gh auth login`) | `/issues`, `/prs` and the `GITHUB` rail section, and them alone. Without `gh` on `PATH` none of the three is registered at all — `/issues` and `/prs` never load and the section is never added to the rail, so there is nothing to refuse and no line to draw — and every other surface keeps working. |

### Install

`gentle-shell-bridge` goes first: it is the API every surface of this package is registered through.

```bash
# 1. the bridge, a prerequisite for every surface here
pi install npm:gentle-shell-bridge

# 2. this package
pi install npm:pi-odd-worktree
```

Inside a Gentle Shell session use its launcher, in the same order:

```bash
gentle-shell install npm:gentle-shell-bridge
gentle-shell install npm:pi-odd-worktree
```

From a local clone, `pi install .` installs the working copy, and `gentle-shell install .` does the same from inside a Gentle Shell session.

### Expected result

`/warp`, `/odd`, `/files`, `/identity`, `/issues` and `/prs` are available as commands — `/issues` and `/prs` only where `gh` is on `PATH` — the agent is offered `worktree_create` and `worktree_list`, a Gentle Shell whose rail is drawn shows a `GITHUB` section for this checkout and an `ODD` section listing the ODDs the session is working on, and its `/gentle:customize` → `Cards` page offers `activity` on its `Card activity` line.

### Bridge versions

Older bridges register less, never something different:

| Bridge | What it can hold |
| --- | --- |
| `0.5.0` | One `Card bash` row, bash alone; `activity` still heads a bash card with the family its command names. |
| `0.6.0` | One `Card activity` row over `bash`, `grep`, `find`, `ls` and `read`; the file card's question arrives in `0.7.0`. |
| `0.9.0` | The scoped claim that puts `write` and `edit` on the `activity` line, and the `Card diff` line itself. |
| `0.12.1` | The two advisory message cards, which follow the `Card activity` line with no row of their own. |

Below a row's floor the surface registers nothing and Pi's own card stays byte-identical. The `Card activity` line and, with it, every card that follows it are documented in [the reference](docs/reference.md#the-cards-the-activity-design-paints).

## Core Workflow

1. **Create** a checkout with `worktree_create` (an `odd` and a `branch`) or press `c` in `/warp`. It answers at once; the install continues in the background.
2. **List** with `worktree_list` or by opening `/warp`.
3. **Move** with `/warp <name>`, or pick a checkout in the selector.
4. **Delete** with `ctrl+d` on a checkout in `/warp`, after its confirmation.

The full rules of each step, including every refusal, are in [Create, list, move and delete, in detail](docs/reference.md#create-list-move-and-delete-in-detail).

## Key Capabilities

- **Two halves are optional.** With `gentle-shell-bridge`, `/gentle:customize` has a `Tools` page with an Off/On line for `Codegraph+` (the CodeGraph prompt text, reminders and wiring; its card follows the `Card activity` line like every other card) and one for `Worktrees+` (the worktree tools, `/warp`, the worktree guards and prompt text). Both are On by default; a change needs `/reload` and a new session. See [the module switches](docs/reference.md#the-module-switches).
- **OpenCode Go usage comes built in, and its peak alert has its own switch.** The `opencode-go` provider is registered on Gentle Shell's own usage event, so `/gentle:usage`, the status-bar segment and the panel's `r` refresh work exactly as they do for the providers the shell ships; the panel's provider line carries the DeepSeek peak/off-peak schedule. While the window is peak, one row above the editor reads `peak · 2× deepseek · until 04:00`. `/gentle:customize` → `Alert`, between `Notifications` and `Layout`, holds the one line `Deepseek peak`: On by default, and Off withholds that row and nothing else, applied without `/reload`. See [the usage source and the peak row](docs/reference.md#the-opencode-go-usage-source-and-the-deepseek-peak-row).
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
- **The GitHub rail is checkout-scoped and optional.** When a Gentle Shell draws its rail, a `GITHUB` rail section lists the open issues of this checkout's repository you authored or are assigned — that one repository, not every issue across every repository you touch — seven at a time, with `and N more issues` for the rest and a pull-request mark on the issues that already have one, and its header counts the pull requests beside them (`7 issues · 3 pr`, the distinct rows of your own and the ones awaiting your review; the segment appears once that read lands, and a stalled list still reads `· stale`). A click on an issue that carries a linked pull request opens `/prs` on that pull request — `Needs My Review` winning when it belongs to both buckets, `My Pull Request` next, and the `all` view when the rail's read places it in neither — instead of the issue; every other row opens that issue in `/issues` on `Assigned`, in no case a browser. The click does not prove the repository itself — the panel it opens pins and proves the checkout, so a row left over from another checkout still dispatches its number and the panel decides — and `/issues`' own `o` key is still the browser. The overflow row opens `/issues` with no number. While the rail's cache holds this repository, `/issues` paints its first frame from it and reads one tab at mount instead of three, the other two reading the first time you open them; the cache outlives both the session and the process — one document under `$XDG_CACHE_HOME/odd-worktree/` — so a warm checkout's first read is already a delta, and the rail's pull requests are persisted the same way (`prs-rail.json`) so a cold start paints `N issues · M pr` at once. A frame never waits on `gh`, and neither does a session start: the `gh` gate is dispatched, never awaited, so no child process and no network call sits on opening or switching a session. While the section is drawn it re-reads on its own 20 s timer — the issues and the pull requests behind the same floor — keeps no timer while hidden, stops the moment it is no longer drawn, and a `bash` command that mutates an issue or a pull request forces one read behind a 5 s cap; a failed refresh keeps the rows and marks them `stale`, and a failed pull-request read keeps the count already painted. Without `gh` on `PATH` neither the section nor `/issues`/`/prs` exists at all — the commands are never registered and the section is never added to the rail — and every other surface keeps working. With no bridge the section simply never appears. See [the rail section](docs/reference.md#the-github-rail-section).
- **The ODD rail lists what this session is working on — and nothing else.** A second section, titled `ODD` and placed right after the host's own `AGENTS` part, lists ONLY the ODDs this session is associated with, four at a time, with `<N> more` for the rest, as ONE row per ODD name, never one per checkout: when the same ODD exists in main and in a worktree the row's right-hand gray cell says which copy the click opens, `main` or the worktree's own name, and the copy on offer is the most recently modified document (`main` breaks an exact tie). The association is by ODD name and is rebuilt from the session's own ACTIVE branch, so an old session written before the touch entry existed and a resumed one both show their ODDs: a successful `write`/`edit` on `odd/tasks/<name>.md`, the session's persisted touch entries, a subagent's `files_changed:` report and the `Spec:` line of the subagent task that started it (a subagent's write counts for the parent), while a failed write and an abandoned branch's work do not count. A document this session just wrote shows at once. A new session is associated with nothing on disk, so the body is ONE dim `no ODD associated` line instead of a bare box. The checkouts are the worktrees this session registered — the same session entries `/odd`, `/files` and this section all read — so a registered worktree whose `odd/tasks` has nothing new or different from main contributes nothing, a worktree registered only on an abandoned branch is out of scope, and the section keeps working with `Worktrees+` off. The associated ODDs this session wrote or edited come first and force an immediate re-read; attribution is the filter AND the order, and the grouped model still decides what exists and where. The `/odd` panel is unchanged: it keeps listing main whole plus each worktree's delta. A click sends `/odd <document>` to the host, so the panel opens on exactly that ODD, and a second click while an open is in flight does nothing. See [the ODD rail section](docs/reference.md#the-odd-rail-section).
- **Cards follow your shell.** Tool and warp cards use the card style Gentle Shell publishes, and a click expands that card only. See [card style](docs/reference.md#card-style-follows-your-shell).
- **Tool headings can name the activity.** With `activity` chosen on the `Card activity` line, a bash card whose heading shows the whole command is headed with the family its command names instead of `$`, and a `grep`, `find` or `ls` card is headed `⌕ exploring`; a command the classifier cannot name, or a heading that hides part of it, keeps the host's `$`. See [the cards the `activity` design paints](docs/reference.md#the-cards-the-activity-design-paints).
- **File calls on a skill or an ODD are cards too.** While that line answers with `activity` for the tool being painted, a `read`, `edit` or `write` whose path names a skill or an ODD heads as that file — its own mark and label, the tool, the path and a read's line range — and its Markdown body is drawn by Pi's own renderer in the theme's Markdown roles. Any other file call is the host's own row. See [the file cards](docs/reference.md#the-file-cards).
- **Background-job tools are cards too.** While that line answers with `activity`, `bash_background`, `monitor`, `job_stop` and `job_list` are drawn in the shell's own card style instead of Pi's plain box, with the job's label, its command and its own answer. See [the jobs card](docs/reference.md#the-jobs-card).
- **The two advisory messages are cards too.** `gentle-pi.exploration-budget` and `gentle-pi.verifier-settle-reminder` are drawn as `⌕ Exploration budget` and `⚑ Verifier reminder`, the whole body at every content level. They follow that `Card activity` line, with no second switch and no row added to `Cards`. See [the message cards](docs/reference.md#the-message-cards).
- **Your own prompt can be a card too.** While that `Card activity` line answers `activity`, the message you sent is drawn as a `✿ Jona` card — your own name, stored with `/identity`, and `You` while none is stored, the title and the whole frame in the accent role, in whichever card style your shell uses — instead of Pi's plain background block, in the prompts already on screen too, because a name set or cleared repaints them. It is the one host class this package patches, because Pi offers no hook for a `role: "user"` entry: switch the line to `default` and the prompt is Pi's own again, live, byte for byte. It adds no switch of its own. See [the user prompt card](docs/reference.md#the-user-prompt-card).
- **The diff card is a design of the same kind.** `Card diff` keeps `default` available and selects `color` once on the first run that finds no choice, so a write or an edit on a skill or an ODD stays the file card's row, because a specific claim wins over a generic one. See [the diff card](docs/reference.md#the-diff-card).
- **`edit` and `write` cannot land in the principal checkout's default branch.** A write whose path is inside the principal checkout of the session's repository, while that checkout is on the default branch, is refused with one line pointing at `worktree_list` and `worktree_create`. Paths outside the repository, anything under the OS temp directories, ODD artifacts, other repositories and linked worktrees are never blocked. See [the guard](docs/reference.md#the-edit-and-write-guard).
- **A skill or an ODD is read whole.** A `read` of a `.md` below a `skills/` or an `odd/` folder drops its `offset` and `limit` before the tool runs, so the call delivers the whole document and never half a procedure. It follows the `Worktrees+` module, like the guards.
- **`bash` cannot leave the principal checkout's default branch.** A `git worktree add` is refused in any cwd and pointed at `worktree_create`; in the principal checkout, a switch that would leave the branch it is on is refused while that branch is the repository's default, and creating a branch is not blocked. See [the guards](docs/reference.md#the-bash-guards).
- **Three blocks in the system prompt.** `## ODD worktrees` tells the agent how worktrees and ODDs work. `## CodeGraph` tells a session that already holds a CodeGraph tool how to use it, with one text per role. `## User identity` states your name in one line, and it is there only while a name is stored. All three are appended after the host's own text; `ODD_WORKTREE_PROMPT=0` suppresses the first two, and the third is the stored name's business alone. See [the prompt block](docs/reference.md#the--odd-worktrees-block-in-the-system-prompt) and [the user identity block](docs/reference.md#the--user-identity-block-in-the-system-prompt).
- **CodeGraph stays fresh, only when its CLI is installed.** At session start the package creates or syncs the checkout's index and warms its daemon, and makes sure your global `mcp.json` has the `codegraph` entry. It also syncs after a compaction, after a native `codegraph init` and after an `edit` or `write`, in the background and without ever blocking you. See [CodeGraph](docs/reference.md#codegraph-index-daemon-and-mcp-entry).
- **Two reminders keep a session on the CodeGraph rule.** The first `grep`, `find`, `ls`, `read` or `bash` search in a checkout gets one sentence appended to its result: use `codegraph` first, or — for another checkout — call `mcp__codegraph__codegraph_explore` with that path as `projectPath`. Neither is ever a block, and a subagent child hears neither. See [the reminders](docs/reference.md#the-two-codegraph-reminders).
- **Deliberately absent.** No customize panel of its own, no plugin-tools toggles, no companion-app integration and no worktree-to-issue association. There is nothing to configure here: the card designs are chosen on the bridge's own lines, so this package owns no preference of its own. See [deliberately absent](docs/reference.md#deliberately-absent).

## Documentation

| Your task | Start here |
| --- | --- |
| Look up a panel key | [Panel keys](docs/reference.md#panel-keys) |
| Read, merge or close a pull request | [`/prs`](docs/reference.md#prs-the-pull-request-panel) |
| Understand a create, a warp or a delete in detail | [Reference](docs/reference.md) |
| Run the suite or see what CI and releases do | [Tests](docs/reference.md#tests), [CI and releases](docs/reference.md#ci-and-releases) |
| Change the package, follow its invariants or cut a release | [`docs/codebase/mental-model.md`](docs/codebase/mental-model.md) |
| Report a bug or request a feature | [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) |
| Open a pull request | [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) |

## Next Steps

- Run `/warp` in a repository with at least one other checkout to see the selector, then `worktree_list` from the agent to confirm both surfaces agree.
- Install `gh` and run `gh auth login` once if you want `/issues`, `/prs` and the `GITHUB` rail section.
- Read [the reference](docs/reference.md) before changing a panel key, a guard or a card.

## License

[MIT](LICENSE) © 2026 Jonathan Soto.
