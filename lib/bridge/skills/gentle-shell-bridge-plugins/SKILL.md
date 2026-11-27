---
name: gentle-shell-bridge-plugins
description: "Trigger: build or extend a Pi plugin adding a /gentle:customize row or page, sidebar section, card style, transcript transform, per-tool card design or persisted state to gentle-shell through gentle-shell-bridge."
license: MIT
metadata:
  author: gentleman-programming
  version: "1.1"
---

## Activation Contract

Read `src/index.ts`, `docs/contract.md`, `examples/bash-card.ts` first; never work from memory.

Not for: Pi-native-only work (tools, commands, shortcuts, renderers) or a plain host theme.

- Reach it with `onBridgeApi(handler, pi.events)` in `session_start` — at once when already published, otherwise on `gentle-shell-bridge:ready` (`src/api.ts`).
- `bridgeApi()` answers only what is true NOW: `undefined` means not installed, or not published yet.
- Never patch the host, re-implement interception, or duck-type its objects.

## Hard Rules

- **Keep every disposer**, call it on `session_shutdown`: each `register*` returns one; a stable namespaced `id` replaces in place.
- **Registrations are evaluated when the host builds the surface**: read live state in `current()`, persist in `action()`.
- **Failures are reported, never thrown at the menu.** Invalid registration throws at the call site and lands in the plugin's INTEGRATIONS line; a build throw loses only its surface.
- **`Keymaps` is RESERVED for row providers** — refused and reported: that page captures keys and claims a footer a plain row could never honour.
- **A card style repaints the host's frame** from measured pieces: `top({width, title, hint})`, `line({text, width, first})`, `bottom({width})`. Never parse a card back.
- **A transform** takes the rows plus `ctx.width`, returns rows. Honour the width; report COUNTS ONLY (`ctx.report?.({candidates, recognised, rewritten})`), never card text.
- **A tool design** transforms rows the HOST card produced, by tool name. Never call Pi's `registerToolRenderer`, draw a second grammar, rewrite unchanged bytes, or label a design `default`/`native` (reserved). `ctx.render` is optional; arrays register several. A grouped `{ line, tools, id, label, apply }` paints tools from ONE `Card <line>` switch; two UNSCOPED claims of one tool are refused whole, and no scope covers EVERY call. Fields, lines, preview: contract §14.
- **A scope claims CALLS, per tool.** A claim is `(line, tool)`: `scopes: { write: scope }` narrows that tool only, so one line may paint some tools whole and others conditionally; `scope` is shorthand for the same scope everywhere. Scoped claims answer in line-creation order, unscoped last; a line storing `default` (`native`) declines. GROUPED only; `scope` with `scopes` refused; one scope per tool per line (`===`, same `(line, id)` excepted); `description` required (the preview); a throw matches nothing. Without `args`, only unscoped claims answer. If all decline, the LAST answer stands (`missing`, `not-covered`, stored `native`); no candidate answers `native`; with NO live claim the historical value answers.

- **Plugin state stays the plugin's**: `createStore(pluginId)`. `createStore` reserves nothing, so never take a bridge id — `bridge-card-style` and `bridge-tool-designs` are the bridge's own files.
- **`placement` names a PLACE.** Rows: `start`, `end` (default: category tail), or `{ after: "<provider id>" }` — bridge ids only, never labels. `after`: opted anchor in its category, unopted in the tail. Opted-in boundaries follow each row's ACTUAL category (`row.category ?? provider.category`), one block per category, so a rendered `choice.setting` pair never splits. `placement`/`order` opt in; naming neither keeps the tail append. Inside a slot: finite `order`, then the rest, ties by `id`, never load order. Unknown/cross-category ids, cycles, unbuilt pages → end; malformed → refused (provider at end); hook cannot honour `start`/`after`; `/bridge-status` reports the actual landing (a refused write stays in the tail). Sections: `start`, `end` (default: after native cards), a section, or part `todo`/`jobs`/`agents`/`footer` — part granularity only. A hidden/folded anchor keeps its slot; an unpainted native part falls FORWARD to the next painted part (ending at `footer`); unknown id, cycle or malformed falls to the END. Never persisted.

## Decision Gates

| Need | Call |
| --- | --- |
| Rows in a host category or a page of your own | `registerRows({id, category, rows, placement?, order?})` |
| Toggle vs button row | rows sharing one `choice.setting` vs `action` with no `choice`; names: one to three plain words, none of `→ ← ↑ ↓ : . \| / \ [ ] ( ) { }` |
| Sidebar card (bridge adds its `Sections` toggle) | `registerSection({id, title, lines, meta?, placement?, order?})` |
| Card chrome, conversation and rail | `registerCardStyle({id, label, frame})` |
| A choice that must reach cards on screen | `registerTransform` |
| One tool's card | `registerToolDesign({tool, id, label, apply})` |
| Only some calls of a tool | `registerToolDesign({line, tools, id, label, scopes: {<tool>: scope}, apply})` |
| Several tools behind ONE switch | `registerToolDesign({line, tools, id, label, apply})` |
| What a tool draws now | `resolveToolDesignSelection(tool, args?)` |
| Persistence / repaint after a bridge write | `createStore` / `requestRepaint()` |

OPTIONAL on an older object: `registerCardStyle`, `registerTransform`, `registerToolDesign`, `resolveToolDesignSelection`, `requestRepaint` — gate with `typeof api.x === "function"`.

## Execution Steps

1. Pick the smallest surface; read its contract section.
2. Register from `session_start` through `onBridgeApi`, keeping disposers; copy the handshake from `examples/bash-card.ts`.

```ts
import { onBridgeApi, type BridgeApi } from "gentle-shell-bridge";

export default function plugin(pi: any): void {
  const offs: Array<() => void> = [];
  pi.on("session_start", () => {
    offs.push(
      onBridgeApi((api: BridgeApi) => {
        offs.push(api.registerRows({ id: "acme.banner", category: "Cards", rows: () => [] }));
      }, pi.events),
    );
  });
  pi.on("session_shutdown", () => {
    for (const off of offs.splice(0)) off();
  });
}
```

The factory returns nothing: dispose through events.

3. Verify with `/bridge-status`: backend, capture outcome, provider/section/tool-design failures.
4. Degrade: with no bridge the plugin still loads — `bridgeApi()` is `undefined`, the handler never fires.

## Output Contract

Return a plugin module that registers only what was asked, from `session_start`, keeping every disposer, gating optional members, using stable ids and legal row names, owning its state. Say which surfaces registered, were absent or refused, and cite `/bridge-status`.

## References

- `../../docs/contract.md` — every call, argument, guarantee (sections: Surface 2).
- `../../examples/bash-card.ts` — canonical worked example: design, style, section, rows, store.
- `../../docs/architecture.md` — why the interception exists (`§12` for the rail).
- `../../README.md` — purpose, quick start, limits.
