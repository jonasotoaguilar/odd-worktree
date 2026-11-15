# Codebase Mental Model

Read this before tracing code. It states what this package owns, where execution
starts, which rule each change must preserve, and where to begin.

## What This Codebase Owns

One Pi extension package, `pi-odd-worktree`: two agent tools (`worktree_create`,
`worktree_list`), three panels (`/warp`, `/odd-list`, `/issues`), one optional
sidebar section, one bash design on the bridge and two preferences — `Card skill`
and `Card odd`. It owns creating and listing the checkouts an ODD works in,
reading a checkout's `odd/tasks/*.md`, reading and — role permitting — editing that
checkout's GitHub issues, and the drawing of its own cards. `git` is the only
external requirement; Gentle Shell is recommended, and gentle-shell-bridge adds
only three control surfaces.

## What It Does Not Own

- The host's session, prompt or tool set: this package appends prompt text and
  registers names, and never replaces host text (invariants 14, 18).
- Moving the session or removing a checkout as an agent surface: `/warp` is the
  person's front for both, and no tool exposes either (invariant 3). That is a
  rule about this package's surface; it does not make removal a person-only
  operation, and invariant 5 says what an agent may do with a merged checkout.
- A stored worktree record: no document, no lock file, no registry write — the
  path is the whole record (invariant 10).
- Any deletion except the checkout: removal is `git worktree remove <absolute
  path>` and the branch is kept (invariant 5).
- CodeGraph itself: no `/codegraph-*` command and no tool named `codegraph`; it
  wires the index, the prompt text and the two reminders (invariants 19, 21).
- Tool execution, permissions and blocks: the bash design and the file cards only
  draw, the reminders only advise, the guards read command text (invariants 20, 21,
  22, 23).
- Every other customize surface, plugin-tools toggle and companion-app
  integration: the two file-card switches are the only preferences, and the bash
  activity is a design on the bridge (invariants 2, 3, 23).
- Any child process through a shell string: fixed argv, always (invariant 9).

## Main Flow

1. `extensions/odd-worktree-tools.ts` — the only entry point the host loads:
   registers the three commands, the two tools, the message renderer, the file
   card, the optional rail section, the bash design, the `Cards` row group and
   the hooks.
2. `lib/worktree-*.js` — a create validates and plans in
   `lib/worktree-create.js`, prepares through `lib/worktree-hooks.js`, then
   `lib/worktree-setup-runner.js` starts the install as a tracked background
   task; a listing renders in `lib/worktree-list.js`; `/warp` composes
   `lib/warp-*.js`; `/odd-list` reads through `lib/odd-docs.js`.
3. `lib/worktree-git.js` — the one git seam, where a child argv leaves for git,
   with `lib/worktree-remove.js` the one removal. `lib/gh-issues.js` is the `gh`
   seam for `/issues`; `lib/card-files-mode.js` writes the one document behind the
   two file-card switches (invariant 23); `lib/codegraph-mcp-config.js` is the only
   writer of the user's own configuration (invariant 19).

## Major Areas

Every module and what it owns is one row in [`code-map.md`](code-map.md).

| Area | Responsibility | Start here |
| --- | --- | --- |
| Extension entry point | Registration, renderers, optional bridge surfaces, hooks | `extensions/odd-worktree-tools.ts` |
| Worktrees | Create, list, ownership, removal, the `bash` guards | `lib/worktree-create.js` |
| `/warp` panel | Selector, extended list, create wizard, delete confirmation, queued warp | `lib/warp-selector-view.js` |
| ODD reader | `odd/tasks/*.md` discovery, ordering and markdown rendering | `lib/odd-view.js` |
| `/issues` | The `gh` client, the view, the repository pin, the rail section and its cache | `lib/gh-issues.js` |
| Cards | The card substrate, the tool cards, the file cards and the bash design | `lib/shell-card.js` |
| Prompt blocks | The `## ODD worktrees` text and the `## CodeGraph` role texts | `lib/codegraph-rules.js` |
| CodeGraph wiring | Index, lock, daemon, MCP entry, compaction, edit sync, reminders | `lib/codegraph-session.js` |
| Tests | The suites and their fixtures | `tools/*.test.js` |

## Core Invariants

Read these before your first edit: a change that breaks one is wrong even when
its tests pass. The numbers are cited across this repository; the full sentence
for each is in [`invariants.md`](invariants.md).

