# file-card-theme

The skill/ODD file card stops owning its own switches and joins the bridge's `Card tools` (`activity`) value, and it finally wears the theme's roles the reference PR assigns — heading and document body.

Base: main@ab03e54. Branch: feat/file-card-theme. Worktree: /home/jona/dev/projects/odd-worktree-worktrees/file-card-theme

## Specs

S1 — One switch, not three. The two preferences `Card skill` and `Card odd` (`lib/cards-customize.js`, provider `odd-worktree.cards.file-switches`, document `<home>/card-files.json`) are removed. The file card is painted when the bridge's `Card tools` line (`tools`) resolves to the activity design (`odd-worktree.bash-activity`), and only then. No new switch value is added.

S2 — Heading roles mirror gentle-shell PR #3061 (`lib/skill-odd-card.ts`, final state f665dec):
- glyph AND label painted with `card.titleRole` — `toolTitle` for a skill, `mdHeading` for an ODD artifact — and the label additionally bold;
- `·` separator in `muted`, path in `accent`, read line range in `warning`, tool name unpainted.

S3 — Document body roles mirror the same PR through Pi's own renderer: `Markdown` from `@earendil-works/pi-tui` with a theme table mapping `heading→mdHeading`, `link→mdLink`, `linkUrl→mdLinkUrl`, `code→mdCode`, `codeBlock→mdCodeBlock`, `codeBlockBorder→mdCodeBlockBorder`, `quote→mdQuote`, `quoteBorder→mdQuoteBorder`, `hr→mdHr`, `listBullet→mdListBullet`, and `bold/italic/underline/strikethrough` from the theme's attributes when present. When the renderer yields no rows or throws, the body falls back to the wrapped plain source, unstyled.

S4 — The collapsed preview of an identity `.md` also wears those roles: the first `PREVIEW_ROWS` drawn rows of the document are rendered as S3 renders them, not as raw result text.

S5 — Invariant 17 stands: nothing painted is measured. The document's own lines carry ANSI once painted by Pi's renderer, so the substrate measures them with an ANSI-aware width and does NOT re-paint them with a body role; the frame, background and padding stay ours.

S6 — No double chrome in either resolver order. The activity design already claims `read` (`lib/bash-design.js:497` `tools: [bash, ...READ_TOOL_GLYPHS.keys()]`) and Pi chains resolvers in load order (`upstream/pi/packages/coding-agent/src/core/extensions/types.ts:699,1773`). A call whose path is a skill or an ODD artifact must show the file card and never an activity status line over or under it, whichever resolver runs first.

S7 — The card asks the bridge which design draws the tool it is painting: `api.resolveToolDesignSelection(tool)` (gentle-shell-bridge@0.7.0, an OPTIONAL member of the published object, also exported from its `src/index.ts`). Painted only when the answer is `{ kind: "design", design }` with `design.id === "odd-worktree.bash-activity"`; `native`, `missing` and `not-covered` all mean the host card. The question is asked per painted tool on every frame and never cached, which is what repaints a card already on screen after a mid-session switch. Gated with `typeof api.resolveToolDesignSelection === "function"`: a bridge older than 0.7.0 degrades to the pre-switch behaviour (the card paints without asking), never to a crash. This feature reads no store file and duplicates no resolution rule.

S8 — Unchanged: any path that is not `SKILL.md` under a `skills` folder or a file below `odd/tasks`; `edit`; failed calls; non-`.md`; `Card tools = default`; the host's own box and hint for every one of them.

S9 — Verification asserts every observable effect it names, through the public surface: the painted roles per element (glyph, label, separator, path, range, heading, bullet, inline code, fence, quote, rule), the switch gate on and off, both resolver orders for S6, the collapsed preview sizes, and that a refused/unavailable bridge leaves the host's card untouched (fail-open).

## Tasks

- T1 — DROPPED (moved out): the bridge's public reader is a separate repo, handed off to the `gentle-shell-bridge` session; this feature does not wait on it (S7).
- T2 — DONE, `52b4fdd`: the two switches and their document are gone; the card rides the bridge's reader, pre-switch behaviour on a bridge without it. Corrected by `5ffe893` (L6.1: the line now declares `write`).
- T3 — DONE, `52b4fdd`: heading roles, document body through Pi's Markdown, placed without re-painting, and the collapsed preview from the same rendered document. Corrected by `5ffe893` (L6.2 heading duplication, L6.3 write fallback source).
- T4 — DONE, `397b096`: the activity design returns identity paths byte for byte, both parts.
- T5 — DONE, `fe18998` and `c1b0bdf`: invariant 23 carries the gate contract (numbering stayed 1-23, no citation churn), the code map gained the card row, and the line's coverage was corrected to include `write`.

