# Codebase Mental Model

Read this before tracing code. It states what this package owns, where execution
starts, which rule each change must preserve, and where to begin.

## What This Codebase Owns

One Pi extension package, `pi-odd-worktree`: two agent tools (`worktree_create`,
`worktree_list`), five panels (`/warp`, `/odd`, `/files`, `/issues`, `/prs`), the
`/identity` command, two
optional sidebar sections — the `GITHUB` issues rail and the `ODD` rail — and two tool designs on the shell API — the `activity`
value of its `Card activity` line (`bash`, the read-only shell tools `grep`, `find`,
`ls`, and `read`, `write` and `edit`, the last two through a scope limited to
skill and ODD paths, which is what lets the file cards ask about them) and the
`color` value of its `Card diff` line (`write` and `edit`, drawn as an IDE pane
in the active theme's own syntax roles) — and one stored value of its own: the
user's name, kept by `/identity` in the shell API's store, which heads the prompt
card instead of `You` and adds one line to the orchestrator's prompt. The skill/ODD
file cards obey that same `Card activity` value. On a shell API that can put
several tools on one line the `Card activity` row was `Card tools` until this
release (the older single row was `Card bash`), and a choice stored under the old
key is carried over to `tags` before the design registers — only when the API
reads it as a choice at all — so nobody loses the choice they made. It owns
creating and listing the checkouts an ODD works in, reading a checkout's
`odd/tasks/*.md`, browsing and previewing a
checkout's files, reading and — role permitting — editing that checkout's GitHub
issues and pull requests, and the drawing of its own cards. `git` is the only external requirement, and the shell API is not one: it is this
package's OWN code under `lib/shell-api/`
(invariant 32), imported by the entry as `../lib/shell-api/extension.ts`, so the slot
`Symbol.for("gentle-shell-bridge/api/v1")`
is published at module load with nothing installed beside this package. Other plugins keep
using that slot, so they extend gentle-shell through odd-worktree too. That API carries
three control surfaces: the two
rail sections and the design (which the file cards read). The two host shortcuts are
neither: the file picker's `alt+p` and the issues panel's `alt+i` are
bound directly on the host, and `GENTLE_PI_FILES_KEY` and `GENTLE_PI_ISSUES_KEY`
override them. `gh` is optional and belongs to the three GitHub surfaces
alone — `/issues`, `/prs` and the `GITHUB` rail section: it is a local `PATH` walk
(`lib/which-command.js`), never a child process,
and when it finds nothing, neither command is ever registered and the `GITHUB` rail section is
never added — every other surface keeps working.

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
- Tool execution, permissions and blocks: the two tool designs and the file cards only
  draw, the reminders only advise, the guards read command text and paths (invariants 20, 21,
  22, 23).
- Every other customize surface, plugin-tools toggle and companion-app
  integration: the bash activity is a design on the shell API, the diff card is the
  second one, the file cards read the `activity` design's line and never the
  `color` one, and this package owns no
  preference at all (invariants 2, 3, 23).
- Any child process through a shell string: fixed argv, always (invariant 9).

## Main Flow

1. `extensions/odd-worktree-tools.ts` — the only entry point the host loads. Its
   factory calls the shell API's factory first (`lib/shell-api/`, imported as
   `../lib/shell-api/extension.ts`, which published the API slot at module load), so
   the API is published before anything here looks for its object; then, if the slot
   holds a compatible object, it registers the six commands this package owns
   (`/issues` and `/prs`
   only when the
   local `gh` probe finds the CLI), the two tools, the message renderer, the file
   card, the two rail sections (`GITHUB`, also `gh` only, and `ODD`, scoped to the
   ODDs the session is associated with inside its registered worktrees and therefore
   outside `Worktrees+`), the two tool
   designs and the hooks. An ABSENT or INCOMPATIBLE object on the slot leaves this
   package's own surface unregistered, and the package says so once in its own words
   (invariant 32). Nothing else is deferred.
   Its `gh` gate is dispatched startup work under the generation the
   dispatch captured, never an awaited step of `session_start`, so a session start
   or switch pays no child process and no network call for it.
2. `lib/worktree-*.js` — a create validates and plans in
   `lib/worktree-create.js`, prepares through `lib/worktree-hooks.js`, then
   `lib/worktree-setup-runner.js` starts the install as a tracked background
   task; a listing renders in `lib/worktree-list.js`; `/warp` composes
   `lib/warp-*.js`; `/odd` reads through `lib/odd-docs.js`.
3. `lib/worktree-git.js` — the one git seam, where a child argv leaves for git,
   with `lib/worktree-remove.js` the one removal. `lib/gh-issues.js` and
   `lib/gh-prs.js` are the `gh` seams of the three GitHub surfaces, reached only by a
   read that is already off the
   session path; `lib/issues-cache-store.js` and `lib/prs-rail-store.js` write the
   two cache documents
   under the user's cache home; the file cards own no switch and ask the shell API's
   published reader on every paint (invariant 23);
   `lib/codegraph-mcp-config.js` is the only
   writer of the user's own configuration (invariant 19).