| # | Rule a change must preserve |
| --- | --- |
| [1](invariants.md) | One extension entry point: `pi.extensions` is exactly `["./extensions/odd-worktree-tools.ts"]` and `extensions/` holds no other file. |
| [2](invariants.md) | No customize command, plugin-tools toggle or Herdr panel surface; CodeGraph only as 18 and 19 allow. |
| [3](invariants.md) | The shipped surface is exactly three commands, two tools, one sidebar section, one bash design and the one `Cards` row group. |
| [4](invariants.md) | Deletion refuses on a live session and discloses every caveat it could not resolve. |
| [5](invariants.md) | Deletion is git only: `git worktree remove <absolute path>`, branch kept. |
| [6](invariants.md) | `/issues` keeps repository identity pinning, and refuses a mutation after the remote moves. |
| [7](invariants.md) | `/issues` capabilities fail closed: anything but a literal `true` means no mutation. |
| [8](invariants.md) | The package ships only `extensions`, `lib`, `tools`, `README.md`. |
| [9](invariants.md) | Fixed argv, never a shell string, with a bounded timeout. |
| [10](invariants.md) | There is no worktree document: the path is the whole record. |
| [11](invariants.md) | The listing is read-only and has no state. |
| [12](invariants.md) | One identity per worktree: the directory is the ODD. |
| [13](invariants.md) | A create never waits for its setup. |
| [14](invariants.md) | The prompt block is append-only. |
| [15](invariants.md) | A warp waits for this session's tools, agent tasks and background jobs, and it is queued, never thrown away. |
| [16](invariants.md) | The card substrate's role tables are the reference's, not a local invention. |
| [17](invariants.md) | This repo paints last; the host's key hint is the one painted input it measures. |
| [18](invariants.md) | The `## CodeGraph` section is advice, selected by the session's own facts. |
| [19](invariants.md) | CodeGraph runs only with its CLI, in the background, and writes one config entry. |
| [20](invariants.md) | The bash design only draws, and it draws what the classifier names. |
| [21](invariants.md) | The two CodeGraph reminders advise; they never block and never add a surface. |
| [22](invariants.md) | The `bash` guards read text, fail open and add no surface. |
| [23](invariants.md) | The file card only draws, and it claims exactly three tools. |

## Common Change Paths

Work on a branch, never on `main`: an ODD gets its own checkout at
`<repo-parent>/<repo-name>-worktrees/<odd>`, created with `worktree_create`
(invariant 12). Verify with `node --test tools/*.test.js`, or with
`node --test tools/issues-command.test.js` for one suite while iterating.

| Change | Start here |
| --- | --- |
| Add or change a command, a tool or a hook | `extensions/odd-worktree-tools.ts`, then the `lib/` module behind it |
| A create, its refusals or its output lines | `lib/worktree-create.js`, `lib/worktree-hooks.js`, `lib/worktree-setup.js` |
| A listing's rows, order or footer | `lib/worktree-list.js` |
| Removal, or the deletion guard | `lib/worktree-remove.js`, `lib/worktree-session-guard.js` |
| A queued warp or the busy evidence | `lib/worktree-warp-busy.js`, `lib/worktree-warp-sessions.js` |
| How a card draws | `lib/shell-card.js` for the substrate, `lib/worktree-cards.js` |
| The bash heading design | `lib/bash-design.js`, `lib/bash-activity.js` |
| A file card or one of its two switches | `lib/file-card.js`, `lib/skill-odd-card.js`, `lib/card-files-mode.js`, `lib/cards-customize.js` |
| Prompt text the model reads | `lib/odd-prompt/odd-worktrees.md`, `lib/codegraph-prompt/*.md` via `lib/odd-worktrees-prompt.js` and `lib/codegraph-rules.js` |
| `/issues`, its tabs or its capabilities | `lib/gh-issues.js`, `lib/issues-view.js` |
| The rail section or its cache | `lib/issues-section.js`, `lib/related-issues-cache.js` |
| CodeGraph indexing, daemon or MCP entry | `lib/codegraph-session.js`, `lib/codegraph-index.js`, `lib/codegraph-mcp-config.js` |
| The `bash` guards | `lib/worktree-guard.js` |

## Related Decisions / Contracts

- [`invariants.md`](invariants.md) — the 23 rules above, in full, with their tests and limits.
- [`code-map.md`](code-map.md) — every module and the one responsibility it owns.
- [`../reference.md`](../reference.md) — panel keys, refusals, and how each surface behaves.
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — the Node versions the suite runs on.
- [`.github/workflows/pr-check.yml`](../../.github/workflows/pr-check.yml) — the commit and PR-title convention.
- [`.github/workflows/release.yml`](../../.github/workflows/release.yml) — tag, environment, publish and verification.
