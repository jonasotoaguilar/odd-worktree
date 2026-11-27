# Architecture — how the bridge reaches gentle-shell's menu

Every claim in this document is either read from the cited source or observed in the real
TUI. Paths without a repository prefix are Pi (`packages/coding-agent/src/...`) or
gentle-shell (`extensions/...`, `lib/...`) files. Anything not proven is in **Limits** at
the end.

The contract itself lives in [contract.md](contract.md); the persistence decision in
[state.md](state.md).

## 1. Shape

```
plugin A ─┐
plugin B ─┼─ registerRows(provider) ─→ globalThis[Symbol.for(...)] ─→ bridge
plugin C ─┘                                                              │
                                                    one ctx.ui.custom wrapper
                                                                         │
                                               capture during the factory call
                                                                         │
                                              fan-out: A + B + C rows, placed by the resolver
                                                                         │
                                                 gentle-shell VisualCustomizeView
```

N plugins × M gentle-shell surfaces → N providers, one interception. The bridge is a typed
facade over a process-global bus, never a module-level singleton (see §5).

## 2. One `ctx.ui` per runner, rebuilt on every bind

All extension contexts share a single UI object per runner, so a patch installed from one
extension is visible to every extension:

```ts
get ui() {
    runner.assertActive();
    return runner.uiContext;
}
```

`packages/coding-agent/src/core/extensions/runner.ts:896-898`.

That object is not stable. `setUIContext()` reassigns it
(`runner.ts:572-575`: `this.uiContext = uiContext ? this.wrapUIPromptContext(uiContext) : noOpUIContext`),
and `wrapUIPromptContext` returns a **new object literal** each time, with `custom` as an
own property wrapping `withUIPrompt` (`runner.ts:577-587`). Consequence: a patch does not
survive a rebind. The bridge therefore arms inside its `session_start` handler, and arming
must be idempotent — a non-enumerable marker installed with `Object.defineProperty` on the
target object, so a second `session_start`, a `/reload` or a double load never double-wraps.

## 3. The `custom()` call chain

`custom` on the facade maps straight through to the interactive mode
(`packages/coding-agent/src/modes/interactive/interactive-mode.ts:2794`:
`custom: (factory, options) => this.showExtensionCustom(factory, options)`).

`showExtensionCustom` resolves the component with

```ts
Promise.resolve(factory(this.ui, theme, this.keybindings, close))
```

around `interactive-mode.ts:3136`, and forwards `overlay` / `overlayOptions`. Two facts
follow: factories may return a promise, and the factory receives the theme as its second
argument — the value the bridge can hand to providers as part of their row-building
context.

## 4. Why duck-typing fails: the menu is sealed

gentle-shell builds its customize view inside the factory and returns something else:

- `extensions/gentle-shell.ts:3550` — `customizeView = new VisualCustomizeView({ rows, ... })`
- `extensions/gentle-shell.ts:3554-3561` — the factory returns a plain adapter:
  `{ render, handleInput, handleMouse, focus, invalidate, dispose }`
- `extensions/gentle-shell.ts:3562` — the call itself passes
  `{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "85%" } }`

The view lives only inside those closures. There is no `options.rows` on the returned
object, at any depth the bridge can see. This is precisely the bug that made a first
prototype a silent no-op: it inspected the component, found no rows, and did nothing.

## 5. The one reachable moment

The view's constructor derives its categories from the rows array, synchronously, inside
the factory call:

```ts
this.categories = [...new Set(options.rows.map(row => row.category ?? "Settings"))];
```

`lib/visual-customize-view.ts:387`.

That `.map` runs before the factory returns and on the array the renderer will keep using.
So the bridge temporarily replaces `Array.prototype.map` for the duration of that single
call, records the row-like array **by reference** (not a copy), and restores the original
in a `finally` block. Restoring in `finally` is mandatory: an exception anywhere in the
factory must not leave the process with a patched `Array.prototype`.

Two properties make the captured reference live data rather than painted text:

- `categoryRows()` re-filters `this.options.rows` on every render
  (`lib/visual-customize-view.ts:391-393`), so rows pushed after construction appear.
- `component.invalidate()` on the returned adapter delegates to `view.invalidate()`
  (`extensions/gentle-shell.ts:3559`), which refreshes the frame.

Capturing an array reference is also why a marker on the captured array (non-enumerable,
via `Object.defineProperty`) matters: a second factory call for the same menu hands over
the same array, and rows must be injected once.

A mapped array counts as row-like when it holds at least three objects that each expose a
callable `action`. The threshold comes from the probe's verified run against the real menu;
the cost is explicit: a menu with fewer than three host rows would not be captured, and the
`/bridge-status` command reports `uncaptured (no-capture)` rather than passing silently.

### Capture-selection rule

Each wrapped `custom` call owns one capture *session* with its own candidate list, and
the probe records a mapped array into the innermost active session only. That fixes
the target without guessing:

- A nested `custom` call — from the host factory or from a provider's own `rows()` —
  gets its own session, so it can never steal the outer menu's capture, and the nested
  menu receives its own injection.
- A nested session whose factory throws never resolves, so nothing is injected into
  it; the outer session continues and resolves its own array.
- When one session captures **more than one** row-like array (an incidental
  row-shaped array before the menu, for example), the bridge does not guess: the
  outcome is `uncaptured (ambiguous)` and nothing is injected.

Arming is idempotent per target *and per function*: the non-enumerable marker holds the
exact wrapper installed and is read as an own property, so a rebind that gives an
instance a new `custom` always rearms even when it inherits an already-wrapped
prototype.

Two boundaries around that rule:

- The probe is installed around the **factory invocation**, not around the host call, so a
  host that resolves its factory in a later microtask (`Promise.resolve().then(factory)`)
  is still captured. A factory that itself returns a promise remains the documented
  unsupported case, `uncaptured (async-factory)`.
- Every wrapper carries the generation it was armed in. `disableCaptureBackend()` bumps the
  generation, so a wrapper that foreign code kept a reference to becomes a pass-through
  instead of injecting into a menu after the backend was switched off.

### A brand-new page, and why the early step is provisional (S18, S20)

`categoryRows()` filters `options.rows` live (`lib/visual-customize-view.ts:391-393`), but the page
*list* is derived once, in the constructor (`this.categories = [...new Set(options.rows.map(row =>
row.category ?? "Settings"))]`, `:387`). A row that joins an existing page therefore appears after a
late push; a row naming a new page never could, because nothing can select a page the list does not
hold (E8). The capture backend therefore has two moments: it pushes the providers' rows when the probe
observes that `map`, provisionally, and the end of the factory decides.

- **The provisional placement.** The probe runs the proof and appends the provider rows BEFORE it
  forwards the call to the saved native `map` (`src/capture.ts:354-379`), so the host's own
  `rows.map(...)` sees the appended rows and a new page enters `new Set(...)`. Because the factory is
  still in flight, this step is append-only and provisional; once the factory returns,
  `placeEarlyBlocks` applies the plan (an existing page gets its `start`/`after` slots). If a write is
  refused, the appended rows stay in the pre-feature tail position; if the host changed the array,
  they stay where the append put them. The report says why.
- **The proof.** Nothing is written to an array that is not proven at *that* `map` call, and the proof
  runs on **every** call (the host may map its rows to labels first). The callback must derive
  `row.category ?? "Settings"` for the array's own rows, `"Settings"` for a synthetic row with no
  category and a sentinel page for a synthetic row naming one, and must not throw. The same callback is
  then run over the rows about to be appended, **before** they are pushed, so the host's own `map` can
  never throw because of a bridge row.
- **The reconciliation.** If the late decision picks the same array, the rows stay and the build reports
  `injected`. If it picks another array, the session proved several (ambiguous), or the factory returned
  a promise, the rows, the `Card style` splice and the marker are removed from the early array and the
  previous behaviour applies exactly. When exactly one captured array proves itself the menu's rows it is
  the target by evidence, so a merely row-like array mapped beside it no longer makes the build
  ambiguous; two proven arrays, or two unproven ones, still do.
- **The rollback.** A factory that throws takes the provisional append back; it does not restore a
  whole snapshot. The session stack and the patched `Array.prototype.map` are restored first and
  unconditionally, and every rollback step is best effort and never throws (E10: a host that froze its
  rows and then threw used to make the rollback throw, replace the host's error and leave `map`
  patched). The removal is all-or-nothing against the range it will REALLY touch. It matches every
  appended occurrence by identity and position across the whole tail, so a reordered segment is still
  removed entirely; when the host already removed some rows, it removes the remaining occurrences and
  the notice counts host removals separately. Every source and target index that a length trim or
  splice will inspect or write is preflighted first, including host rows appended after the build; a
  locked or non-configurable index means nothing is written, so a host row is never duplicated and no
  hole appears. An accessor is never a safe target, not even one carrying a setter: a setter is code,
  and one that rejects its assignment would swallow the write after an earlier element had already been
  changed. Only a writable data descriptor, or an index with no own descriptor yet, passes. When the appended segment was mutated beyond recognition, the bridge also removes
  nothing: that is the documented exception, and the notice reports it rather than guessing. The
  `Card style` values are undone by their own recorded splice, not by a snapshot. A session only ever
  rolls back its own array, so a nested factory's rollback cannot touch the outer menu's rows.

