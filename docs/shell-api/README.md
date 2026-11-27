# odd-worktree's shell API

odd-worktree publishes the one extension point a plugin can use to reach gentle-shell: settings rows
and pages, sidebar sections, card styles, transcript transforms, per-tool and per-message card designs,
and a small persisted store. It is this package's own code — `lib/shell-api/` — so a plugin needs no
second plugin installed, no build step and no import: it reads one process-global symbol.

## Quick path

1. Read the slot and gate it on schema + version — nothing else tells you whether the API is there.
2. Register what you contribute from `session_start`, or when the `gentle-shell-bridge:ready` event
   announces a later publication — an absent symbol there is "not yet", never "not installed".
3. Keep the disposer each `register*` returns, so a `/reload` replaces your registration instead of
   stacking a second one.

```ts
const KEY = Symbol.for("gentle-shell-bridge/api/v1");
const isApi = (value: any): boolean =>
  typeof value === "object" && value !== null &&
  value.schema === "gentle-shell-bridge/api" && value.version === 1 &&
  typeof value.registerRows === "function" &&
  typeof value.registerSection === "function" &&
  typeof value.createStore === "function";

const api = isApi((globalThis as any)[KEY]) ? (globalThis as any)[KEY] : undefined;
```

A registration is evaluated when gentle-shell builds a menu or paints a frame, not when it is made, so
rows and sections always reflect live state. Anything a registration throws costs that registration's
own rows, never the menu.

## What you can extend

| Surface | What a plugin gets | Call |
| --- | --- | --- |
| Customize rows | Toggles, button rows and inline editors in a category gentle-shell already renders, or a page of your own, in a slot you place explicitly or at the end | `registerRows(provider)` |
| Sidebar sections | A card in gentle-shell's rail — start, end, or right after another section or a native rail part — with its show/hide toggle contributed automatically | `registerSection(section)` |
| Card styles | A frame style applied to cards gentle-shell already drew, in the conversation and in the rail | `registerCardStyle(style)` |
| Transcript transforms | A pass over the rows gentle-shell produced for a finished message | `registerTransform(transform)` |
| Tool card designs | A design for one tool name, behind the package's single `pi.registerToolRenderer` resolver, so two plugins never stack wrappers on one tool | `registerToolDesign(design)` |
| Message card designs | A design for one Pi custom message type, with the host's own rows in and your rows out | `registerMessageDesign(design)` |
| Store | A namespaced JSON document per plugin id under `<config home>/gentle-shell-bridge`, kept apart from the host's files | `createStore({ pluginId })` |
| Repaint | One differential frame after a write, instead of waiting for the next one | `requestRepaint()` (§9) |

## Details

| Your task | Start here |
| --- | --- |
| Call any `register*` correctly and know what each one guarantees | [contract.md](contract.md) |
| Understand how the API reaches a host that offers no plugin hook, and why it is built this way | [architecture.md](architecture.md) |
| Know what is persisted, where, and what happens to a file it cannot use | [state.md](state.md) |
| See a real consumer end to end | [examples/bash-card.ts](examples/bash-card.ts) |

## Limits

- **No upstream hook exists.** The API depends on gentle-shell internals, so a host that changes how it
  builds its menus is a fix here, in one place — not a supported extension point in the host. If Pi or
  gentle-shell ever ships a row-provider hook, this surface should shrink to a thin adapter over it.
- **The row capture is heuristic.** Rows are recognised by shape inside one synchronous factory call,
  and the `Array.prototype.map` patch is restored in a `finally`. A menu built differently produces no
  capture, and the rows you registered simply do not appear.
- **`Keymaps` stays reserved for row providers.** The host's keymap page captures keys and claims a
  footer, so rows there could never honour what they advertise.
- **Row placement needs the captured host array.** Where it is unavailable (the hook backend), each
  category is ordered by `order`/`id` and a `start`/`after` request falls back to the end: the API never
  claims a host-relative landing it cannot see.
- **A section is placed at the granularity of the host's rail parts.** The host's own status cards
  (`CHANGES`, `STATS`, `INTEGRATIONS`) are built inside a closure nothing can reach, so "after a status
  card" is not offered; a placement names a section or one of `todo`, `jobs`, `agents`, `footer`.
- **Card styles and transforms are repaints, not host features.** They depend on the host's frame
  grammar, and a downstream post-processor that re-frames the conversation can still override the result.
- **Tests run against a fake host.** The suite in `tools/shell-api/` covers the public API against a fake
  menu, rail and transcript that model the host's shapes; the real TUI is where a change is finally seen.

## Compatibility you can rely on

The public identity is frozen on purpose, so an existing plugin and a user's saved choices keep working:
the slot `Symbol.for("gentle-shell-bridge/api/v1")`, the schema `gentle-shell-bridge/api` at version 1,
`VERSION` `0.16.2`, every `Symbol.for("gentle-shell-bridge…")` key, the `gentle-shell-bridge:ready`
event, `bridgeApi()`/`onBridgeApi`, and the store directory `<config home>/gentle-shell-bridge`. None of
those names change when this package changes.

## Origin and compatibility in one paragraph

This API was born as the standalone `gentle-shell-bridge` package and odd-worktree now owns it, so
nothing external is needed — a standalone bridge that is still installed is simply unnecessary, and if
both are loaded they share the same global state ("first wins"), which is why the compatibility names
above never move.

## Next step

Read the first section of the [contract](contract.md), then register one row against the fake host in a
scratch extension before touching a real one.
