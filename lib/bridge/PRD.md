# PRD — gentle-shell-bridge

## Problem

gentle-shell renders `/gentle:customize` from an array it builds itself and never exposes:
the `ctx.ui.custom` factory constructs a `VisualCustomizeView` and returns a six-method
adapter, so the rows exist only inside closures
(`extensions/gentle-shell.ts:3550`, `:3554-3561`). Any plugin that wants a settings line
therefore reaches for the only reachable moment — the factory call — and patches the host
to get at the rows.

That works once. It does not compose. Two independent wrappers each swap
`Array.prototype.map` around the same factory: the inner wrapper installs its patch last
and wins the capture, the outer wrapper captures nothing and degrades to a warning. With
the naive approach only one plugin's rows ever appear, and neither plugin can tell the
difference until someone looks at the menu. This is the collision the bridge exists to
remove, and it is observed behaviour, not a hypothesis: the first prototype using
duck-typing on the returned component silently injected nothing because the view is sealed
behind the adapter.

## Users

- **Plugin authors** (loon, and any future gentle-shell plugin) who want a settings row
  without owning an interception layer or a conflict policy.
- **gentle-shell users** who want every installed plugin's settings in the one menu they
  already open, with no plugin silently missing.

## Goals

1. One interception layer per process, shared by every plugin.
2. A small, typed contract: publish a provider, get rows; dispose to remove them.
3. Rows that reflect live state, so the `●` marker never lies.
4. No silent failure: every absent row has a reportable reason.
5. One place to repair when gentle-shell's internals change.

## Non-goals

- Not a theme pack, banner engine or card renderer; it adds rows to existing categories.
- Not a UI framework: no widgets, layout engine, or rendering of its own.
- Not a configuration service for gentle-shell; gentle-shell keeps its own files.
- Not an upstream replacement: if Pi or gentle-shell ships a row-provider hook, the bridge
  should shrink to a thin adapter over it rather than compete.

## Requirements