Net guarantee: when the appended identities can be removed as a whole and every range index passes
preflight, after a factory invocation no array holds bridge rows except the one the late decision
chose. When the segment was mutated beyond recognition or the removal range cannot be handled exactly,
no rows are removed and the notice reports that outcome; that is the documented exception. Costs, stated: for the duration of the factory an array that satisfies the proof can hold bridge
rows, visible only to code running inside that factory; the host's category mapper runs once more per
row-like `map` call and once per appended row; when a guess is rolled back the providers are built twice
for that menu build; and the proof is pinned to the host's default `Settings`, so a host that renames it
degrades to the late path (no new page) rather than guessing. A host that reorders the appended
segment is removed by identity and reported, not restored from a snapshot; one that mutates it beyond
recognition gets the exception above (Proxy arrays included); a stale `cardStyleRowMode()` after a
rolled-back guess remains not reviewed.

## 6. Why one bridge beats N wrappers

Two independent map-swapping wrappers chain badly. Whichever installs its patch last sees
the factory's `.map` call first and captures the array; the other captures nothing and
degrades to a warning. The result is that only one plugin's rows apply, non-deterministically
with load order, and the losing plugin looks broken for reasons it cannot debug.

The bridge installs **one** patch, guarded by a nesting counter (the factory may itself
trigger further UI work), and fans the single capture out to every registered provider:

1. snapshot the provider list in subscription order,
2. build each provider's rows independently, inside its own `try`,
3. drop a provider's rows on throw, record the failure for `/bridge-status`, continue,
4. resolve the surviving blocks that named `placement` or `order` with the pure
   `resolveRowPlacements` (per actual category, with the `order`/`id` rule), keep providers that named
   neither in the pre-feature tail append, turn that answer into one planned rebuild with
   `planRowPlacement`, and apply it in one preflighted in-place write; if the write is refused, leave
   every block in the pre-feature tail position and record why. Then invalidate once.

Failure isolation is per provider, so a broken plugin costs its own rows and nothing else:
not the menu, not the other providers, and not another provider's placement.

The placement itself is resolved by `src/bus.ts`'s pure `resolveRowPlacements` and turned into
insertion points by `src/rows.ts`'s `planRowPlacement`. An opted-in block's boundary comes from the
category its rows actually use (`row.category ?? provider.category`): a provider with rows in several
categories contributes one block per category, and its rows stay contiguous WITHIN one category,
while an unopted provider keeps one tail block. An `after` follower of a provider that did not opt in
is not a category insertion: that provider's rows are in the pre-feature tail, so the follower is
emitted in that tail right after them. The capture path never re-sorts blocks or re-implements the
fallbacks: for each actual category it reads the host array's first and last index, computes the
whole plan against the array as it stands, and
applies it in one preflighted in-place write, so no index can drift between splices. A rendered
consecutive `choice.setting` pair — and the bridge's own `Card style` value splice — is therefore
never split. If the write is refused, nothing is half-applied: every block stays in the pre-feature
tail position and `/bridge-status` reports that landing.

## 7. Process-global state cannot live in a module

Pi loads each extension through its own jiti loader with `moduleCache: false`; gentle-shell
documents the consequence directly — every extension gets a copy of any imported module
(`lib/shell-card.ts:30-32`). Shared state must therefore sit on `globalThis` behind a
`Symbol.for` key, exactly as gentle-shell does for its card style
(`lib/shell-card.ts:40-41`): `Symbol.for("gentle-pi.card-style")` indexing an augmented
`globalThis`.

The npm package is a typed facade over that process-global bus. Registration, diagnostics
and the capture marker all resolve through the same `Symbol.for` slot, so three providers
loaded from three copies of the package see one bus.

The bridge's own key is `Symbol.for("gentle-shell-bridge.providers")` for the registration
list, with sibling slots for backend state and markers (`…capture.state.v1`,
`…capture.wrapped.v1`, `…capture.injected.v1`, `…hook.state.v1`, `…hook.armed.v1`,
`…store.state.v1`). The host key `Symbol.for("gentle-pi.customize-row-providers")` is only
ever **read**: the bridge pushes one fan-out provider into it when a host exposes one, and
otherwise leaves the slot absent.

## 8. Row grouping semantics the bridge relies on (it does not re-implement them)

- `lineEntries()` coalesces **consecutive** rows that share `choice.setting`
  (`lib/visual-customize-view.ts:395-401`): same setting, adjacent index, one line. Same
  setting with another row between it becomes two lines with independent bullets.
- `renderSettingLine()` prints `entry.setting` as the line's name and marks each value with
  `●` for current and `○` for the others (`lib/visual-customize-view.ts:583-595`).
- `choice.hint` feeds the preview headline (`lib/visual-customize-view.ts:745`).
- `applyOnMove !== false` makes ←/→ apply a choice immediately rather than Enter
  (`lib/visual-customize-view.ts:565`). The bridge therefore sets `applyOnMove: false` on EVERY row it
  contributes — its own `Sections`/card-style rows in `./sections-rows.ts` and `./card-style-rows.ts`,
  and any provider row, normalised on a copy in `./rows.ts` (`confirmOnEnter`) — so a move only moves
  the `›` cursor and Enter applies. The host's own rows keep their own field, so a line that holds both
  (the extended `Card style` line) is per-row correct; the focused line's footer then reads
  `←/→ choose · Enter apply` (`lib/visual-customize-view.ts:35-38`).
- After any action the view requests its own re-render
  (`lib/visual-customize-view.ts:579`), so a plugin that persists inside `action()` sees an
  updated `●` without asking for a repaint.
- `category` is TYPED as a closed union of existing categories
  (`lib/visual-customize-view.ts:105`) but at runtime any string is a page, because the view derives
  its page list from the rows (`:387`); full row shape at `:107-128`, inline helpers at `:129-140`.

The bridge's own rows obey the same rule. Its `Sections` and card-style rows put a human label in
`choice.setting` (`music`, `plain`) and in the row's `label` — never a registration id, which would
read as the old `Section: bash-card.status` (`src/row-labels.ts`). Identity stays in the registry, so
replacement, disposal and the stored visibility key remain keyed by id while nothing id-shaped is
rendered. Two sections whose labels would read the same are disambiguated in render order
(`music`, `music 2`, …) and `/bridge-status` reports the assignment in force.

The bridge ships no renderer. Every visual behaviour above belongs to gentle-shell, which
is why the contract can promise row kinds without promising pixels.

## 9. Reference implementation

`/home/jona/.pi/agent/extensions/loon-customize-probe.ts` (76 lines) is a throwaway probe,
not production code, and it implements exactly this capture trick. Confirmed in the real
TUI: the `Cards` category rendered `Cards · 1/3` with the injected line
`Card bash   ● activity ○ output`.

The probe is behavioural evidence for the backend, and it is also the honest baseline for
its weaknesses: probe-local state resets on `/reload` (no persistence), it recognises the
row array by shape, and it warns through `ctx.ui.notify` rather than through a diagnostics
surface. The package replaces all three.

## 10. Detection and reporting

Every branch that can end with "no rows appeared" is a reportable outcome on the `/bridge-status`
command: armed but never captured, captured a row array that failed the shape check,
provider threw, provider returned nothing, duplicate `category` + `setting` across
providers. Silent success is not a valid state.

### The plugin's own INTEGRATIONS line

The host renders Pi's extension-status map (`footerData.getExtensionStatuses()`) as the INTEGRATIONS
card: one row per entry, plus the permissions row (`extensions/gentle-shell.ts:357-385`,
`lib/shell-bar.ts:289-298`). A row is the WHOLE opaque string the extension set via
`ctx.ui.setStatus(key, text)`; the host strips its ANSI and paints every entry with one shared role,
so a glyph must live inside the text and colour belongs to the host (`lib/shell-bar.ts:151-155`).
`undefined` removes a key, which is what `session_shutdown` uses.

Because the host has no notion of "a plugin", the bridge owns exactly one key per plugin
(`src/plugin-lines.ts`). Attribution needs no configuration from the author: every registration in
`src/bus.ts` goes through `attributeRegistration`, which reads the calling module from the stack
once per registration (the first frame outside this package's `src/`), walks up from it to the
nearest `package.json` with a non-empty `name`, and caches BOTH the answer and the plugin identity it
implies per module. The identity is the package root — so every module in that package is the same
plugin — or the registering module when no package owns it. Four outcomes: another package (a
plugin, whose display name is derived from the package name), this package (plumbing — the bridge's
own providers and fallbacks never claim a row), no owning package (a single copied file: fail
closed, no row, reason in `/bridge-status`), and the Pi distribution (below). An optional `name` on
any registration is the documented way for an unattributable file to name itself; it is validated
against the row-name shape, never rewritten.

The Pi distribution is never a plugin identity (I11): a module attributed to the package that owns
the running `pi` entry point (`process.argv[1]`, realpath resolved) or to a package whose manifest
declares the `pi` executable (`bin.pi`) fails closed exactly like an unattributable module. A shared
extensions directory inside the Pi installation therefore cannot produce a second `Pi coding agent`
row; a plugin that must be named from such a location names itself explicitly. Recognition is by
declaration, not by matching a package name.

One key per identity is hashed from the package root (or the module path when it has no owner) and
NEVER from the display name, so a plugin's ten registrations update one row in place instead of
adding ten, and a rename of the package or of the explicit name repaints the same key without
leaving an orphan (I10). An explicit name is sticky for the identity (I9): the first registration
that declares a usable one fixes it, later registrations inherit it whether or not they repeat it,
and a later DIFFERENT name never creates a row and never renames — the first name is kept and the
conflict is reported in `/bridge-status`. A name is attribution, not mutable state, so a deliberate
rename ships as an edit plus `/reload`, a new registration lifetime. The text is
`<name> · <ready|degraded>`: `ready` is derived — one rejected registration (an invalid id, a row
label that broke the shape rule) repaints the same key as `degraded`. `installPluginStatus` runs on
`session_start` (for plugins that registered before any `ctx.ui` existed) and paints or repaints;
`clearPluginStatus` runs on `session_shutdown` and clears every key this module set with `undefined`.
A `ctx.ui` without `setStatus` makes the feature a reported no-op: nothing here can throw into a
plugin's registration path.

What is proven where: the bridge's side is tested against a fake footer (an object with
`setStatus`), plus real temporary plugin packages for attribution. The host's rendering — sort
order, shared role, ANSI stripping — is read-only evidence from gentle-shell, not executed here.

