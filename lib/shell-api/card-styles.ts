/**
 * Card styles (S1–S4, S12): the bridge's selection, and the facts a repaint depends on.
 *
 * This module buys nothing from the host and asks it for nothing. A registered style is chrome the
 * bridge paints over the frames gentle-shell already drew, which only works if two things are
 * PROVEN rather than assumed: the path from the `tui` this package captures to the component that
 * renders the conversation, and the exact grammar of the lines a `float` card is drawn with. Both
 * follow, with citations. The fixtures that pin them live in `test/fake-transcript.ts`, and
 * `test/card-transcript-path.test.ts` walks the path end to end.
 *
 * ## 1. The path: `tui` → the conversation component
 *
 * Where the `tui` comes from: Pi exposes no `tui` getter, so the only hand-out is the widget
 * factory `ctx.ui.setWidget(key, (tui, theme) => Component)`. This package already captures it
 * (`./extension.ts:108-109`, `docs/contract.md` §9).
 *
 * From there, three candidates, in the order this bridge trusts them. All of them end at the same
 * live object, so the walk can try them in sequence without guessing:
 *
 * a. **`tui.layoutRoot` → its layout entries → the primary `ScrollView` → its child.** Pi mounts
 *    the fullscreen tree by calling `tui.setLayoutRoot(fullscreenLayoutRoot)`
 *    (`pi-coding-agent/dist/modes/interactive/interactive-mode.js:623-629`), and that root is a
 *    `VStack` whose FIRST entry is the transcript `ScrollView`
 *    (`dist/modes/interactive/chat-viewport.js:4-11,22-25`). The root's entries are readable
 *    through the layout protocol, `LAYOUT_NODE()` (`pi-tui/dist/layout-node.d.ts:2,36-38`, the
 *    symbol being `Symbol.for("@earendil-works/pi-tui/layout-node")`), and the `ScrollView`
 *    reports its own child the same way (`pi-tui/dist/components/scroll-view.d.ts:57`).
 *    **Limit:** `layoutRoot` is a TypeScript-`private` class field
 *    (`pi-tui/dist/tui-alt-screen.d.ts:44`) with only a setter in the public interface
 *    (`tui.d.ts:253-256`), so it must be read through a widened cast. It exists only on the
 *    fullscreen renderer (`TuiAltScreen`, `mode === "fullscreen"`); the regular renderer
 *    (`TuiMainScreen`) has no such field and mounts its children directly.
 * b. **`tui.children[0]` → the document `Container`.** `children` IS public
 *    (`pi-tui/dist/tui.d.ts:223-231`) and Pi fills it in BOTH renderer modes, in a fixed order,
 *    with `documentContainer` first (`interactive-mode.js:623-625,722-731`). This is the most
 *    stable hop, because it uses only a declared member of the public `TUI` interface.
 * c. **`tui.children[0].children[2]` = the chat container.** The document container's children are
 *    `[headerContainer, loadedResourcesContainer, chatContainer]`
 *    (`interactive-mode.js:404-407`), so index 2 is the component that renders the conversation
 *    cards. A downstream post-processor that re-frames the conversation uses exactly this.
 *    **Least
 *    stable:** the index is insertion order, not a contract.
 *
 * `tui.render(width)` itself, `tui.getScreenLines()` and `tui.getPrimaryScrollView()` are NOT
 * candidates: the first two hand back the composited screen (rail, editor, scrollbar column)
 * rather than the conversation, and the third is `private` and caches a layout, so it can be stale
 * between frames.
 *
 * **When it is absent** every hop simply fails: no `layoutRoot` in regular mode, no `children`
 * before Pi mounts (`interactive-mode.js:623` runs during `init`), a non-`ScrollView` first entry,
 * or a document without a third child. Then there is no transcript, and the feature must report
 * `unstyled (no-transcript)` and stay inert (S4) — inventing a component or creating the state
 * would fabricate host state and mask the wiring mistake (same rule as `./sidebar.ts:264-274`).
 *
 * ## 2. The `float` grammar (`gentle-shell/lib/shell-card.ts`, read-only)
 *
 * `cardStyle()` returns `"neon"` only when the global slot is exactly `"neon"` and `"float"`
 * otherwise (`:43-45`), so an unknown style degrades to float instead of breaking: that is what
 * lets a third style exist at all. Float applies only when the style is float AND
 * `width >= FLOAT_MIN_WIDTH` (10) AND the theme can paint a background (`:275-276,336-338`).
 *
 * A float card at width W, in order (`:314-333`, chars at `:105-108`):
 *
 * 1. one-column transparent margin, then the tone background opener, on EVERY row (`:343-346`);
 * 2. a padding row: `▎` + spaces, i.e. `cardBottom` with no content (`:186-196`);
 * 3. the header row: `▎` + one space + `✿ <title>` (title role) + `· <subtitle>` when present,
 *    then spaces (float's "rule" is a space, `:108`), then ` <hint> ` right-aligned in the dim role
 *    when it fits, then two spaces (`cardTop`, `:141-160`);
 * 4. a padding row between header and body — ONLY when a body exists (`:314-333`);
 * 5. body rows: `▎` + one space + text + padding + one space (the float "right rail" is a space),
 *    where the text was wrapped to `W - 6` columns by the caller (`cardLine`, `:172-184`;
 *    wrapping: `:203-215`) and is TRUNCATED with `…` if it still overflows;
 * 6. the closing rule: a padding row, identical to row 2.
 *
 * So: opener = padding, header = bar + `✿ `, closer = padding after the body; body rows are the
 * only rows carrying text besides the header, and an empty body is just `padding, header,
 * padding` (3 rows). A card with no hint ends the header row with spaces and no dim segment: the
 * hint is painted `HINT_ROLE` = `"dim"` (`:84,157`) while the title is painted the tone's title
 * role (`:78-83,148`), which is the only unambiguous separator between the two — they are both
 * followed by runs of spaces at the character level.
 *
 * `neon` (`OUTLINE_CHROME`, `:105`) differs in every chrome character and paints no background
 * and no margin: `╭─ ✿ title ──── hint ╮` / `│ text │` / `╰──────╯`. A detection pass must
 * therefore classify by position, not by "contains a box character": a float row starts with
 * `" ▎"` (margin, then the accent bar) and a neon row starts with `╭`, `│` or `╰`.
 *
 * ## 3. What is NOT proven
 *
 * - That a `float` conversation card is always drawn through `floatRows`: the callers observed in
 *   gentle-shell pass `previewRows` or use their own component
 *   (`extensions/quiet-tools.ts:649,678`, `lib/gentle-ai-renderer.ts:120,218`). The frames are
 *   produced by `shell-card.ts` in every case observed, but the fixture reproduces `floatRows`
 *   output only.
 * - Whether the host will draw a card at a width below 10 (it draws the outline frame instead,
 *   `:336-338`).
 * - Whether a widget component that renders zero rows leaves the editor area untouched; that is
 *   the sidebar's open question (`./sidebar.ts:80-90`), inherited unchanged.
 *
 * ## 4. The selection
 *
 * `native` by default, keyed by the bridge's own plugin id (`bridge-card-style`), never the host's
 * `visual-customization.json`. The stored value is a style id, and it resolves to three answers —
 * `native`, the live `style`, or `missing` when the style it names was disposed — without ever
 * throwing, because that answer is what the transformer degrades from (S12).
 */