| ID | Requirement | Contract | Status |
| --- | --- | --- | --- |
| R1 | `registerRows(provider)` accepts providers and returns a disposer that removes exactly that provider's rows. | `registerRows`, provider shape | Implemented; unit tests plus the end-to-end suite |
| R2 | Providers are evaluated lazily when the menu is built, in subscription order, with a context carrying at least the active theme and the resolved config home. | Provider `rows(ctx)`, ordering | Implemented; `ctx` carries the factory's theme and the resolved config home, tested |
| R3 | The bridge supports every row kind gentle-shell's renderer understands: `category`, `label`, `choice`, `preview`, `visible`, `keyhint`, `action`. | Row kinds | Implemented as typed pass-through fields; exercised against the fake host, not the real renderer |
| R4 | A toggle is expressed as consecutive rows sharing `choice.setting`, and works with the renderer's own `●`/`○` and arrow/Enter handling. | Toggle recipe | Implemented; the end-to-end suite shows the `●` moving after `action()` on a fake host |
| R5 | Arm-time state is idempotent: repeated `session_start`, rebinds and double loads never double-wrap or double-inject. | Idempotency | Implemented; tested across two `session_start` events and a double entry load |
| R6 | A throwing provider loses its rows, is reported, and never breaks the menu or other providers. | Failure isolation | Implemented; tested per provider, with the failure reported by `/bridge-status` |
| R7 | A diagnostics command reports providers, active backend, last capture outcome and last failures. | `/bridge-status` | Implemented as `/bridge-status`; formatter and entry tested, including store problems and duplicate settings from the last menu build |
| R8 | Composition is stateless; persistence is the plugin's, with an optional namespaced store helper. | `createStore`, [docs/state.md](docs/state.md) | Implemented; `createStore` tested against temporary directories. One documented exception: a sidebar section's visibility is bridge-owned (see R12) |
| R9 | `registerSection(section)` adds a card to gentle-shell's sidebar and returns a disposer that removes it, with no extra step from the plugin. | `registerSection`, section shape | Implemented; end-to-end over the public API against the fake rail, never in a real TUI |
| R10 | Each registered section automatically contributes two consecutive rows to `Sections` (a readable label derived from its title or an explicit `rowLabel`, plus `shown`/`hidden`), reading and persisting the same value the rail renders; the id stays internal and never appears in a row. | Automatic toggle rows | Implemented; the menu, the persistence file and the next rail frame are asserted together — against the fake host and fake rail — including the label derivation and the collision rule |
| R11 | A hidden section is neither rendered nor built (`lines()`/`meta()` not called); a throwing section loses only its own body and is reported. | S7 failure isolation | Implemented; pinned with call counters and `/bridge-status` section failures, against the fake host |
| R12 | Section visibility persists in the bridge's own store, not the host's `visual-customization.json`, which rejects unknown keys. | `bridge-sections.json`, [docs/state.md](docs/state.md) | Implemented; the document shape is asserted byte-for-byte, and the reason for the separate file is recorded |
| R13 | `registerCardStyle(style)` accepts `{ id, label, frame: { top, line, bottom }, preview?, order? }`, validates id/label/frame before storing, replaces in place on the same id, and returns a disposer that removes exactly that style. | `registerCardStyle`, frame contract | Implemented; validation, ordering, replacement and disposal are unit-tested, and the published-API path is exercised end to end |
| R14 | A registered style joins the host's own `Card style` line (spliced in place, one coalesced line, the host's values untouched), with a `Bridge → card style` fallback line only when the host's line is not reachable; the selection is bridge-owned state, pressing a host value returns to native rendering, and a disposed style degrades to `native`/`missing`. | `bridge-card-style.json`, [docs/contract.md](docs/contract.md) §12 | Implemented; one bullet at a time, the way back, the fallback line and the missing-selection degrade are pinned against the fake host and reported by `/bridge-status` |
| R15 | When a registered style is selected, the bridge repaints the conversation frames the host already drew — detection, title/hint extraction, one style at a time, width clipping, and a pass-through for `native`, for a missing selection and for any throw — and reports the frame outcome. | [docs/architecture.md](docs/architecture.md) §14 | Implemented; proven against a fake conversation built from real `shell-card.ts` output, plus the end-to-end suite through the public API. A downstream post-processor can override the frame, which `/bridge-status` states |
| R16 | `registerTransform(transform)` accepts `{ id, order?, transform(lines, ctx) }`, validates the id and the function before storing, replaces in place on the same id and returns a disposer that removes exactly that transform; the conversation wrapper runs the card-style repaint first and then every transform in order, each receiving the previous output, clipping the result to the host width, isolating a throw or a non-lines return to that transform, and returning the host's own array when nothing changed; `/bridge-status` lists the pipeline in order with the last frame's outcome per transform. | `registerTransform`, [docs/contract.md](docs/contract.md) §13 | Implemented; ordering, replacement, disposal, identity, clipping, throw isolation and the status block are unit-tested, and the worked example's toggle is proven to restyle cards already on screen, with past and new cards byte-identical |
| R17 | `registerToolDesign({ tool, id, label, apply })` accepts a per-tool card design against ONE `pi.registerToolRenderer` resolver for the whole process, validates it before storing, replaces in place on the same `(tool, id)` and returns a disposer; `apply` receives the rows the host's card produced, the width and an optional `ctx.render` (`args`, `isPartial`, `isError`, `durationMs`, `toolCallId`, `expanded`), an older context without it still works, and a design labelled `default` or `native` is refused. | `registerToolDesign`, [docs/contract.md](docs/contract.md) §14 | Implemented; registration, replacement, disposal, one resolver for the process, the `default` fallback and the `ctx.render`-absent path are covered, together with the cost of one persisted read per card per frame |
| R18 | A registration may group several tools behind ONE switch: `{ line, tools, id, label, apply }` registrations naming the same line join one line whose tool set is their union, `default` is added once by the bridge, a tool belongs to at most one line (a registration that would add a second line is refused whole and reported), the selection persists per line under `$lines` in the same document, and a tool the selected value does not cover draws `default`. | `registerToolDesign`, [docs/contract.md](docs/contract.md) §14 | Implemented; union, all-or-nothing refusal, per-line persistence, the one-time migration at registration and the uncovered-tool fallback are covered, and the one-read-per-card cost is pinned; the same resolution is published read-only as `resolveToolDesignSelection` |
| R20 | The bridge requires `gentle-pi` and says so instead of arming nothing: `/bridge-status` prints `gentle-pi: present` or `gentle-pi: missing — <reason>` plus `bridge: disabled — …`, every per-surface block is then omitted, and one notice per process explains why. | `src/presence.ts`, [docs/contract.md](docs/contract.md) §8 | Implemented; the presence check, the disabled report and the notice are covered |

Nineteen requirements are implemented and covered by the `node --test` suite — 975 tests at `0.14.0`,
including an end-to-end file that drives the public API and the real extension entry. What is proven
and what is not:

- **Proven against a fake host.** The row side drives a fake menu host that models
  `gentle-shell.ts:3550-3562`: injection, ordering, toggles, failure isolation and the
  diagnostics lines.