## 11. Backend selection and module boundaries

Arming happens once per `ctx.ui` object, from `session_start` in `src/extension.ts`. The
order is fixed: if `globalThis[Symbol.for("gentle-pi.customize-row-providers")]` exists and
is usable — a plain array, or an object with a callable `register` — the bridge pushes one
fan-out provider and patches nothing at all. A present-but-unusable registry — or one that
does not accept the provider, because `push` did nothing, `register` returned `false`, or
either threw — is reported as `fallback-capture` and the capture backend is used instead,
never silently ignored. Dedupe does not mutate the host registry: identity in a
`WeakSet` in the process-global state is authoritative, so a frozen registry still gets
exactly one provider across arms and package copies. When the host removes the slot,
diagnostics stop reporting `hook`.

| Module | Owns |
| --- | --- |
| `src/index.ts` | the plugin-facing API: `registerRows`, `registerSection`, `registerCardStyle`, `registerTransform`, `registerToolDesign`, `resolveToolDesignSelection`, `createStore`, `STORE_SCHEMA_VERSION`, `VERSION`, `bridgeApi`, `isBridgeApi`, `onBridgeApi`, `BRIDGE_READY_EVENT`, types; importing it also publishes the handshake through `./api.ts` |
| `src/api.ts` | the runtime handshake: the one `Symbol.for` slot, the frozen published object, the shape gate, `bridgeApi()`, `onBridgeApi` and the `gentle-shell-bridge:ready` announcement |
| `src/extension.ts` | the Pi entry from `pi.extensions`: `session_start` arming (rows + sidebar widget), the `Sections` provider, and the `/bridge-status` command |
| `src/arm.ts` | backend selection and the arm result |
| `src/capture.ts` | the single `Array.prototype.map` patch, the captured array, and the provisional placement/rollback |
| `src/hook.ts` | the host-registry probe and the one fan-out provider; it has no host array, so it orders by `order`/`id` and reports that host-relative placement could not be honoured |
| `src/bus.ts` | the `globalThis` provider list and its ordered snapshot, plus the section, card-style and transform registries |
| `src/rows.ts` | the one row builder both backends call, with per-provider isolation and the row-name shape check; also `planRowPlacement`, which turns the resolver's blocks into one planned array |
| `src/row-names.ts` | the enforced row-name shape (one to three plain words, no structural marks) and the rejection records `/bridge-status` lists |
| `src/sidebar.ts` | the rail interception: the state symbol, the patched `parts` map, the rail wrapper |
| `src/sidebar-render.ts` | the section renderer: card rows and groups per frame, clipping, failures |
| `src/sections-rows.ts` | the bridge's own `Sections` toggle rows |
| `src/row-labels.ts` | the visible label for those rows: `rowLabel` or a derived one (clamped to the shape), plus the deterministic collision assignment (never an id) |
| `src/visibility.ts` | bridge-owned section visibility in the namespaced store |
| `src/store.ts` | `createStore`, the namespaced path and the atomic write |
| `src/status.ts` | the `/bridge-status` text |
| `src/transform-pipeline.ts` | the ordered per-frame transform pass: width clipping, throw isolation and the last frame's outcomes |
| `src/config.ts`, `src/types.ts` | config-home resolution; the row, provider and context types |

The table lists the spine. The families below are described where they are owned: the
card-style modules (`src/card-style-*.ts`, `src/repaint.ts`) in §14, the transform pipeline
(`src/transform-pipeline.ts`) in §15, and the tool-design bus (`src/tool-design-*.ts`,
`src/plugin-lines.ts`, `src/row-origin.ts`) in §16. The remaining seams are documented against the
surface they serve: the section preview patch (`src/sections-preview.ts`) in
[contract.md](contract.md) §11, and the required-host check with its notices (`src/presence.ts`,
`src/notices.ts`) in [contract.md](contract.md) §8.

Because both backends call `src/rows.ts`, a plugin sees the same `registerRows` semantics on
either one. Because the arming markers live on the target objects and the state slots live on
`globalThis`, a second copy of the package arms nothing new and reads the same diagnostics.

## 12. The sidebar surface

The second surface a plugin can publish to. Same shape as the rows: one process-global registry,
one interception, one place that reports why nothing appeared.

### Where the rail lives, verified

- Rail state hangs on the **terminal** behind
  `Symbol.for("gentle-pi.experimental-sidebar.state")`, not in module scope
  (`lib/shell-sidebar.ts:6,78-80`), so separately loaded extensions share one rail.
- `sidebarPart` writes the part into `state.parts` (`lib/shell-sidebar.ts:91`) and deletes it on dispose (`:95-98`).
- The layout paints a hard-coded key order — `["todo","jobs","agents","footer"]`
  (`lib/shell-sidebar-layout.ts:344`) — so an unknown key never renders: contributing rows to one of
  those four parts is the only way in. That line also FILTERS `todo` when
  `state.visibility?.todo === false`, and `sidebarPart` (`lib/shell-sidebar.ts:87-100`) renders `[]`
  for a part the host is not painting (status hidden, compact work, the host owns the frame): "is
  this part painted?" is a RENDER question, not a registration one.
- The four parts are registered by four extensions, so any of them may exist before or after our
  arm: `footer` at `extensions/gentle-shell.ts:2827`, `jobs` at `:2895`,
  `todo` at `extensions/gentle-todo.ts:292`, `agents` at `extensions/gentle-agents.ts:2500`.
- The host has a SECOND fixed order over the same map: the mobile `/gentle:panel` sheet reads
  `parts.get(key).render(inner)` for `todo, jobs, agents, footer` (`SHEET_ORDER`,
  `lib/shell-panel.ts:125-150`). Because the wrapper IS the map's value, the sheet paints the
  bridge's rows with no extra work and no second interception — pinned by
  `test/section-placement-rail.test.ts`, which renders the map values exactly the way that loop does.
- A part's cards come from `cardGroups` (`:392-410`) fed into `sectionCardRows` (`:35-44`), which
  is why a wrapped rail can look native: the host draws the frame, we supply rows and ranges.
- The status sections (`CHANGES`, `STATS`, `INTEGRATIONS`) are built inline in a closure
  (`lib/shell-bar.ts:247,251-316`): unreachable, so no interleaving is possible — and the reason
  `placement` offers native anchors at PART granularity only.
- Readers reach another part's `spend` through `parts.get("agents").spend()`
  (`extensions/gentle-shell.ts:2798`), which is why every field of the wrapped part is forwarded
  untouched. `digest` is the one field the wrapper owns, because the layout memo re-renders a part
  only when its VALUE moves (`:114-119`): the host's own answer is forwarded unchanged while nothing
  contributes rows, and the contributed rows' signature is appended when they do (N14).

### The interception

`src/sidebar.ts` patches the **map instance's own** `set` and `get` instead of replacing the map or
subclassing it: every holder keeps the map it already has, so a part registered after our arm is
still captured, and a part registered before it is wrapped on install. Two markers keep it
idempotent across arms, rebinds and package copies: the map's own property holds the exact `set`
function installed, and the wrapper rail holds the exact rail it wraps. A foreign wrapper already
on the part is wrapped around, never replaced; `disableSidebarBackend()` restores every host part
and leaves any retained wrapper as a pass-through (a generation guard).

ALL FOUR painted keys are wrapped (`RAIL_PARTS`), not just the footer: a section may sit before the
first part or after a middle one. A key the layout never paints (`header`, `statusbar`) keeps its
own identity — wrapping it would put our rows nowhere. The painted set is measured, not assumed:
a part is painted when it is in the map, the host's own `state.visibility.todo` does not hide it,
and its own `render` did not return an empty frame the last time it ran. That set is what
`/bridge-status` prints as `rail parts: …` and what a `start` or native-part anchor resolves
against.

### The renderer

`src/sidebar-render.ts` contributes the section rows and their card groups per frame, around ONE
part's own rows: a `before` block above them and an `after` block below them. Which sections go in
which block of which part is decided by the placement resolver (`resolveSectionPlacements`,
`src/bus.ts`) from the registrations and the painted parts alone — a pure function, so the frame and
`/bridge-status` cannot disagree.

A hidden section is not built at all, and neither is a COLLAPSED one: folding is a user choice, and a
folded body costs nothing (its `lines()` is not called). Hiding is also why a section's own placement
is resolved BEFORE visibility is consulted: a hidden anchor keeps its slot, so its followers do not
move. A throwing `lines()`/`meta()`/`onClick`, a sparse array, or a row that is not a string and has
no usable `label` loses only that section's body and is recorded for `/bridge-status`.

