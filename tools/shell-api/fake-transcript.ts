/**
 * A fake conversation, and a fake `tui` that reaches it the way Pi does (S8, S4).
 *
 * Two things are modelled here, and nothing else:
 *
 * 1. **The component whose `render(width)` produces the conversation rows.** Its output is real
 *    gentle-shell chrome, not an invention: every line below was produced by running
 *    `gentle-shell/lib/shell-card.ts` (read-only) — `floatRows` / `cardTop` / `cardLine` /
 *    `cardBottom` — with a theme whose `fg` maps the host's roles to SGR codes
 *    (`border`→90, `accent`→95, `dim`→2, `muted`→37, `text`→39) and whose `bg` opens a
 *    256-colour background and closes with `\x1b[49m`, the shape `surfaceOpener` requires
 *    (`shell-card.ts:288-303`). Width 40 throughout. The grammar these lines encode is documented
 *    at the top of `src/card-styles.ts`.
 * 2. **The tree Pi mounts, and the property path from `tui` down to that component.** It is copied
 *    from Pi's own construction, not guessed:
 *    - `interactive-mode.js:403-407` — the document container's children are
 *      `[header, loadedResources, chatContainer]`;
 *    - `chat-viewport.js:4-11,22-25` — the transcript is a `primary` `ScrollView` wrapping that
 *      document, and the layout root is a `VStack` of `[transcript, dock]`;
 *    - `interactive-mode.js:623-629` — mounting adds the seven containers with `addChild` (so
 *      `tui.children[0]` is the document, in both renderer modes) and then calls
 *      `setLayoutRoot(root)` (fullscreen only);
 *    - `pi-tui/dist/layout-node.d.ts:2,36-38` and `components/scroll-view.d.ts:57` — both the
 *      stack and the scroll view expose their parts through `LAYOUT_NODE()`.
 *
 * The fake keeps those shapes faithfully: `layoutRoot` is absent in regular mode and before
 * mounting, `children[0]` is always the document when mounted, and the scroll view's
 * `[LAYOUT_NODE]().component` is its child.
 */

/** The layout protocol symbol, exactly as pi-tui defines it (`pi-tui/dist/layout-node.js:1`). */
export const LAYOUT_NODE: symbol = Symbol.for("@earendil-works/pi-tui/layout-node");