import { snapshotCardStyles } from "./bus.ts";
import { CARD_STYLE_NATIVE } from "./card-style-line.ts";
import { createStore } from "./store.ts";
import type { CardStyleSelection } from "./types.ts";

/**
 * The bridge's own plugin id for the selection: one namespaced file, never the host's
 * `visual-customization.json` (whose key list is closed, see `./visibility.ts` for the same
 * reasoning about sections).
 */
export const CARD_STYLE_STORE_ID = "bridge-card-style";

/** The one key in that file. */
export const CARD_STYLE_STORE_KEY = "cardStyle";

/**
 * The persisted selection: a style id, or `native` for "the bridge does not touch the
 * conversation". Anything unreadable or not a string falls back to `native` — a hand-edited file
 * can never select a style the user did not choose, and `native` is always safe.
 */
export function getCardStyleSelection(): string {
  const stored = createStore(CARD_STYLE_STORE_ID).get<unknown>(CARD_STYLE_STORE_KEY, CARD_STYLE_NATIVE);
  return typeof stored === "string" && stored.trim() !== "" ? stored : CARD_STYLE_NATIVE;
}

/**
 * Persist the selection, FIRST and synchronously: the host repaints after an action returns and
 * re-reads `current()` when it does, so the bullet cannot land on a value that was never written.
 */
export function setCardStyleSelection(id: string): void {
  createStore(CARD_STYLE_STORE_ID).set(CARD_STYLE_STORE_KEY, id);
}

/**
 * What the stored selection means right now: defined with the other registrations in
 * `./types.ts`, because a tool design reads it from its own context (S22); re-exported here so the
 * card-style module keeps answering with one name.
 */
export type { CardStyleSelection } from "./types.ts";

/** Resolve the persisted selection against the live registry. */
export function resolveCardStyleSelection(): CardStyleSelection {
  const id = getCardStyleSelection();
  if (id === CARD_STYLE_NATIVE) return { kind: "native" };
  const style = snapshotCardStyles().find((candidate) => candidate.id === id);
  return style === undefined ? { kind: "missing", id } : { kind: "style", style };
}