## Major Areas

Every module and what it owns is one row in [`code-map.md`](code-map.md).

| Area | Responsibility | Start here |
| --- | --- | --- |
| Extension entry point | Registration, renderers, optional shell API surfaces, hooks | `extensions/odd-worktree-tools.ts` |
| Shell API | This package's own extension point for gentle-shell — the slot and every compat key, rows, the rail, card styles and transforms, tool and message designs, the store — plus its own suite and docs | `lib/shell-api/index.ts`, `lib/shell-api/extension.ts`, `docs/shell-api/` |
| Worktrees | Create, list, ownership, removal, the `bash` guards | `lib/worktree-create.js` |
| `/warp` panel | Selector, extended list, create wizard, delete confirmation, queued warp | `lib/warp-selector-view.js` |
| ODD reader | `odd/tasks/*.md` discovery, ordering and markdown rendering; the grouped model and the `ODD` rail | `lib/odd-view.js` |
| `/issues` | The `gh` client, the view, the repository pin, the linked-PR click and the rail section with its two cache halves | `lib/gh-issues.js` |
| `/prs` | The pull-request `gh` client, the panel, its preview, the linked-issue click and the rail's pull-request count | `lib/gh-prs.js` |
| Cards | The card substrate, the tool cards, the file cards and the two tool designs | `lib/shell-card.js` |
| Prompt blocks | The `## ODD worktrees` text and the `## CodeGraph` role texts | `lib/codegraph-rules.js` |
| CodeGraph wiring | Index, lock, daemon, MCP entry, compaction, edit sync, reminders | `lib/codegraph-session.js` |
| Tests | The plain-JS suites and their fixtures (`tools/*.test.js`), plus the shell API's own TypeScript suite (`tools/shell-api/*.test.ts`, `.test.mjs`) | `tools/*.test.js` |

## Core Invariants

Read these before your first edit: a change that breaks one is wrong even when
its tests pass. The numbers are cited across this repository; the full sentence
for each is in [`invariants.md`](invariants.md).