/** Strips SGR sequences, so a test can assert on what the user sees. */
export function stripAnsi(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * One `float` card, width 40: title `read`, hint `ctrl+o`, one body row `config.ts`.
 * Rows: padding, header, padding, body, closing rule.
 */
export const READ_CARD: readonly string[] = [
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m \u001b[39m\u001b[95m✿ read\u001b[39m\u001b[90m                    \u001b[39m \u001b[2mctrl+o\u001b[39m \u001b[90m  \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m \u001b[39mconfig.ts\u001b[39m                          \u001b[90m \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
];

// ---------------------------------------------------------------------------------------------
// The bash card MATRIX (S11/T17): 2 host card styles x 2 card contents, plus the shapes a
// result can take. Every string below was PRODUCED, not written: a scratch script imported the
// INSTALLED host's own `lib/shell-card.ts` (`floatRows` / `cardTopRows` / `cardLine` / `cardBottom`
// / `cardRunningLine`, from
// `~/.pi/agent/git/github.com/Gentleman-Programming/gentle-shell/lib/shell-card.ts`) and pi's own
// `@earendil-works/pi-tui` (`Text`, `Container`, `Spacer`) plus
// `dist/modes/interactive/components/visual-truncate.js` (`VisualLinePreview`), with the arguments
// the host's real call sites pass:
//
//   minimal  `extensions/quiet-tools.ts:910-914` answers bash with `createQuietToolRenderer("bash")`:
//            `ToolCardTop.render` (`:778-785`) draws the call (`floatRows(cardTopRows(...))`, plus
//            `cardRunningLine` + `cardBottom` while the result is missing) and `ToolCardBody.render`
//            (`:670-700`) draws the result (`body`, `bottom`, `afterHeading: true`). The heading is
//            `formatToolCall`'s title (`:519-527`): the bare command, because the card glyph is `$`
//            (`TOOL_GLYPH`, `:44-52`) — `$ npm test` plus the muted ` (timeout 30s)` and the dim
//            `ctrl+o to expand` hint (`:781`). Collapsed minimal bash results are the empty
//            `Text` (`:800`) so the result is only the closing rule.
//   default  the same resolver calls `next()`, so pi's native renderer draws (no gentle-shell card):
//            `core/tools/renderers/bash.js:14-20` is `theme.fg("toolTitle", theme.bold("$ …"))` plus
//            `theme.fg("muted", " (timeout Ns)")` in a `Text("", 0, 0)`; the card is
//            `ToolExecutionComponent`'s `Box(1, 1, bg)` (`modes/interactive/components/
//            tool-execution.js:60`), whose `render` (`pi-tui/components/box.js:96-118`) pads every
//            child row to `width - 2` and adds one blank row above and below. The result is a
//            `Container` of `Spacer(1)` + `VisualLinePreview` (collapsed) or a `Text("\n" + output)`
//            (expanded) — so its FIRST row is blank, and an expanded one starts with a blank row too.
//            `cardStyle()` is irrelevant here: nothing on this path reads it.
//
// The theme is the fixture's own fake, applied through the host's `CardTheme` interface; its role
// map is the one the host's roles get in this file (`border` 90, `success`/`accent`/`toolTitle` 95,
// `dim` 2, `muted` 37, `text`/`toolOutput` 39) and `bg` opens 256-colour 236 and closes with
// `\x1b[49m`, the shape `surfaceOpener` requires (`shell-card.ts:288-303`). Colour codes are not
// what the design reads — the STRUCTURE (chrome, mark, fill, hint, row order) is, and that is what
// the host code above decides. Widths: 60 for a `float`/`neon` card component, 58 for the native
// cell (the `Box` spends one column of padding on each side), so every row below is exactly that
// wide and a design that changes a row without keeping its width is caught by the tests.
//
// Reachability, with evidence (see `test/example-bash-matrix.test.ts`):
// - `minimal` x `float` and `minimal` x `neon` are both reachable: `cardStyle()` picks the chrome
//   inside `floatRows` (`shell-card.ts:314-346`), so the same renderer draws either.
// - `default` x `float` and `default` x `neon` are reachable and draw the SAME rows: with content
//   default the host's resolver calls `next()` and nothing on pi's path reads `cardStyle()`. The two
//   cells therefore share one fixture; that is the finding, not a shortcut.
// - A style ADDED through `registerCardStyle` is reachable only with `minimal`. The bridge repaints
//   float frames only (`src/card-style-transform.ts:189-196` requires a ` ▎ ` row, `:320-352`
//   matches the card), and the native cell has no float grammar at all, so a registered style can
//   repaint the minimal card and can never repaint the default one.

/**
 * `minimal` x `float`, the CALL component of a settled card: `floatRows` -> padding row + heading.
 * `quiet-tools.ts:778-785` produces exactly these two rows once the result marked the shared state
 * (`cardAwaitingResult` false, `shell-card.ts:167-181`), which is the state every later frame draws.
 */
export const BASH_MINIMAL_FLOAT_CALL: readonly string[] = [
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m                                                         \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m \u001b[39m\u001b[95m$ \u001b[95m\u001b[1mnpm test\u001b[22m\u001b[39m\u001b[37m (timeout 30s)\u001b[39m\u001b[39m\u001b[95m            \u001b[39m \u001b[2mctrl+o to expand\u001b[39m \u001b[95m  \u001b[39m\u001b[49m ",
];

/**
 * `minimal` x `float`, the CALL component while the command still runs: the same heading, then a
 * padding row, the muted `running…` row and the closing rule (`ToolCardTop.render`, `:782-785`).
 */
export const BASH_MINIMAL_FLOAT_CALL_RUNNING: readonly string[] = [
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m                                                         \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m \u001b[39m\u001b[95m$ \u001b[95m\u001b[1mnpm test\u001b[22m\u001b[39m\u001b[37m (timeout 30s)\u001b[39m\u001b[39m\u001b[95m            \u001b[39m \u001b[2mctrl+o to expand\u001b[39m \u001b[95m  \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m                                                         \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m \u001b[37mrunning…\u001b[39m                                               \u001b[95m \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m                                                         \u001b[39m\u001b[49m ",
];

/**
 * `minimal` x `float`, the RESULT component of a collapsed card with no output: the empty `Text`
 * (`quiet-tools.ts:800`) leaves `ToolCardBody` nothing to draw but the closing rule.
 */
export const BASH_MINIMAL_FLOAT_RESULT_EMPTY: readonly string[] = [
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m                                                         \u001b[39m\u001b[49m ",
];

/**
 * `minimal` x `float`, the RESULT component with two output rows: a separator padding row, the body
 * rows in the muted role, then the closing rule (`ToolCardBody.render` + `floatRows`).
 */
export const BASH_MINIMAL_FLOAT_RESULT: readonly string[] = [
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m                                                         \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m \u001b[37mPASS 42 tests\u001b[39m                                          \u001b[95m \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m \u001b[37mduration 1.2s\u001b[39m                                          \u001b[95m \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m                                                         \u001b[39m\u001b[49m ",
];

/**
 * `minimal` x `float`, the RESULT component of a command that echoed a prompt: its first body row
 * begins with `$ `. From rows alone this row sits exactly where a heading sits, because the call and
 * the result share the float chrome. The design tells them apart by `ctx.part` (S12), so this result
 * passes through byte for byte (`test/example-bash-matrix.test.ts` pins it).
 */
export const BASH_MINIMAL_FLOAT_RESULT_PROMPT: readonly string[] = [
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m                                                         \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m \u001b[37m$ echo hi\u001b[39m                                              \u001b[95m \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m \u001b[37mhi\u001b[39m                                                     \u001b[95m \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m                                                         \u001b[39m\u001b[49m ",
];

/**
 * `minimal` x `float`, the CALL component of a settled card whose command is too long for the
 * heading row. Derived from the INSTALLED host, not written by hand: `bashSummary(command, width)`
 * (`quiet-tools.ts:492-501`) clips the command and appends the host's ellipsis, `clipPlain`
 * (`:505-510`) does the cut, and `formatToolCall` (`:519-527`) puts the muted ` (timeout 30s)` after
 * it. The width it is handed is the one `renderCall` computes (`:781`): the card's inner width minus
 * `CARD_TOP_CHROME` (8, `:489`) and the 18 columns of the `ctrl+o to expand` hint — 32 at width 60 —
 * less the timeout's own 14 columns, so the command is clipped to 18 columns. `cardTopRows`
 * (`shell-card.ts:246-271`) then wraps that title and `cardTop` (`:141-164`) leaves only its minimum
 * fill before the hint. That minimum is why the design's fill rule refuses this row.
 */
export const BASH_MINIMAL_FLOAT_CALL_LONG: readonly string[] = [
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m                                                         \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m \u001b[39m\u001b[95m$ \u001b[95m\u001b[1mnpm run typecheck…\u001b[22m\u001b[39m\u001b[37m (timeout 30s)\u001b[39m\u001b[39m\u001b[95m  \u001b[39m \u001b[2mctrl+o to expand\u001b[39m \u001b[95m  \u001b[39m\u001b[49m ",
];

/**
 * `minimal` x `neon`, the same collapsed long command: the outline spends one column fewer on its
 * leading chrome, so `bashSummary` clips two more columns of the command before the ellipsis. Produced
 * by the same host path (the only difference is `floatRows`' chrome, `shell-card.ts:105-108`).
 */
export const BASH_MINIMAL_NEON_CALL_LONG: readonly string[] = [
  "\u001b[95m╭\u001b[39m\u001b[95m─ \u001b[39m\u001b[95m$ \u001b[95m\u001b[1mnpm run typecheck -…\u001b[22m\u001b[39m\u001b[37m (timeout 30s)\u001b[39m\u001b[39m\u001b[95m ─\u001b[39m \u001b[2mctrl+o to expand\u001b[39m \u001b[95m╮\u001b[39m",
];

/**
 * `minimal` x `neon`, the CALL component of a settled card: one row, the outlined top rule
 * (`floatRows` falls back to `OUTLINE_CHROME` when the style is not float, `shell-card.ts:105-108`).
 */
export const BASH_MINIMAL_NEON_CALL: readonly string[] = [
  "\u001b[95m╭\u001b[39m\u001b[95m─ \u001b[39m\u001b[95m$ \u001b[95m\u001b[1mnpm test\u001b[22m\u001b[39m\u001b[37m (timeout 30s)\u001b[39m\u001b[39m\u001b[95m ─────────────\u001b[39m \u001b[2mctrl+o to expand\u001b[39m \u001b[95m╮\u001b[39m",
];

/** `minimal` x `neon`, the CALL component while running: top rule, `running…` row, closing rule. */
export const BASH_MINIMAL_NEON_CALL_RUNNING: readonly string[] = [
  "\u001b[95m╭\u001b[39m\u001b[95m─ \u001b[39m\u001b[95m$ \u001b[95m\u001b[1mnpm test\u001b[22m\u001b[39m\u001b[37m (timeout 30s)\u001b[39m\u001b[39m\u001b[95m ─────────────\u001b[39m \u001b[2mctrl+o to expand\u001b[39m \u001b[95m╮\u001b[39m",
  "\u001b[95m│\u001b[39m \u001b[37mrunning…\u001b[39m                                                 \u001b[95m│\u001b[39m",
  "\u001b[95m╰\u001b[39m\u001b[95m──────────────────────────────────────────────────────────╯\u001b[39m",
];

/** `minimal` x `neon`, the RESULT component with no output: only the closing rule. */
export const BASH_MINIMAL_NEON_RESULT_EMPTY: readonly string[] = [
  "\u001b[95m╰\u001b[39m\u001b[95m──────────────────────────────────────────────────────────╯\u001b[39m",
];

/** `minimal` x `neon`, the RESULT component with two output rows and the closing rule. */
export const BASH_MINIMAL_NEON_RESULT: readonly string[] = [
  "\u001b[95m│\u001b[39m \u001b[37mPASS 42 tests\u001b[39m                                            \u001b[95m│\u001b[39m",
  "\u001b[95m│\u001b[39m \u001b[37mduration 1.2s\u001b[39m                                            \u001b[95m│\u001b[39m",
  "\u001b[95m╰\u001b[39m\u001b[95m──────────────────────────────────────────────────────────╯\u001b[39m",
];

/** `minimal` x `neon`, the RESULT component of a command that echoed a prompt (`$ echo hi`). */
export const BASH_MINIMAL_NEON_RESULT_PROMPT: readonly string[] = [
  "\u001b[95m│\u001b[39m \u001b[37m$ echo hi\u001b[39m                                                \u001b[95m│\u001b[39m",
  "\u001b[95m│\u001b[39m \u001b[37mhi\u001b[39m                                                       \u001b[95m│\u001b[39m",
  "\u001b[95m╰\u001b[39m\u001b[95m──────────────────────────────────────────────────────────╯\u001b[39m",
];

/**
 * `default` x `float` AND `default` x `neon` (one fixture: see the reachability note above), the
 * CALL component: pi's native `Text` row, padded to the `Box`'s 58 content columns.
 */
export const BASH_DEFAULT_CALL: readonly string[] = [
  "\u001b[95m\u001b[1m$ npm test\u001b[22m\u001b[39m\u001b[37m (timeout 30s)\u001b[39m                                  ",
];

/** The same call with no `timeout` argument, so no muted suffix follows the command. */
export const BASH_DEFAULT_CALL_NO_TIMEOUT: readonly string[] = [
  "\u001b[95m\u001b[1m$ npm test\u001b[22m\u001b[39m                                                ",
];

/**
 * The same call with a command long enough to leave no padding after the mark: pi's `Text` wraps it,
 * and the first row is exactly 58 columns wide. A design cannot grow this row without breaking the
 * frame, so it must leave it alone and say so (`test/example-bash-matrix.test.ts`).
 */
export const BASH_DEFAULT_CALL_TIGHT: readonly string[] = [
  "\u001b[95m\u001b[1m$ yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\u001b[22m\u001b[39m\u001b[37m (timeout   ",
  "\u001b[37m30s)\u001b[39m                                                      ",
];

/** `default`, the RESULT component collapsed: a blank `Spacer` row, then the preview rows. */
export const BASH_DEFAULT_RESULT: readonly string[] = [
  "",
  "\u001b[39mPASS 42 tests\u001b[39m                                             ",
  "\u001b[39mduration 1.2s\u001b[39m                                             ",
];

/** `default`, the RESULT component expanded: `Text("\n" + output)` — its first row is blank too. */
export const BASH_DEFAULT_RESULT_EXPANDED: readonly string[] = [
  "                                                          ",
  "\u001b[39mPASS 42 tests\u001b[39m                                             ",
  "\u001b[39mduration 1.2s\u001b[39m                                             ",
];

/** `default`, the RESULT component of a command whose first output row is `$ echo hi`. */
export const BASH_DEFAULT_RESULT_PROMPT: readonly string[] = [
  "",
  "\u001b[39m$ echo hi\u001b[39m                                                 ",
  "\u001b[39mhi\u001b[39m                                                        ",
];

/**
 * A `read` tool call beside it, drawn by the same host code (glyph `≡`, `TOOL_GLYPH.read`). The
 * heading is `≡ read src/api.ts`; nothing about it is bash, so a bash design must leave it alone.
 */
export const HOST_READ_CARD: readonly string[] = [
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                                         \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m \u001b[39m\u001b[95m≡ read src/api.ts\u001b[39m\u001b[90m                   \u001b[39m \u001b[2mctrl+o to expand\u001b[39m \u001b[90m  \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                                         \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m \u001b[39mexport function bridgeApi() {\u001b[39m                          \u001b[90m \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                                         \u001b[39m\u001b[49m ",
];

/**
 * One `float` card, width 40, with NO hint and NO body: padding, header, padding. Its opener and
 * closer rows are byte-identical to the padded card's, which is why detection must key on
 * position rather than on a row's shape alone.
 */
export const BASH_CARD: readonly string[] = [
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m \u001b[39m\u001b[95m✿ bash\u001b[39m\u001b[90m                            \u001b[39m\u001b[90m  \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
];

/**
 * One `float` card whose body row was truncated by `cardLine` (`shell-card.ts:172-184`): the
 * `…` arrives with a full reset, and the background is re-armed after it
 * (`paintSurfaceRow`, `:300-303`) — the escape sequence real output carries.
 */
export const TRUNCATED_CARD: readonly string[] = [
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m \u001b[39m\u001b[95m✿ bash\u001b[39m\u001b[90m                            \u001b[39m\u001b[90m  \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m \u001b[39mnpm run typecheck exits zero and \u001b[0m\u001b[48;5;236m…\u001b[0m\u001b[48;5;236m \u001b[90m \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
];

/**
 * The same card in `neon`: no margin, no background, `╭─ … ╮` / `│ … │` / `╰ … ╯`. Detection must
 * never mistake one style for the other, so both are fixtures.
 */
export const NEON_CARD: readonly string[] = [
  "\u001b[90m╭\u001b[39m\u001b[90m─ \u001b[39m\u001b[95m✿ read\u001b[39m\u001b[90m ─────────────────────\u001b[39m \u001b[2mctrl+o\u001b[39m \u001b[90m╮\u001b[39m",
  "\u001b[90m│\u001b[39m \u001b[39mconfig.ts\u001b[39m                            \u001b[90m│\u001b[39m",
  "\u001b[90m╰\u001b[39m\u001b[90m──────────────────────────────────────╯\u001b[39m",
];

/**
 * A `float` card with a SUBTITLE and no hint, width 40: the header carries two text runs (title in
 * the title role, `· config.ts` in the muted role) and no dim hint. It pins the honest limit of
 * extraction: a heading whose last run is a subtitle must not be read as a hint.
 */
export const SUBTITLE_CARD: readonly string[] = [
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m \u001b[39m\u001b[95m✿ read\u001b[39m \u001b[37m·\u001b[39m \u001b[37mconfig.ts\u001b[39m\u001b[90m                \u001b[39m\u001b[90m  \u001b[39m\u001b[49m ",
  " \u001b[48;5;236m\u001b[90m▎\u001b[39m\u001b[90m                                     \u001b[39m\u001b[49m ",
];

/** A line the host did not draw as a card, plus a blank one: a repaint must leave both alone. */
export const PROSE_LINE = "I will read the config first.";
export const BLANK_LINE = "";

/** What the conversation component renders: prose, a card, more prose, a second card. */
export const CONVERSATION: readonly string[] = [
  PROSE_LINE,
  BLANK_LINE,
  ...READ_CARD,
  BLANK_LINE,
  ...TRUNCATED_CARD,
  BLANK_LINE,
  ...BASH_CARD,
];

/** A component, in Pi's sense: `render(width)` returns one string per row. */
export interface FakeComponent {
  render(width: number): string[];
}

/** The card component: records every width it was asked to render at. */
export interface FakeConversation extends FakeComponent {
  readonly widths: number[];
}

export function createFakeConversation(lines: readonly string[] = CONVERSATION): FakeConversation {
  const widths: number[] = [];
  return {
    widths,
    render(width: number): string[] {
      widths.push(width);
      return [...lines];
    },
  };
}

/** A component that paints one fixed row, for the header and the loaded-resources slots. */
function fixedRow(text: string): FakeComponent {
  return { render: () => [text] };
}

/** What `LAYOUT_NODE()` returns for a stack / scroll view, narrowed to what a walk reads. */
export interface FakeLayoutNode {
  type: string;
  entries?: ReadonlyArray<{ component?: unknown }>;
  component?: unknown;
}

/** Anything exposing the layout protocol, as `ScrollView` and `VStack` both do. */
export function layoutNodeOf(value: unknown): FakeLayoutNode | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const read = (value as Record<symbol, unknown>)[LAYOUT_NODE];
  if (typeof read !== "function") return undefined;
  const node: unknown = read.call(value);
  if (node === null || typeof node !== "object") return undefined;
  return node as FakeLayoutNode;
}

/** The transcript `ScrollView`, shaped like `pi-tui`'s: a scrollbar, a child, the layout protocol. */
export interface FakeScrollView {
  readonly child: unknown;
  scrollbar: "auto" | "hidden" | "always";
  setScrollbar(value: "auto" | "hidden" | "always"): void;
  getContentWidth(width: number): number;
  render(width: number): string[];
  [LAYOUT_NODE](): FakeLayoutNode;
}

export interface FakeDocument extends FakeComponent {
  children: FakeComponent[];
}

export interface FakeTui {
  mode: "fullscreen" | "regular";
  terminal: Record<string, unknown>;
  children: FakeComponent[];
  /** Absent in regular mode and before mounting, exactly as on Pi's own renderer. */
  layoutRoot?: { [LAYOUT_NODE](): FakeLayoutNode };
  render(width: number): string[];
  document: FakeDocument;
  transcript?: FakeScrollView;
  chat: FakeConversation;
}

export interface FakeTranscriptTuiOptions {
  /** `regular` models `TuiMainScreen`: children only, no layout root. */
  mode?: "fullscreen" | "regular";
  /** `false` models the window before `mountInteractiveTui` runs: nothing mounted at all. */
  mounted?: boolean;
  lines?: readonly string[];
}

/**
 * The fake `tui`. `layoutRoot` (fullscreen, mounted) and `children[0]` (mounted, either mode) both
 * lead to `chat`, so a walk can be written against the documented path and proven here — and the
 * absent shapes are just as reachable.
 */
export function createFakeTranscriptTui(options: FakeTranscriptTuiOptions = {}): FakeTui {
  const mode = options.mode ?? "fullscreen";
  const mounted = options.mounted ?? true;
  const chat = createFakeConversation(options.lines ?? CONVERSATION);
  const header = fixedRow("header");
  const loadedResources = fixedRow("resources");

  // interactive-mode.js:403-407 — the document container's children, in that order.
  const document: FakeDocument = {
    children: [header, loadedResources, chat],
    render(width: number): string[] {
      return this.children.flatMap((child) => child.render(width));
    },
  };

  // chat-viewport.js:4-11 — a primary ScrollView over the document; its render adds the scrollbar
  // column when `getContentWidth` steals one (pi-tui/components/scroll-view.js:186-190).
  const transcript: FakeScrollView = {
    child: document,
    scrollbar: "auto",
    setScrollbar(value) {
      this.scrollbar = value;
    },
    getContentWidth(width: number): number {
      return this.scrollbar === "hidden" ? width : Math.max(1, width - 1);
    },
    render(width: number): string[] {
      const contentWidth = this.getContentWidth(width);
      const lines = (this.child as FakeComponent).render(contentWidth);
      return contentWidth === width ? lines : lines.map((line) => `${line} `);
    },
    [LAYOUT_NODE](): FakeLayoutNode {
      return { type: "scroll", component: this.child };
    },
  };

  const dock = {
    [LAYOUT_NODE](): FakeLayoutNode {
      return { type: "vstack", entries: [{ component: fixedRow("editor") }] };
    },
  };

  const layoutRoot = {
    [LAYOUT_NODE](): FakeLayoutNode {
      return {
        type: "vstack",
        entries: [{ component: transcript }, { component: dock }],
      };
    },
  };

  const tui: FakeTui = {
    mode,
    terminal: {},
    // interactive-mode.js:622-625 — the seven containers, document first, in both modes.
    children: mounted
      ? [document, fixedRow("pending"), fixedRow("status"), fixedRow("above"), fixedRow("editor"), fixedRow("below"), fixedRow("footer")]
      : [],
    render(width: number): string[] {
      // TuiAltScreen renders the layout root and ignores `children` (tui-alt-screen.js:145-151).
      if (this.layoutRoot !== undefined) {
        return (this.layoutRoot[LAYOUT_NODE]().entries ?? []).flatMap((entry) =>
          (entry.component as FakeComponent | undefined)?.render(width) ?? [],
        );
      }
      return this.children.flatMap((child) => child.render(width));
    },
    document,
    chat,
  };
  // Only the fullscreen renderer has a layout root, and only once mounted (interactive-mode.js:626).
  if (mounted && mode === "fullscreen") {
    tui.layoutRoot = layoutRoot;
    tui.transcript = transcript;
  }
  return tui;
}