- **Proven against a fake conversation.** The card-style side drives a fake transcript built from
  real `gentle-shell/lib/shell-card.ts` output at a fixed width, plus a fake `tui` that models Pi's
  documented tree: detection, repaint, clipping, the pass-through paths, the disposal degrade, the
  host line splice, the fallback line and the generation guard. The transform pipeline drives the
  same conversation through the real wrapper: ordering, identity, clipping, per-transform throw
  isolation and the `/bridge-status` block — plus the worked example's `Bash rendering` toggle, end
  to end, where a card drawn before the switch and one drawn after it come out byte-identical.
- **Proven against a fake rail.** The sidebar side drives a fake terminal that models
  `lib/shell-sidebar.ts`'s state symbol and `parts` map plus the layout's card frame
  (`lib/shell-sidebar-layout.ts:35-44,392-410`): section cards, ordering, the `Sections` rows,
  the store file, hiding and failure isolation.
- **Not proven in a running TUI.** Neither surface has been re-run inside a real Pi +
  gentle-shell session through the package. In particular the sidebar's `tui` is acquired
  through `ctx.ui.setWidget`, and whether a widget whose component renders no rows leaves the
  editor area visually untouched is **unconfirmed**. R7's hook branch has never met a host
  that exposes the registry it looks for.
- The capture technique itself is proven in the real TUI by the reference probe, not by these
  tests.
- **The card-style repaint has not been seen in a live TUI.** It depends on the host's `float`
  grammar and on Pi's component tree; both are cited, neither is observed at runtime here, and a
  downstream post-processor can erase the frame — reported, not prevented.

## Success criteria

- Two independent providers coexist in one menu, each with its own rows and no lost
  capture.
- A toggle persists through `action()`, the menu re-renders, and the `●` moves to the
  applied value.
- No silent failure: an uncaptured menu, a broken provider or a duplicate `setting` is
  visible in `/bridge-status`.
- When gentle-shell changes its menu construction, exactly one module needs repair.
- A plugin can add a card style with one call: the value appears on the host's own `Card style`
  line, selecting it repaints every card the host drew, and selecting a host value or losing the
  plugin returns the conversation to the host's rendering.
- A plugin can apply a rendering choice to the WHOLE conversation with one call: the choice reaches
  cards drawn before the switch, not only the next one, and the worked example proves that a bash
  card drawn before and one drawn after are byte-identical.
- The reference probe's observed result reproduces through the package against the fake host
  that models the real call chain: a `Cards` category showing the injected line
  `Card bash   ● activity ○ output`. It has not yet been re-run in the real TUI through the
  package.

## Risks and open questions

- **Upstream hook availability.** If Pi or gentle-shell adds a supported row-provider
  registry, the capture backend becomes dead weight; the contract should stay stable
  across that switch. A hook backend now exists (`src/hook.ts`) and prefers a recognized
  registry over patching, but no host has been observed emitting
  `Symbol.for("gentle-pi.customize-row-providers")` — that branch is implemented and
  unverified.
- **Namespace policy.** Requiring namespaced `setting` names (`"Loon → Banner source"`)
  avoids accidental merges but depends on authors complying; the bridge can warn on
  duplicates but cannot rename rows without breaking identity.
- **Whether the store belongs in the package at all.** It is the only piece that writes to
  disk and the only piece a plugin could implement itself. Shipping it is a convenience
  bet, recorded with its alternatives in [docs/state.md](docs/state.md).
- **Diagnostics spelling.** Settled in code: the command is `/bridge-status`. Pi has no
  built-in `/status`, and gentle-shell's commands live under the `gentle:` prefix, so a bare
  `bridge-status` collides with neither. It has not yet been typed into a real host.
- **Compatibility drift.** The capture depends on one constructor line and one adapter
  shape; every gentle-shell upgrade is a potential silent break until an upstream hook
  exists. The sidebar surface depends on the same class of internals: the state symbol, the
  `parts` map and the hard-coded rail key order.
- **The sidebar widget's visual footprint is unconfirmed.** Pi exposes no `tui` getter, so the
  bridge acquires one through `ctx.ui.setWidget` and returns a component that paints nothing.
  Whether that component leaves the editor area untouched has not been observed; if it does
  not, the fix is the widget's rendering, not the contract.
- **Sections cannot be interleaved with the native cards.** The host builds its status
  sections inside a closure, so "after every native section" is the honest contract; a user
  request to slot a section between `CHANGES` and `STATS` cannot be met without an upstream
  change.
- **Bridge-owned visibility is new state.** It is one namespaced file the bridge writes; a
  future host that opens `VISUAL_SECTION_KEYS` would make it redundant and it should then be
  migrated rather than duplicated.