A plain string row is clipped to the width the host passes and the body is capped at 8 rows with a
visible `… +N more` marker. Width is measured the way the HOST measures a row — `visibleWidth`,
where a TAB is three columns and a grapheme cluster is charged as a whole — because the host's gate
and card frame read the row with that model (`src/card-style-transform.ts`'s `hostColumns`);
measuring in UTF-16 units let a CJK row or a tabbed row measure wider than the budget and the host
dropped the whole rail (`lib/shell-sidebar-layout.ts:410`). A structured row is fitted by the panel
builder in the same columns, and padded to the width it was handed, exactly as the host's own
`renderPanelRow` pads (`lib/shell-panel.ts:78-80`).

### The header and the panel builders (N11, N15)

The host draws its own rail sections with `renderPanelHeader` / `renderPanelRow` and paints a hover
with `paintHoverable` (`lib/shell-panel.ts:44-80`, `lib/shell-hover.ts:33-38`): `▾`/`▸` by `open`, the
uppercased title in `text` (bold, `warning` while hovered), the right-aligned count in `muted`, rows
indented by two and fitted to the width. `src/section-panel.ts` reproduces that drawing exactly, and
it gets the theme from the same place the host does: the second argument of Pi's `setWidget` factory.

The host's two builders are NOT importable — gentle-shell is not a dependency, and Pi loads every
extension through its own jiti loader with `moduleCache: false`, so `lib/shell-panel.ts` is a
separate module graph with no published seam. Rather than claim a reach it does not have, the bridge
LOOKS for them on every object it is handed — the rail part, the Pi theme, the terminal's sidebar
state — uses them when they are found, and otherwise draws with the port. `getPanelReport()` feeds
`/bridge-status` with what was looked for, what was found, and whether a theme had arrived; when the
answer is `fallback` the report also carries the gap, so "the card does not look native" always has
an answer. `test/section-panel.test.ts` transcribes the host's own functions and compares bytes, which
is what makes "byte-identical fallback" a claim a test enforces instead of a comment.

### Width: the one thing a contributed row can cost (N17–N20)

The rail column is allocated from the layout, not from a part's output: `basis: RAIL_WIDTH, grow: 0,
shrink: 0` (`lib/shell-sidebar-layout.ts:493-496`), so pi-tui never measures the child
(`dist/layout.js:124`) and the conversation keeps `columns - 53`. The one width decision the host DOES
take from a part's rows is whether to paint the rail at all: every rail row must fit `contentWidth`
(`:410`), and one wider row drops the entire rail and hands the conversation every column. So a
contributed row that measures wider than the width it was given changes the layout's widths.

That is why the bridge measures with the host's own model. `hostColumns`
(`src/card-style-transform.ts`) ports `visibleWidth` (`pi-tui/dist/utils.js:212-268`): ANSI is zero
columns, a TAB is three (`graphemeWidth`, `:148-155`), and the rest is segmented into grapheme
clusters charged as a whole (`:255-258`). `src/section-panel.ts` fits, pads and clips with it, and
`src/sidebar-render.ts` clips an author's plain row with it, so a row fitted to `N` is `N` columns to
the host — the padded rows the host's own parts return (`renderPanelRow` → `fitPanelLine`,
`lib/shell-panel.ts:31-40,78-80`) and the bridge's are the same rule, matched rather than chosen.
`test/rail-width.test.ts` models the rail path and pins both halves; `getSectionFrameWidth()` feeds
`/bridge-status` with `section width: <N> columns given, widest row <M>`, so the next width bug is a
number in the report instead of a screenshot.

### Colouring and the theme

Pi hands a widget factory `(tui, theme)`; gentle-shell's own parts take their theme the same way, and
`src/extension.ts` now keeps it (`setSectionTheme`). Before that factory runs there is no theme: the
rows are drawn uncoloured rather than guessed at, and the report says `theme missing`.

### The pointer (N12)

Clicking is POSITIONAL in this host, not a row field. The layout maps a pointer event into the part's
frame and calls the part's `handleMouse` with those coordinates (`lib/shell-sidebar-layout.ts:245-259`),
and the wrapper already receives that call, so the bridge's own rows can answer it. The backend hands
the contributor ROW RANGES of that frame — `native`, `before` and `after`, each `{ start, end }`,
recorded by the render that preceded the event — and `src/sidebar-render.ts` matches the event's `y`
against the block that contains it, then maps it onto the rows it built. Ranges, not one offset:
contributed rows can now sit on BOTH sides of the host's own, so "everything after the host's rows"
is no longer the shape of a contribution. A row with `onClick` is clickable and highlights under the
pointer; a row without it is inert and declines (so the host's own dispatch continues). The header is
always actionable: it folds the section.

The ranges are recorded PER PART and PER WIDTH, and the backend hands the event's width along with
them (`RailContributionPosition.width`). This is not bookkeeping: the layout memo re-renders ONE part
when that part's digest moves (`lib/shell-sidebar-layout.ts:114-119`), so a live tick in `todo`,
`jobs` or `agents` repaints that part alone. A renderer that kept one set of ranges for the whole
rail lost every other part's rows on the first part of a new pass, and the footer's contributed rows
went inert with no error — the defect this per-part map fixes. So a part's ranges are replaced
wholesale when that part renders (a part re-rendered inside one pass cannot double count, a part that
lost every section loses its ranges), and an event whose width is not the width those ranges were
drawn at is declined rather than mapped onto a stale offset. The failure list read by `/bridge-status`
stays PASS-scoped: it is the one thing a new pass still resets. Pinned by
`test/rail-part-hits.test.ts` (the partial pass: click, hover, width, and the test seam's reset)
beside `test/rail-width.test.ts` for the `given`/`widest` report.

Because a part's frame now starts with our rows as well as ending with them, the event the HOST sees
is translated: its own `y` (minus our before-block) for a host row, and `nativeLength` — one past its
last row, where an appended row already sat before this feature — for one of ours. So a host row keeps
reaching the host's handler with the host's own coordinate with a card above it, and the host still
never claims a row it did not draw (S7). Pinned by `test/section-placement-rail.test.ts`.

The hover claim uses the host's own published slot rather than a private channel: `SidebarState.hover`
is declared as "shared across separately loaded extensions" (`lib/shell-sidebar.ts:31`), and
`src/section-pointer.ts` stores `{ owner, clear }` there with the host's own semantics — the previous
owner's `clear()` runs when the owner changes, and the host's "pointer left the rail" call
(`setSidebarHover(tui)` with no owner) clears ours. `NativePointerRegion` itself is not reachable and
is not needed: the dispatch it adapts is the one the bridge already receives.

**Who sees an event first (S21).** The host's own region answers EVERY move inside its frame with
`{ handled: true }` — it looks the row up, paints the target and, with no target, clears and still
reports handled (`lib/native-pointer-region.ts:80-88`, `extensions/gentle-shell.ts:2732-2741`). A click
is the different path: with no target it returns `undefined` (`:2747-2757`), which is why folding a
section worked while NOTHING in a contributed section ever highlighted. The wrapper used to offer the
event to the host first and only ask the contributor when the host declined, so the host swallowed
every move. It now offers any event whose `y` falls inside one of the contribution's row ranges — our
before-block or our after-block, both recorded by the render that preceded the event — to the
contributor FIRST, and falls through to the host when the contributor declines (with the translated
`y` above), so the host still clears its own hover on our inert rows. Every other event keeps the
host first, and the contributor is asked at most once. This cannot steal a host card's pointer: a host
target only ever lives inside the host's own rows, which our ranges do not cover. Pinned by
`test/sidebar-hover.test.ts` ("the host's own row keeps the pointer", "one click, one call") and
`test/section-placement-rail.test.ts` (a host row under a contributed block), (`N12`, S7). Under tmux,
zellij or screen the host forwards no plain move events at all (`lib/shell-hover.ts`'s platform note),
so hover cannot be checked there.

### Repaint and the digest (N13, N14)

A collapse persists to the bridge store and then asks for the frame synchronously, through the same
two steps the host uses for a part-owner write (`invalidateSidebar` + `requestRender`, `src/repaint.ts`).
A LIVE field needs nothing but the digest: the memo re-renders a part when its digest changes, so the
contributed rows' signature (each section's slot and side, bodies, `meta`, collapse flags, the hovered
row, the painted parts, and what the theme paints) is folded into the wrapper's `digest` and a changed
`meta` — or a card that MOVED to another slot — reaches the screen on the next layout pass. Reading
`meta()`/`lines()` from the digest is the same trade the host's own parts make
(`extensions/gentle-agents.ts:2255-2260`).

### Placement: one resolver, one report (S1–S5)

`placement` is registration data, never persisted. `resolveSectionPlacements` (`src/bus.ts`) is a pure
function of the registrations and the painted part list, and returns the sections in DRAW order, each
with the part, the side of that part's own rows, the anchor it hangs off and, when it is not where the
plugin asked, the reason. The renderer consumes it per part; `collectStatus()` consumes the SAME
function, so `/bridge-status` reports exactly where the frame draws.

The rule, in one place: every anchor is a slot (`"start"`, each native part, `"end"` and each section
id), the input order is already the S2 order (finite `order` ascending, then by `id` — never by load
order), and a slot's block is emitted at its anchor, followed by each member's own followers. `"end"`
is the `footer` part itself, so a section with no `placement` draws exactly where it drew before.
Fallbacks: a hidden anchor keeps its slot; anchors resolve transitively; a cycle falls back to the end;
a native anchor the host does not paint falls forward to the next painted native part, ending at the
footer; `"start"` with nothing painted falls back to the end. A malformed `placement` is refused at
registration (`placement rejections:` in the report) and the card is placed at the end.

Proven by `test/section-placement.test.ts` (the resolver alone: permutations, cycles, hidden and
unknown anchors, native anchors, id collisions, malformed values) and
`test/section-placement-rail.test.ts` (the same answers through the fake host: cards before and after
the host's rows, the fallbacks, the pointer, the sheet order, arm/disable on four parts).

### The `Sections` toggle names

`src/sections-rows.ts` builds the toggle from the live registry on every menu build, and
`src/row-labels.ts` decides what it reads: the author's `rowLabel`, else the title made readable
(lowercase words, dots and punctuation dropped, clamped to three words). The label is BOTH the row's
`label` and the line's `choice.setting`, because the host prints the setting as the line's name
(`lib/visual-customize-view.ts:583-595`); the section id never reaches either. Equal labels are
resolved in render order with the lowest free ordinal suffix, and `collectStatus()` uses the SAME
function, so the menu and `/bridge-status` cannot disagree about which section reads `music 2`.
Status output keeps the ids on purpose: it is read by the plugin author diagnosing a registration,
not by the user picking a toggle.

The LABEL TEXT has one shape (`src/row-names.ts`), because a row named `Bash card → Bash rendering`
was the third defect of its class: one to three plain words, no arrow, colon, dot, pipe, slash or
bracket. It is enforced at both boundaries that can create a row name, and never by rewriting the
author's text: a section or card style whose `rowLabel` breaks the shape is not stored at all, and a
provider row whose line name or label breaks it is dropped as `buildRows` stages it — absent from the
host's array and from the build record `collectStatus()` reads, so it is not part of the effective
set. The rejected string is recorded verbatim with the rule it broke and `/bridge-status` prints both
under `row rejections`. Derivation from `title`/`label` applies the same shape (marks become
word breaks with the rest of the punctuation; the result is clamped), so a derived name can never be
rejected.

### Acquiring a `tui` — and what is unconfirmed

A rail state is reached through a `tui` (`sidebarState(tui)` reads `tui.terminal`). Pi exposes
**no `tui` getter**: `ExtensionUIContext` in `dist/core/extensions/types.d.ts` mentions `TUI` only
as a factory parameter. The only surfaces that hand an extension's factory the real TUI are
`ctx.ui.setWidget(key, (tui, theme) => Component)` — `interactive-mode.js:1998`,
`content(this.ui, theme)` — plus `setFooter` (`:2084`), `setHeader`, `custom` and
`setEditorComponent`, and each installs a rendered component. gentle-shell itself gets its `tui`
this way (`extensions/gentle-agents.ts:2165-2175`).

So `src/extension.ts` installs a widget factory that keeps the `tui` it receives and returns a
component whose `render()` is `[]`. A missing `setWidget`, or a factory the host has not run yet, is
recorded as `no-widget-surface` and reported as `sidebar: not armed (reason)`.

**UNCONFIRMED:** whether a widget component that renders zero rows leaves the editor area visually
untouched has not been observed in a running Pi TUI. Nothing in the docs says either way; the
empty component is the minimal guess, and it is listed here rather than claimed.

## 13. Runtime discovery: a frozen object, not a path

How a plugin that does not depend on this package reaches it. Everything above assumes the plugin
already holds `registerRows` / `registerSection`; this section is how it gets them with nothing
installed, configured or imported.

### What Pi does and does not offer

- **No service registry.** Pi's extension API (`docs/extensions.md`) exposes registration calls
  (commands, tools, providers, MCP servers, handlers) but no lookup that returns another
  extension's live object. There is nothing a plugin could call to ask "is gentle-shell-bridge
  loaded?".
- **`pi.events` is the only sanctioned cross-extension channel** (`docs/extensions.md:1965-1972`,
  "Shared event bus for communication between extensions"), and it is a notification bus:
  `emit`/`on` delivers values to listeners at emit time. It is not a registry the host reads
  synchronously while it builds the menu. gentle-shell builds its rows inside the `ctx.ui.custom`
  factory (§5) and reads the rail map at render time (§12), so a plugin reachable only through an
  event handler cannot put rows into either. Events are not the seam for *delivery*. They are the
  only way to learn that a package loaded later published something, which is what the announcement
  below uses — and why it carries a signal ("look again") instead of the API itself.
- **`globalThis` is the one object two separately loaded extensions already share** in one
  process, and gentle-shell already relies on it: one stable `Symbol.for` key per piece of
  process-global state (`lib/shell-card.ts:40-41`, `lib/card-content-policy.ts:78`,
  `lib/shell-sidebar.ts:6`), because Pi loads every extension through its own jiti module
  instance (§7).

### The convention this follows

- `pi-lens` mounts its IO bridge at a stable `Symbol.for` key with a version constant, first-wins
  and frozen, and a breaking major takes a **new** symbol key instead of mutating the old slot
  (`clients/io-bridge-contract.ts:25-32`, `clients/process-bridge.ts:48-81`).
- gentle-shell names its shared payloads with a `schema` string and gates on the exact shape
  before using them (`lib/card-content-policy.ts:11,40`, `lib/card-style-policy.ts:29`).

The bridge combines the two. `Symbol.for("gentle-shell-bridge/api/v1")` holds a frozen object
carrying the schema string, the major version and the three callable members, and the consumer
checks all of them with `isBridgeApi` (`src/api.ts`). `v1` in the key is the major: `v2` is a new
key and `v1` is never mutated.

### First wins, and the publication announcement

`src/api.ts` publishes at module load — importing `./extension.ts`, directly or through the package
root — so the API exists as soon as the package has been loaded. A compatible object already in the
slot is kept and returned untouched. An incompatible one is left exactly where it is (never
overwritten, deleted or reset); this copy's own object still works for registration and operates on
the same process-global bus (§7).

### The load order, as observed rather than assumed

This design first claimed that `session_start` arrives only after every extension module has
initialized, so a plugin's handler either found the object or knew the bridge was absent
(`docs/extensions.md:213`). A real TUI disproved it: `/bridge-status` showed a working bridge
(`backend: capture`, `sidebar: intercepted`, `card style wiring: chat wrapped`) while the worked
example — a global extension in `~/.pi/agent/extensions` — reported "no compatible
gentle-shell-bridge is installed". Global extensions load, and receive `session_start`,
before a configured package's module publishes. The symbol was read too early, not missing.

So an absent slot at `session_start` means "not yet". Two mechanisms answer that, and they stay
separate on purpose:

1. **the symbol** remains the only authority for *which* object to use (`isBridgeApi`, first wins);
2. **`gentle-shell-bridge:ready`** tells the process *when* a publication happened. It is emitted
   from `announceBridgeReady` at the extension factory — the first moment `pi.events` exists —
   exactly once per process (a `globalThis` flag like every other piece of process state, §7), and
   never when the slot holds an incompatible payload, because there would be nothing to look at.

A listener never receives the API: it waits for the signal and reads the symbol again, so the gate,
the first-wins rule and the "absent is absent" rule are unchanged. `onBridgeApi(handler, pi.events)`
is the helper form — immediate when the object is already published and a subscription when it is
not, with the subscription detaching itself after one delivery. Registration stays idempotent by
stable id, so a plugin that registers from `session_start` *and* from the announcement leaves one of
each surface, and the announcement can arrive before or after the session event without either path
having to know about the other.

What was rejected: a queue inside the bridge (a plugin's registrations waiting invisibly for a
version that may never load — the previous revision of this file described exactly that and removed
it), and retrying `session_start` on a timer (no event to hang it on, and the plugin would have to
keep state it does not need). The announcement is neither: one event, no holding area, and the
plugin decides what an absent-and-unannounced bridge means for it.

### Why a path, and why an environment variable, were rejected

A path is not a contract between two independent projects: it names one checkout on one machine,
reaches into another package's files, and breaks silently the day either repository moves. An
environment variable is the same problem plus a per-user setup step, so the feature stops working
until someone is told to set it — not "zero extra steps". Both were in the worked example
(`bridgeCandidates()`, a dynamic `import()`, `GENTLE_SHELL_BRIDGE_MODULE`) and both are gone: the
example now inlines the symbol and the gate (`examples/bash-card.ts`) and registers from
`session_start`.

### Version skew

An object that fails the gate — another library's payload, another major, a partial object — is
**absent**, never an error and never half-used: `bridgeApi()` returns `undefined`, the plugin
decides what to do, the bridge emits one warning per process, and the slot is left for whoever
wrote it. A newer plugin against an older bridge therefore sees "absent" instead of being
deferred silently; that compatibility cliff is intentional.

## 14. The card-style transform

The third surface. Rows and sections add something to the menu and the rail; a card style cannot be
added at all in the way the others can — the host draws the conversation itself, `CARD_STYLE` is a
two-member union (`lib/shell-card.ts:33-38`) read in eight places, all binary, and
`cardStyle()` normalizes any unknown value to `float` (`:43-45`). So the bridge does the only thing
the host allows: it lets gentle-shell draw, then repaints the frames the host already produced.

### Where the conversation component is, and how that was proven

The full derivation, with every citation, is the evidence block at the top of `src/card-styles.ts`
(§1). In short, from the `tui` Pi hands a `ctx.ui.setWidget` factory (`src/extension.ts:110-148`,
the call itself at `:130-147`):

1. **Primary:** `tui.children[0]` → the document container → `children[2]` (the chat container).
   `children` is a declared member of the public `TUI` interface (`pi-tui/dist/tui.d.ts:223-231`)
   and Pi fills it in both renderer modes, document first
   (`pi-coding-agent/dist/modes/interactive/interactive-mode.js:623-625,722-731`); the document's
   children are `[header, loadedResources, chatContainer]` (`:404-407`).
2. **Secondary:** `tui.layoutRoot` → its layout entries → `entries[0].component`, the primary
   `ScrollView` (`dist/modes/interactive/chat-viewport.js:4-11,22-25`) → that view's child through
   the layout protocol (`pi-tui/dist/components/scroll-view.d.ts:57`,
   `layout-node.d.ts:2,36-38`) → the same document. `layoutRoot` is TypeScript-`private` and exists
   only on the fullscreen renderer (`tui-alt-screen.d.ts:44`), which is why it is second.
3. Anything else is reported, never guessed: `no-tui`, `no-children`, `no-document`,
   `no-conversation`, `render-missing`, `wrong-shape` (a host accessor that throws). `/bridge-status`
   prints the outcome, so "no repaint" is always an answer.

### The transform

`src/card-style-transform.ts` wraps that component's `render(width)`: the host's own render runs
first (a host failure stays the host's), then the rows are handed to the detector. It recognises
exactly the `float` grammar (`src/card-styles.ts` §2): a one-column margin, the `▎` bar, then
padding / header / optional separator / body / padding, with an empty-body card folded to three rows.
A `neon` card starts at column 0 with `╭`, `│` or `╰` and is never touched. Rows that are not cards
come back as the same strings; with `native`, no selection, or a selection naming a style that no
longer exists, the input array itself is returned. A style's three functions get the measured width
and the extracted heading; anything wider than the width is clipped before it is emitted, and the
frame is abandoned wholesale if any style call throws (a card is never half-repainted).

### Wrapping once, and staying wrapped

`src/card-style-wiring.ts` is armed from the same widget factory that captures the `tui` — never at
module load — and follows the sidebar backend's discipline (`src/sidebar.ts:52-90`): an own-property
marker certifies the exact `render` function installed, so a rebind, a second `session_start` or a
second copy of this package reports `already-wrapped` instead of stacking wrappers. The wrapper
captures a generation; `disableCardStyleTransform()` restores the host's own `render`, deletes the
marker and bumps the generation, so a wrapper foreign code retained becomes a pass-through rather
than an injector. The same rule governs a retained *style*: a disposed style resolves to `missing`,
and `missing` is the pass-through.

### The rail: a second surface, one transform

The rail frames its own cards — `sectionCardRows`/`headerParts` over `floatRows`/`cardTop`/
`cardLine` (`lib/shell-sidebar-layout.ts:36-47`), host sections and contributed sections through the
same call — and it frames them AFTER a part hands over its rows. A part therefore cannot restyle its
own card, and wrapping the contributed part would only ever reach the rows it contributed. The
reachable seam is one level up: the framed rows are the child of the rail's `ScrollView` in the
layout tree (`lib/shell-sidebar-layout.ts:486-499`; `ScrollView[LAYOUT_NODE]()` reports its child,
`pi-tui/dist/components/scroll-view.js:191-192`), so wrapping that component's `render(width)` sees
every rail frame the host produced — its own sections and ours, in one place.

`src/card-style-wiring.ts` walks that tree by SHAPE (the root's layout node → the `hstack` → its
second entry → that scroll view's child), never by index into the root, and requires the candidate to
expose both a layout protocol and a `render`. The wrapper is the conversation's wrapper with one
difference: the rail runs ONLY the card-style repaint. The registered transcript transforms are the
conversation's extension point (their contract is "the conversation's rows"); handing them the rail
would let a plugin corrupt a surface it never claimed. Every absence is a reported outcome
(`no-layout-root`, `no-sidebar`, `no-rail`), recorded per surface for `/bridge-status`.

### A write repaints its surface

The rail and the conversation both display bridge-owned state: a section's visibility, and the
card-style selection. Persisting is not painting — gentle-shell re-renders a rail part only when its
digest changes or its layout revision moves (`lib/shell-sidebar-layout.ts:310-350`), so a
bridge-owned row used to change the store and leave the screen alone until something else repainted
it. `src/repaint.ts` performs the two steps gentle-shell's own part owners perform
(`lib/shell-sidebar-layout.ts:105-107`, `extensions/gentle-agents.ts:2147-2148`), synchronously,
inside the row's `action()`: bump `tui.terminal[CACHE].revision` (the documented
`invalidateSidebar(tui)` effect, reached through the host's published symbol because this package
cannot import the host's modules) and call `tui.requestRender()`. No timer, no poll, no retry, and no
frame when the write changed nothing. An unavailable path is recorded and reported, not swallowed.

### The conflict that cannot be won

A post-processor downstream of this bridge can wrap the chat container's `render` and strip any box
chrome it finds — a class of consumer that re-frames the conversation, and the frame that reaches
the screen is the last one written. That can erase this frame on exactly the cards it re-frames —
bash in particular. The bridge cannot prevent that, does not try, and says so in `/bridge-status`:

> a downstream post-processor can strip or override this frame; the bridge cannot prevent it.

Nothing user-visible names such a consumer: the bridge ships to whoever installs it, and no package
it cannot see is allowed to be a prerequisite for its own report.

### Why not ask gentle-shell to add a style registry

Rejected in [state.md](state.md) (§Alternatives rejected, F/G). The package exists because the host
does not take every change; a design that waits for one is not a bridge.

## 15. The transform pipeline

The fourth surface. §14 explains how the bridge reaches the conversation component; this section
is what that wrapper does with the rows it intercepts, now that it serves more than one feature.

### One wrapper, an ordered pipeline inside it

`src/card-style-wiring.ts` installs a single `render(width)` wrapper on the conversation component.
Inside it the host's own render runs first (a host failure stays the host's), then:

1. `transformCardLines` (`src/card-style-transform.ts`) repaints the selected card style, or returns
   the host's array unchanged when there is nothing to do;
2. `applyTransforms` (`src/transform-pipeline.ts`) runs every registered transform in order, handing
   each one the previous output and clipping what comes back to the width the host passed;
3. the result goes to Pi.

With no style selected and no transform registered, both steps return their input, so the host's own
array instance reaches Pi: the identity the card styles already promised is now the whole pipeline's
promise. The wrapper keeps the generation guard and the own-property marker unchanged, so a rebind, a
second `session_start` or a second package copy still resolve to `already-wrapped` instead of
stacking pipelines.

### Why the loop belongs to the bridge, not to each plugin

`pi.registerToolRenderer` resolves when a tool row is BUILT (`docs/extensions.md`, "Custom
Rendering"), so a rendering choice made through that slot can only reach the next row. Pi exposes no
API to repaint rows that are already drawn, and the component that renders them is not reachable
from a row's `action()`. The bridge already wraps that component for card styles, so the transform
layer is a widening of a proven path rather than a new interception: one loop, one place to clip, one
place to isolate a throw, and one place `/bridge-status` reads.

A transform draws what the host already drew, so history and new rows are one picture. A tool
DESIGN (§16) is the other half of the same idea: the bridge owns Pi's one renderer resolver, hands a
design the rows the host's own card produced, and reads the live selection on every render pass, so
a design chosen after a card was drawn repaints that card instead of waiting for the next one.

### The cost of a switch, and why it is one plain frame (S13)

The live-selection rule is also what makes an invalidation unnecessary. The wrapper renders the
host's component and applies the selection to the rows it answered with, and the host's own card
cache (`ToolCardRows`, `cards-bash-v2` `extensions/quiet-tools.ts:612-624`) sits BELOW that wrapper:
it keys its frame on width, the host's style and whether the card is running, never on a design, so a
cached hit still reaches the design on every pass. A switch therefore needs no cache dropped: it is
one differential `requestRender()`, which is what the host's own `Card style` switch does
(`extensions/gentle-shell.ts:3409-3412`).

T4 originally made `requestRepaint()` a full repaint — `tui.invalidate()` then
`requestRender(force = true)` — because a setting seemed unable to reach a drawn card otherwise. On a
real transcript that is the freeze the user reported: at 600 children the invalidate re-parses 300
Markdown messages (730 ms for the frame against 21 ms without it) and the forced frame clears the
screen and scrollback and rewrites the whole buffer (6.9 MB). Numbers and the exact scenario are in
[contract.md](contract.md) §14, "What a switch costs"; `test/tool-design-cost.test.ts` bounds the
result by call counts — no tree invalidation, no prose re-parse, one differential frame, at most one
selection read per card per frame — so the bound cannot flake on a busy machine. Nothing else was
changed: the persisted selection is still read per card per frame (3.5 µs, measured) and adoption
still invalidates each card once when it wraps it.

S19 applied the same measurement to the second path. `requestSurfaceRepaint()` — a bridge-owned row,
such as a bridge card style or a section toggle — no longer invalidates the tree or forces the frame;
the `/bridge-status` wording is unchanged (the cause line never claimed a full repaint). Per-surface
proof and numbers are in [contract.md](contract.md) §14, "What a bridge-owned switch costs". The reason
it is safe is the same ordering: a bridge style is applied ABOVE the host's own frame caches, so a cached
host frame is restyled rather than frozen, and the host's rail memo already keys on the section digest.

### Ordering, isolation and the width

`snapshotTransforms()` decides the sequence once per frame, with the same rule as sections and card
styles: an explicit `order` first, ascending, then registration order. A transform that throws, or
that returns something which is not an array of strings, is skipped for that frame — the lines in
force are kept and the remaining transforms still run — and the failure is recorded with its id and
message for `/bridge-status`. Whatever comes back is clipped with `clipToWidth`, so a transform
cannot make the frame wider than the terminal — and, just as importantly, a row that already fits
the host's own measure is returned byte-identical: the pipeline never rewrites lines a transform did
not change (a no-op transform hands back the same array, and a fitting row is never measured into a
cut). The measure is `hostColumns` (TAB three columns, a grapheme cluster as a unit, CSI/OSC/APC
zero columns, so a hyperlink contributes its text and not its URL); a row that must be cut is cut
between clusters, with an open OSC-8 link closed and an active SGR reset so the shortened row cannot
leak either into the rows after it.

### Telemetry: the counts that distinguish "missed" from "never ran"

The pipeline records, per transform and per frame, what the frame did and what the transform saw:
the outcome, the number of lines it received, and whatever the transform reported through
`ctx.report(...)` — candidates examined, cards recognised, cards rewritten, and the shapes that
matched, by name (`src/transform-pipeline.ts`, `TransformFrameCounts`). It exists because a real TUI
could not tell two failures apart: a wrapper that never reaches the conversation, and a grammar that
reaches it and recognises nothing. Those two read differently in the record — zero lines received
versus candidates without recognition — without another round of guessing.

Two rules make the record safe to keep. **Counts only:** a frame carries the user's private output,
so no line and no text is stored; numbers are clamped to non-negative integers and a shape name is
kept only when it is a name (lowercase letters, digits, `_`, `.`, `-`, at most 24 characters, at most
12 per frame), which means a line cannot be smuggled into the record through that field. **Nothing
it does reaches the frame:** the counts are collected in the call that already produces the output
(no second pass), and every step of recording is guarded, so a transform that reports nonsense, or
none at all, loses counts and never a frame. `/bridge-status` prints the counts on the transform's
own line, and the block is still absent entirely when no transform is registered.

A transform that reads `float` cards and the host's `neon` outline reports those two names (the
bridge's card-style repaint is `float`-only, so a neon card reaches a transform untouched), so the
next step after a real-TUI report is data-driven: a `skipped` line with candidates and no
recognition names a grammar gap, and recognition with `0 rewritten` names a setting.

## 16. The tool-design bus (S4–S7)

### One resolver, because Pi composes

`pi.registerToolRenderer(resolver)` (`dist/core/extensions/types.d.ts:546`) is the sanctioned way to
choose how a tool's card is drawn. Resolvers COMPOSE — Pi chains every extension's resolver
(`dist/core/extensions/runner.js:550-553`) — so two plugins that each called it would each wrap the
other's component and neither could see the other's choice. The bridge therefore registers exactly
ONE resolver while arming (`installToolDesignResolver`, from the same `session_start` that arms the
rows and the sidebar) and returns `next()`'s renderers untouched for a tool with no design.

### The wrapper keeps the frame

For a tool that HAS at least one design the resolver returns a copy of the host's renderers whose
`renderCall`/`renderResult` wrap the component the host built. Every other member — `renderShell`
included, which decides whether the host frames the card itself — is the host's own value. The
wrapper's `render(width)` is:

```
hostComponent.render(width) → design.apply(rows, { width, tool, theme, part, render? }) → rows
```

so the chrome (`neon`, `float`, whatever the host's Card style is) exists before the design sees
anything. `invalidate()` and the optional mouse/key-release members are delegated, so the card keeps
behaving exactly as the host's did — only the rows can differ.

`part` is `"call"` when this row set came from `renderCall` and `"result"` when it came from
`renderResult` (S12). The two members are wrapped SEPARATELY, so the design is told which half of the
card it is drawing instead of having to infer it from the rows: the host draws both with the same
chrome, and a float result row that begins with `$ ` is indistinguishable from a float heading.

`render` is the call's own state, snapshotted on every pass from the context Pi hands the renderer
(`renderCall(args, theme, ctx)` → index 2, `renderResult(result, options, theme, ctx)` → index 3,
`dist/core/extensions/types.d.ts:536-538`; both resolver and adoption paths wrap through the same
`wrapRenderers`, so both reach it). Only the six documented fields cross, each by value and type-checked
(`args` by reference: it is the host's own object), and the snapshot is taken on every pass because
`durationMs` and `isPartial` change after the card was built. Pi's `state`, `invalidate` and
`lastComponent` are deliberately left out: they are host internals, and a function crossing the
boundary could be used to damage the host. A card wrapped by an older copy of this package (the wrapper
marker is shared) keeps that copy's behaviour, without `render`, until the host rebuilds it.

Wrapping even when nothing is selected is deliberate. Pi resolves the renderers ONCE per card, when
it constructs it (`interactive-mode.js:1816-1818,2957-2961,3028-3032,3376-3380`), and re-renders that
same component on every frame. A card built while the design was unselected must still be able to
follow a later selection, so the wrapper reads the LIVE selection on every pass, with the call's own
arguments (`render?.args`) so that a scoped claim on the tool is a candidate for THIS call and no other;
with no selection (or a selection whose design was disposed) it returns the host's own array instance,
byte for byte. A host that hands no render context passes `undefined`, no scoped claim applies, and the
card is drawn exactly as before.

### The `Cards` line is `Card <tool>` — or `Card <line>`

The selection is a customize line in `Cards`, and the category already names its lines
`Card <what>` (`Card style`, `Card content`), so a design line follows the same vocabulary rather
than showing a bare tool name, which reads like a category of its own. `src/tool-design-rows.ts`
builds it from the line's owner: an ungrouped design's implicit tool line reads `Card` plus the
tool's readable words (`deriveRowLabel`), and a grouped registration's line reads `Card` plus the
`line` id's words. Both are clamped to two words after the prefix because the row-name rule is one
to three plain words (`src/row-names.ts`). A long name keeps its TAIL — `mcp__engram__mem_save` reads
`Card mem save`, because the leading words are the same for every tool of that server — a name with
no words reads `Card tool` (or `Card line` for a grouped line), and two sources that clamp to the
same name are told apart with one shared ordinal (`Card mem save`, `Card mem 2`, or `Card tools`,
`Card tools 2`) exactly the way sections are, so the result still passes the shape rule. Nothing
persisted moves with the name: the store is keyed by the tool name or the line id and a value is the
design's id, so the line can be renamed without losing a choice.

### When an earlier resolver answers first (S10)

Pi composes resolvers in extension load order (`runner.js:550-553`); `loader.js:298-302` only pushes,
so there is no reordering API. A resolver loaded before this package that answers WITHOUT calling
`next()` — the host's quiet bash resolver while `Card content` is `minimal`
(`extensions/quiet-tools.ts:910-914`) — hides `toolDesignResolver` completely. The user's install has
gentle-pi first and this bridge last, which is why a resolver-only design never reached a card
(L3/E6).

`src/tool-design-adoption.ts` is the second path. The conversation wrapper from
`src/card-style-wiring.ts` already holds Pi's chat container, whose children are
`ToolExecutionComponent`s; each carries `toolName` and the `toolDefinition` Pi resolved
(`tool-execution.js`, constructor near line 37-45). On every conversation render, BEFORE the host
renders its children, the adoption pass looks at each child: a string `toolName` with at least one
registered design is adopted by replacing its `toolDefinition` with the same `wrapRenderers` wrapper
the resolver path uses, then invalidating the card so its stored renderer re-runs through the design
(`invalidate()` → `updateDisplay()`, `tool-execution.js:64-68,164-175`). `wrapRenderers` stamps every
wrapper with `TOOL_RENDERERS_WRAPPED`, and both paths check it, so a card the resolver already
wrapped is reported `already` and never wrapped twice. New cards (`/tree`, reload, session switch)
are new children and are adopted on the next pass, and because the wrapper reads the live selection
on every frame, `native` and a later selection both apply to the same already-constructed card (S2).

Every absence is reported: a child that is not a card, a `toolName` that is not a string and a tool
with no designs are ignored; a missing, non-object, unwrappable or unwritable `toolDefinition` is
recorded as an `(adoption)` failure and the host's own card is drawn; a throwing `invalidate` is
recorded once and the wrapped definition still applies on the next frame. The pass never throws into
Pi's render loop.

### Per tool name, never per bash — joined into lines

`src/tool-designs.ts` keeps one registry per line: an UNGROUPED design gets an implicit line keyed by
its tool name, a GROUPED one names its line (`line` + `tools`) and several registrations naming the
same line join it, with the line's tool set the union of their `tools`. Nothing else is special-cased:
no known-tool list, no branch on a name. The claim is the pair (`line`, `tool`) and the scope belongs
to it: `scopes` maps each tool of `tools` to the scope of THAT claim, `scope` is the shorthand for the
same scope on every tool of the registration, and a tool with no entry claims every call of it. One
line may therefore own some of its tools unconditionally and narrow others — `Card tools` paints
bash/grep/find/ls/read for every call and write/edit only under `skills/` or `odd/`, while `Card diff`
carries the generic claim on write/edit. The claim table is applied per TOOL: a tool has at most ONE
UNSCOPED claim, and only a tool's SECOND UNSCOPED claim refuses — that registration is refused whole
and reported, even when the clash is on one tool of a registration that names several. One scope per
(`line`, `tool`) is a rule of the LIVE registry: every LIVE registration of one line that names tool T
carries the same scope object for T (`===`; both absent counts as equal), a registration that does not
name T does not constrain it, and re-registering the same (`line`, `id`) is exempt, so a plugin may
replace its own design with a fresh scope object. Any other disagreement refuses the whole registration
under the `scope` kind. An unscoped claim beside a SCOPED one is accepted in either order — a legacy
`Card <tool>` registration beside a tool that only SCOPED claims name is accepted, because a scoped
claim never owns the whole tool. A
scope is declared on the GROUPED shape only (`line` + `tools`): an ungrouped registration IS the
tool's own line and means every call of it, so `{ tool, scope, … }` and `{ tool, scopes, … }` are
refused whole and reported. A claim that declares a scope owns only the calls its predicate matches,
so any number of scoped claims may name one tool beside the one unscoped claim, and resolution is then
per CALL rather than per tool: the scoped claims that match the call answer first, in claim PRECEDENCE
order (the order their lines were created), the first one whose stored value is a live design covering
the tool paints the card, a line that declines (`native`, `missing`, `not-covered`) lets the next one
answer, and the single unscoped claim answers last whatever its line's age. Claim PRECEDENCE is the
line creation order and survives the disposal of one of a line's values; DISPLAY order — the `Cards`
rows and the `/bridge-status` block — follows the first LIVE entry, and the two orders are computed
separately. When every candidate declines, the LAST candidate's OWN answer stands — `missing` when its
stored id names a disposed design, `not-covered` when that design does not name the tool, `native`
when the last candidate's line has no stored value or stores `native` (a line never selected reads
`native`). That last candidate is the unscoped claim whenever the tool
has one, and it is a candidate on EVERY call of its tool, so a call no scoped claim matches falls
through to that line's own answer instead of stopping at `native`. `native` is therefore the answer in
exactly two cases — the last candidate's line has no stored value or stores `native`, or no candidate
exists at all: the tool
has live claims and every one of them is scoped, so a call without `args` has no scoped candidate and a
call with `args` keeps only the scoped claims whose `matches` accepted it. A tool with NO live claim
at all is outside that rule and falls back to its historical per-tool value (`native` in an ordinary
registry). Overlap cannot be proven at registration, so it is ordered and never refused, and a scope
that throws counts as no match — one recorded failure, never a throw into the frame. `src/tool-design-rows.ts` turns each line into one `Cards` line — the host's own card
(shown `default`, stored `native`) plus one value per design, in registration order —
and persists the selection per line in the bridge's own `bridge-tool-designs` store, never in the
host's config: ungrouped lines keep the historical flat `selections` map, and a grouped line's value
travels in the same document under the reserved `$lines` key, so one `store.get` per card per frame
serves both (`src/store.ts` reads the file on every `get`). Migration runs once, at registration: a tool joining a line with no stored value lends it its
legacy per-tool value when that value names a design of the line. The stored value is the design's
`id`, so renaming a label never moves the bullet; a selection whose design left the line resolves to
`missing` and draws the host's card, and a tool the selected value does not paint resolves to
`not-covered` and also draws the host's card (S6/D4). A scoped claim's `description` rides in the SAME
preview row of its line: ` — scope: <description>` when the line's scoped claims share ONE scope
object, and ` — scope: <tool[, tool]>: <description>` per distinct scope otherwise, so the menu never
needs a second row to say which calls a line owns. The tool names appear only when a line's scoped
claims carry SEVERAL DISTINCT scope objects; a line whose scoped claims — however many of its tools
they span — all share one scope object prints that one description, with no tool names.

Registration goes through the same attribution as every other surface (`src/plugin-lines.ts`,
`PluginSurface` includes `"tool design"`), so a plugin that contributes ONLY designs still gets its
one INTEGRATIONS line and the same accepted/rejected counts.

### What it reports

`/bridge-status` lists every tool with designs and its coarse `selection` (the answer with no
arguments — `native` for a tool only scoped claims name, however a given CALL resolves). Its claims
come in ONE of two shapes, never both: a tool with at least one scoped claim carries `claims`, every
line claiming it with the value stored for it (a scoped claim also showing the scope of THAT tool's
claim, a claim without one showing none), and no `line`; a tool claimed by one unscoped grouped line
carries `line`, the line whose switch paints it, and no `claims`, so its report stays byte-identical to
the one the previous release printed; a tool whose
only claim is its own ungrouped `Card <tool>` line carries neither field, exactly as before. The block
also lists whether the wrapper has mounted a card for it (`wrapper mounted on 2 cards` — the answer to
"is this card even wrapped?" via the resolver), how many cards the adoption
pass reached (`adopted 1 card` — the answer when a resolver ahead of the bridge answered first), the
conflicts a replacement, a duplicate label or a second-line ownership produced, and the designs that
threw. A grouped line also gets a line report: the line, its row name, its tools, and each value with
the tools it `covers`. `not covered` is a PER-TOOL `selection` reading beside `missing` and `native`,
not a line-report field; and with a scope in play that per-tool answer describes only the calls no
scoped claim covers, so a tool claimed only by scoped claims reads `native` there while a matching call
can answer `not-covered`. Failures are deduplicated by (tool, id, message): a design
that throws on every frame is one fact, not one line per frame. Two orders stay separate: claim
PRECEDENCE is the order the lines were CREATED, and it survives the disposal of one of a line's values
(a line keeps the place it earned while any of its designs is live), while DISPLAY order — the `Cards`
rows and this block — follows the first LIVE entry, so an unscoped registry keeps exactly the row and
status order the previous release produced.

## Limits

- **Internals, not an API.** Everything here depends on one constructor line, one adapter
  shape and one call chain in code gentle-shell does not export. No upstream row-provider
  hook exists today.
- **The hook backend is unverified.** `Symbol.for("gentle-pi.customize-row-providers")` is
  accepted as a plain array or an object with a callable `register`, and anything else is
  reported as unusable so the capture backend takes over. No host has been observed emitting
  that registry, so the pushed provider's shape (`{ id, rows }`) is an inference.
- **`Array.prototype.map` is patched**, briefly: one synchronous factory call, restored in
  `finally`. A callback that stores the patched function for later use is out of scope;
  nothing in the observed chain does that.
- **Capture is heuristic.** A menu that builds rows through a different array (or not at
  all) yields no capture. Reported, never silent — but not fixed.
- **A new category depends on the capture proof.** The renderer types `category` as a closed union
  (`lib/visual-customize-view.ts:105`) but derives its pages from the rows at runtime, so a new
  category appears only when the early injection (see "A brand-new page") ran; a host that renames
  its default page, or a menu the proof cannot prove, gets the late path and no new page. `Keymaps` is
  reserved.
- **Tests exercise a fake host, not the TUI.** The suite runs under `node --test`; the end-to-end
  ones drive a fake host that models `gentle-shell.ts:3550-3562` and a fake sidebar that models
  `lib/shell-sidebar.ts` + `lib/shell-sidebar-layout.ts`'s card frame. The capture technique itself
  is verified in the real TUI only by the reference probe; the sidebar section surface has never
  been seen in one.
- **Sections cannot be interleaved with the host's own status cards.** A section can start, end, or
  sit after a painted rail part (`todo`, `jobs`, `agents`, `footer`), but `CHANGES`, `STATS` and
  `INTEGRATIONS` are built in a closure (see §12); slotting one between them is not supported.
- **The sidebar widget's visual footprint is unconfirmed** (see §12): the `tui` is acquired through
  a widget factory, and whether an empty component is invisible has not been observed.
- **The card-style repaint is proven against a fake conversation, not a live one** (see §14). The
  fixture rows are real `lib/shell-card.ts` output, but the component tree is Pi's documented shape,
  and the downstream-override conflict (§14) cannot be reproduced without a second post-processor
  running in a real session.
- **A blank body row is byte-identical to a card's opener/closer** (`cardLine("")` is a bar and
  spaces), so a card containing a blank body row is detected as ending at that row; the remaining
  rows stay as the host drew them. A heading's hint is only split out when its style runs prove it,
  and the heading glyph is stripped by a one-character rule. Both are documented in the transformer
  and are the price of not parsing the host's intent.
- **Async factories are reported, not supported.** `Promise.resolve(factory(...))` accepts a
  promise (`interactive-mode.ts:3136`), but the capture window closes with the synchronous
  call. A promise-returning factory is returned untouched and recorded as
  `uncaptured (async-factory)`, so no rows are injected; this is a test case, not a fix.
- **The runtime handshake is proven in-process.** The suite resets `globalThis`, simulates an
  early loader and loads the real example more than once under `node --test`; two live Pi
  extensions loading in either order inside one running session have not been observed, and
  neither has a real second major version at the slot (the skew branch is driven by a fake
  object).