## Log

L1 — «https://github.com/Gentleman-Programming/gentle-shell/pull/3061 recuerda la pr de ejemplo /home/jona/dev/projects/gentle-shell-bridge y bridge que tuvo cambios. La idea ese meter el encedido y apagado de estos odd y de skills dentro del switch "card tools" que se actve con activy igual. Otro punto que la update de bridge deberia ayudar a corregir es los colores, actualmente no tiene o no se aplican los colores a los odd y skills, en la pr tenian un color rol de tema asociado, falta eso, su preview de output para .md igual deberia tener/seguir colores tema, ahi nose si .pi tiene algo para ver esto, creo que si, /home/jona/dev/upstream/pi .»

L2 — Decision (user, ask_user_choice): the card joins **inside the `activity` value** of `Card tools`, not as a third switch value: "activity pasa a pintar también read/write de odd y skills como documento: un solo valor, todo junto y siempre sincronizado".

L6 — Independent verification (CANDIDATE 397b096) found three blockers, two of them regressions against the baseline:
  (1) `lib/bash-design.js:507` registers the line over `[bash, grep, find, ls, read]`; `write` is not covered, so `resolveToolDesignSelection("write")` answers native and every write file card disappears with the bridge present. S1 requires read AND write. Fix: the line declares `write` too (the design already answers `undefined` for it, so its rows come back untouched); a write is gated like a read and painted by the file card.
  (2) An expanded long file heading repeats tool and path: `lib/shell-card.js` clears the subtitle for the continued layout but keeps `subtitleSegments`, so the segments paint a partial path above the full one. Fix: the continued layout drops the segments with the subtitle.
  (3) A write whose document cannot be rendered falls back to the result text ("Successfully wrote 17 bytes") instead of the document the call carried, which the baseline rendered. Fix: the fallback source for a write is the call's content, never the result text.

L5 — Bridge peer answer: gentle-shell-bridge 0.7.0 published (commit 1ad1964, tag v0.7.0, release run 43953424864 green) with `resolveToolDesignSelection` on the published object as an optional member plus a `ToolDesignSelection` type, documented in docs/contract.md §14 "Asking which design a tool draws"; suite 733/733 and tsc clean. It deliberately did NOT publish `getToolDesignLineSelection` (a raw stored id would force the caller to re-resolve live/coverage itself), and confirmed the cost is one persisted-selection read per call — already what one render pass pays — with nothing cached. It assessed the theme-role item for designs and declined a paint helper (ctx.theme stays opaque). L5 supersedes the store-reading S7 of L4.

L7 — Verification of the corrected tree, independent of the worker that wrote the fix: a clean clone at `c1b0bdf` (ordinary clone, real node_modules) ran the verifier's OWN three regression tests verbatim — `S3 write fallback uses written source rather than status`, `S2 expanded long heading states tool only once`, `S1/L2 registered activity covers write` — 3/3 green, and the full suite 2145/2145 with zero skips. Before the fix those same three failed at 397b096 and reproduced on the baseline as described in L6. State: feature complete on `feat/file-card-theme`; push and PR are the user's decision.

L4 — Blocker and decision: the session guard refuses `git worktree add` and `git switch -c` in another repository, and `worktree_create` only reaches this clone, so no branch can be cut in gentle-shell-bridge from here. Option C (a public bridge reader) moved out: it was handed to the gentle-shell-bridge session (peer 01a1e617-df1d-70da-b059-c84091bf6987, message 4702a647b45d43bb5206406faae01e48) which reviews whether the gap applies, fixes it if it does, and cuts the release. This feature gates by reading the persisted document instead (S7) and does not wait on that peer.

L3 — Evidence: PR #3061 ships `fileCardMarkdownTheme` + `FileCardMarkdown` on Pi's `Markdown`, and its heading roles are `toolTitle` (skill) / `mdHeading` (odd), `muted` separator, `accent` path, `warning` range. The bridge owns the ONE `pi.registerToolRenderer` and fans out to designs (`gentle-shell-bridge/src/extension.ts:243`); `apply(lines, { width, tool, theme, part, render })` receives no key hint and no invalidate, so the card stays a tool renderer and gates on the line selection instead of becoming a design value.