| # | Rule a change must preserve |
| --- | --- |
| [1](invariants.md) | One extension entry point: `pi.extensions` is exactly `["./extensions/odd-worktree-tools.ts"]` and `extensions/` holds no other file. |
| [2](invariants.md) | No customize command, plugin-tools toggle or Herdr panel surface; CodeGraph only as 18 and 19 allow. |
| [3](invariants.md) | The shipped surface is exactly six commands (`/warp`, `/odd`, `/files`, `/identity`, `/issues` and `/prs`), two tools, two sidebar sections and two tool designs. |
| [4](invariants.md) | Deletion refuses on a live session and discloses every caveat it could not resolve. |
| [5](invariants.md) | Deletion is git only: `git worktree remove <absolute path>`, branch kept. |
| [6](invariants.md) | `/issues` keeps repository identity pinning, and refuses a mutation after the remote moves. |
| [7](invariants.md) | `/issues` capabilities fail closed: anything but a literal `true` means no mutation. |
| [8](invariants.md) | The package ships `extensions`, `lib`, `tools` and `README.md` only. |
| [9](invariants.md) | Fixed argv, never a shell string, with a bounded timeout. |
| [10](invariants.md) | There is no worktree document: the path is the whole record. |
| [11](invariants.md) | The listing is read-only and has no state. |
| [12](invariants.md) | One identity per worktree: the directory is the ODD. |
| [13](invariants.md) | A create never waits for its setup. |
| [14](invariants.md) | The prompt block is append-only. |
| [15](invariants.md) | A warp waits for this session's tools, agent tasks and background jobs, and it is queued, never thrown away. |
| [16](invariants.md) | The card substrate's role tables are the reference's, not a local invention. |
| [17](invariants.md) | This repo paints last; the only painted inputs it measures are the host's key hint and Pi's own Markdown rows. |
| [18](invariants.md) | The `## CodeGraph` section is advice, selected by the session's own facts. |
| [19](invariants.md) | CodeGraph runs only with its CLI, in the background, and writes one config entry. |
| [20](invariants.md) | The tool designs only draw, and the `activity` one draws what the classifier names (the three read-only shell tools `grep`, `find`, `ls` are always `exploring`; `read`, `write` and `edit` are declared for the file card's question — `write` and `edit` through a scope limited to skill and ODD paths — and it draws nothing for any of the three). |
| [21](invariants.md) | The two CodeGraph reminders advise, never block, add no surface, and belong to the primary session. |
| [22](invariants.md) | The tool guards (`bash`, `edit`/`write`) read text and paths, fail open and add no surface. |
| [23](invariants.md) | The file card only draws, and it claims exactly three tools. |
| [24](invariants.md) | No session path waits on `gh`, and every `gh` reach is deferred. |
| [25](invariants.md) | A persisted cache entry never defeats the count invariant or the full-read TTL. |
| [26](invariants.md) | The rail's timed refresh exists only while the section is drawn. |
| [27](invariants.md) | A forced refresh happens only after a mutating `bash`, behind its cap. |
| [28](invariants.md) | The `gh`-absent and non-repository states are settled, so nothing retries them. |
| [29](invariants.md) | The user prompt card draws the host's class, gated by `Card activity`, and never touches its text. |
| [30](invariants.md) | A session is named after the ODD it writes, and a name it cannot prove it wrote is never touched. |
| [31](invariants.md) | The ODD panel folds by default, counts what it lists, and lines a document up under its group's name. |
| [32](invariants.md) | The shell API is native: `lib/shell-api/` is this package's own code at the same slot and store, loaded first by the entry, with no external dependency, no import by package name and no copy rule. |

## Common Change Paths

Work on a branch, never on `main`: an ODD gets its own checkout at
`<repo-parent>/<repo-name>-worktrees/<odd>`, created with `worktree_create`
(invariant 12). Verify with `node --test tools/*.test.js`, or with
`node --test tools/issues-command.test.js` for one suite while iterating; the
shell API has its own gate under `node --test tools/shell-api/*.test.ts
tools/shell-api/*.test.mjs` (`npm run test:shell-api`), which needs Node >= 22.18.

| Change | Start here |
| --- | --- |
| Add or change a command, a tool or a hook | `extensions/odd-worktree-tools.ts`, then the `lib/` module behind it |
| A create, its refusals or its output lines | `lib/worktree-create.js`, `lib/worktree-hooks.js`, `lib/worktree-setup.js` |
| A listing's rows, order or footer | `lib/worktree-list.js` |
| Removal, or the deletion guard | `lib/worktree-remove.js`, `lib/worktree-session-guard.js` |
| A queued warp or the busy evidence | `lib/worktree-warp-busy.js`, `lib/worktree-warp-sessions.js` |
| How a card draws | `lib/shell-card.js` for the substrate, `lib/worktree-cards.js` |
| The shell API, its slot or its runtime | `lib/shell-api/` — ordinary package code, edited like any other module (invariant 32) |
| The bash heading design | `lib/bash-design.js`, `lib/bash-frame.js`, `lib/bash-activity.js`, `lib/bash-inline-script.js` |
| A file card or the `Card activity` line it obeys | `lib/file-card.js`, `lib/skill-odd-card.js`, `lib/file-card-markdown.js`, `lib/file-card-resolver.js` |
| The card of a background-job tool | `lib/jobs-card.js`, `lib/jobs-card-resolver.js` |
| The two advisory message cards | `lib/message-card.js` |
| The `opencode-go` usage source, or the peak rows above the editor | `lib/opencode-usage.js`, `lib/peak-schedule.js`, `lib/peak-providers.js`, `lib/peak-labels.js` |
| The `Alert` page or one of its peak switches | `lib/alert-rows.js`, `lib/alert-mode.js` |
| Prompt text the model reads | `lib/odd-prompt/odd-worktrees.md`, `lib/codegraph-prompt/*.md` via `lib/odd-worktrees-prompt.js` and `lib/codegraph-rules.js` |
| `/issues`, its tabs or its capabilities | `lib/gh-issues.js`, `lib/issues-view.js`, `lib/issue-preview.js` |
| `/prs`, its tabs, its merge step or its capabilities | `lib/gh-prs.js`, `lib/prs-view.js`, `lib/pr-preview.js` |
| The rail section, its count or its caches | `lib/issues-section.js`, `lib/related-issues-cache.js`, `lib/issues-cache-store.js`, `lib/prs-rail-store.js` |
| The `ODD` rail, its rows or their order | `lib/odd-rail-model.js`, `lib/odd-rail-section.js`, `lib/odd-group.js`, `lib/odd-session.js` |
| A `bash` command that should force a rail read | `lib/issues-bash-mutation.js` |
| CodeGraph indexing, daemon or MCP entry | `lib/codegraph-session.js`, `lib/codegraph-index.js`, `lib/codegraph-mcp-config.js` |
| The `bash` guards | `lib/worktree-guard.js`, `lib/skill-read-guard.js` |

## Related Decisions / Contracts

- [`invariants.md`](invariants.md) — the 32 rules above, in full, with their tests and limits.
- [`code-map.md`](code-map.md) — every module and the one responsibility it owns.
- [`../reference.md`](../reference.md) — panel keys, refusals, and how each surface behaves.
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — the Node versions the suite runs on.
- [`.github/workflows/pr-check.yml`](../../.github/workflows/pr-check.yml) — the commit and PR-title convention.
- [`.github/workflows/release.yml`](../../.github/workflows/release.yml) — tag, environment, publish and verification.
