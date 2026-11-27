/**
 * Worked consumer of `gentle-shell-bridge`: ONE Pi extension that contributes a tool DESIGN, a card
 * STYLE, a sidebar section, and a demo row provider, and nothing else.
 *
 * A. The bash design — through the bridge, as a `registerToolDesign` registration. The host draws a
 *    minimal bash card with just the `$` prompt as its glyph (`quiet-tools.ts:521-525`: *"Minimal
 *    cards title bash with the bare command; the card glyph supplies the `$` prompt"*), so the card
 *    heads with a mark the user cannot change from `/gentle:customize`. This file registers the
 *    design the user asked for: the SAME card, headed with the word `bash` instead of that mark.
 *
 *    A design is not a card renderer and not a second grammar. The bridge registers Pi's ONE
 *    `registerToolRenderer` resolver, builds the HOST's own component, and hands `apply` the rows
 *    that card produced:
 *
 *    ```text
 *    apply(lines, { width, tool, theme, part }) → lines
 *    ```
 *
 *    So the frame is the host's, by construction: with `Card style = neon` the card stays neon, with
 *    `float` it stays float, and every byte this file does not deliberately change — ANSI, padding,
 *    hint, rail — comes back exactly as drawn. Pi resolves renderers when it builds a card, and the
 *    bridge reads the live selection on every render pass, so choosing the design repaints the cards
 *    already on screen, not only the next one.
 *
 *    The design changes exactly two things, both on the heading row: the `$` mark becomes `bash`, and
 *    the frame's fill loses the three columns the longer mark added, so the row keeps the width the
 *    host made it. When the fill cannot pay — the command the host already collapsed fills the row —
 *    the command's OWN abbreviation loses the three columns instead, at a grapheme boundary; a
 *    command the host shows in full is never shortened. Every other row is the byte-for-byte host
 *    row. `test/example-bash-matrix.test.ts`
 *    drives that claim over the whole matrix the user named (S11): `float`, `neon` and a style ADDED
 *    through `registerCardStyle`, crossed with card content `minimal` and `default` — where the host's
 *    resolver calls `next()` and pi's native renderer draws rows that look nothing like a gentle-shell
 *    card. The table of what the host draws in each cell, and the source lines each fixture came from,
 *    is the comment block above the fixtures in `test/fake-transcript.ts`.
 *
 *    Finding the heading never parses the frame's chrome: the design takes the component's first row
 *    that carries content and the host's `$` mark as its first non-decoration character, and refuses
 *    two shapes that cannot be a heading — a mark after a blank row (pi's native result component
 *    opens with a `Spacer` row) and a mark on the outline frame's side or closing rule. The limits
 *    that rule leaves are stated in the section header below and in README.md; the one shape it cannot
 *    prove is drawn exactly as the host drew it and reported, instead of being guessed at.
 *
 *    `default` is not a design: the customize line of every tool starts with the reserved value
 *    `native`, the host's own card, so installing this file changes no rendering until the user picks
 *    the `bash heading` value.
 *
 * B. The card style — through the bridge. `registerCardStyle` adds one value, `plain`, to the
 *    `Card style` line `/gentle:customize` already draws: `○ neon ○ float ○ plain`. Choosing it
 *    makes the bridge repaint every tool card the host drew with this file's frame — a single
 *    gutter character per row, the heading as plain text, no box — and choosing `neon` or `float`
 *    puts the host's own rendering back. It is a style for TOOL cards in general: a `read` card is
 *    repainted exactly like a `bash` one. Nothing here parses a card: the bridge measures, extracts
 *    the heading and the hint, and hands them over. Because the design runs FIRST and this style
 *    repaints AFTER, the word `bash` the design put on a bash heading is what `plain` draws — and a
 *    card content the host draws outside the float grammar (`default`) is passed through exactly,
 *    because a style can only repaint what the host framed.
 *
 * C. The sidebar section — through the bridge. `registerSection` adds a `CARD BASH` card to
 *    gentle-shell's fullscreen sidebar, drawn by the host's own frame, and the same registration
 *    gives it a `Sections` toggle in `/gentle:customize` with no row, setting or store written by
 *    this file. It reports the LIVE design state: which value is selected for `bash` (the header's
 *    right-aligned meta, which is also the one surface that survives a collapse), whether this
 *    load's design reached the bus (`resolver  registered` / `resolver  absent`), and whether the
 *    design could recognise the frames it was handed (`unrecognised  none`, or the reason — also
 *    delivered once through `ctx.ui.notify`).
 *
 *    The card behaves like a host card (N10–N14): clicking the HEADER folds the section (the bridge
 *    owns that, and persists it) and the header's right-aligned meta is the live selection — printed
 *    once, so the value never appears twice. The design is chosen on the `Cards` line, so the report
 *    rows carry no `onClick`; the section's ONE action row is the demo below.
 *
 *    The section also shows the DEMO below: the toggle's stored value as a plain
 *    `demo toggle  on|off` row, and a CLICKABLE `demo presses` action row whose right-aligned meta
 *    is the button's press count. Clicking it increments the count once and repaints the section
 *    (and hover paints it with the host's own role), so both the plugin's state and the pointer
 *    handling are visible without a debug build.
 *
 * D. The demo category — through the bridge, as a `registerRows` registration. ONE provider (stable
 *    id, replaced in place on `/reload`) adds a category no host code had to know about — `Card
 *    bash` — with exactly two rows as the user reads them: a `Demo toggle` (two consecutive rows
 *    sharing one `choice.setting`, values `on`/`off`, persisted default `off`) and a plain `Demo
 *    button` row with an `action` and no `choice`. Neither does anything real; they exist only to
 *    prove the surface works, and their effect is visible in the section above. Their state lives in
 *    the example's OWN store (`bash-card`), never in the bridge's selection file.
 *
 *    The selection lives in the BRIDGE's own store (`bridge-tool-designs`), which is what makes it
 *    survive a reload and belong to the user rather than to this example. The example only READS it,
 *    through the published `createStore`, to describe the state; it never writes another owner's file.
 *
 * E. The handshake — a runtime meeting, not a dependency. The file and the bridge agree on one stable
 *    `globalThis` symbol, so there is no path, no environment variable and no import (this repository
 *    depends on neither Pi nor the bridge). Two load orders really happen, so both work: the example
 *    reads the symbol in its own `session_start` handler, AND listens on Pi's cross-extension bus for
 *    `"gentle-shell-bridge:ready"` when the symbol is not there yet. Whichever happens first registers
 *    the surfaces; a guard makes the second a no-op, and the returned disposer removes every one.
 *
 * A bridge that publishes an incompatible API is treated as absent, and the example registers nothing.
 * It says so once through `ctx.ui.notify` — the only channel Pi renders inside its TUI; nothing here
 * writes to stdout/stderr. A bridge object older than `registerToolDesign` keeps the section and
 * says `resolver  absent`; one older than `registerCardStyle` says `card style  absent`; the members
 * are optional, so a surface the bridge never promised is never warned about.
 *
 * Loading: copy this file into `~/.pi/agent/extensions/` (or point Pi's `packages` entry at this
 * repository) and `/reload`. The `bash` line defaults to the host's own card.
 *
 * Nothing here imports `@earendil-works/pi-coding-agent` or `@earendil-works/pi-tui`: every host
 * shape this file touches is declared structurally below, the way `src/extension.ts` declares the
 * extension API it uses.
 */

// ---------------------------------------------------------------------------------------------
// What this file contributes
// ---------------------------------------------------------------------------------------------

/** The tool name the design is declared for (S7: a name, never a bash-specific branch). */
const TOOL_NAME = "bash";
/** Stable across loads and unique per tool: `/reload` replaces this design, never stacks one. */
const DESIGN_ID = "bash-card.bash-heading";
/**
 * The value the user reads on the `Cards` line. The line's NAME is derived from `bash`, so the menu
 * reads `bash  ○ default  ○ bash heading` — a short value, in the host's own vocabulary.
 */
const DESIGN_LABEL = "bash heading";
/**
 * This plugin's INTEGRATIONS row. Required for a file with no owning `package.json` above it: the
 * bridge refuses to invent a name, so a copied single-file extension names itself here. The first
 * registration fixes the name for the identity; the section below inherits it.
 */
const PLUGIN_NAME = "Card bash";

/**
 * The bridge's own selection file, mirrored the way the API symbol is (this file cannot import the
 * bridge, not even for a constant). The example READS it to describe the live state; the value is
 * written by the bridge's own `Cards` row, so the user's choice has one owner.
 */
const DESIGNS_STORE_ID = "bridge-tool-designs";
const DESIGNS_STORE_KEY = "selections";
/** The reserved value meaning "the host's own card" (`TOOL_DESIGN_NATIVE` in the bridge). */
const NATIVE_VALUE = "native";

/** Stable across loads, so `/reload` replaces this section instead of stacking it. */
const SECTION_ID = "bash-card.status";
/** The card heading, drawn by the host's own frame like `AGENTS` / `STATS`. */
const SECTION_TITLE = "CARD BASH";
/**
 * What the `Sections` toggle reads. Passed explicitly: the bridge derives `card bash` from the title
 * anyway, but a reader should copy a label, never the dotted id above.
 */
const SECTION_ROW_LABEL = "card bash";
/** The section's one action row; the button's count rides it as the right-aligned meta. */
const SECTION_PRESSES_LABEL = "demo presses";

/**
 * The DEMO category: one provider, one new `Card bash` category, exactly two rows as the user reads
 * them — a toggle (two consecutive rows sharing one `choice.setting`, as the host draws toggles) and
 * a plain action row. They exist only to prove a plugin can put its own toggle and button in a
 * category of its own, so the effect is kept trivial and made VISIBLE in the section below.
 */
const DEMO_PROVIDER_ID = "bash-card.demo";
const DEMO_CATEGORY = "Card bash";
/** The example's OWN store, not the bridge's design-selection file. */
const EXAMPLE_STORE_ID = "bash-card";
const DEMO_TOGGLE_SETTING = "Demo toggle";
const DEMO_BUTTON_LABEL = "Demo button";
const DEMO_TOGGLE_KEY = "demoToggle";
const DEMO_PRESSES_KEY = "demoPresses";

// ---------------------------------------------------------------------------------------------
// Host shapes, declared structurally
// ---------------------------------------------------------------------------------------------

interface BridgeStoreLike {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

/** One row a provider contributes, structurally (`CustomizeRow` in `src/types.ts`). */
interface CustomizeRowLike {
  category?: string;
  label?: string;
  choice?: { setting: string; value: string; current(): boolean };
  preview?(): { title: string; sample: string };
  action?(): void | Promise<void>;
}

/**
 * A provider of customize rows (`RowProvider` in `src/types.ts`). Its `category` is the default for
 * rows that omit one, and a category the host does not already have simply becomes a new one: the
 * host derives its category list from the rows it is handed.
 */
interface RowProviderLike {
  id: string;
  category: string;
  name?: string;
  rows(): CustomizeRowLike[];
  /**
   * Optional finite number read inside one placement slot: finite `order` first, ascending, then the
   * rest; every tie by `id`, never by load order. Registration data, like a section's `order`.
   */
  order?: number;
  /**
   * Where this provider's block sits: `"start"`, `"end"` (the default, after the host's own rows of
   * that category), or `{ after: "<id>" }` — another ROW PROVIDER's id, never a host row's label.
   * An `after` anchor that opted in is followed in its category; an anchor that did not opt in is a
   * tail block, so the follower lands after it in the tail. Opted-in blocks follow each row's ACTUAL
   * category (`row.category ?? provider.category`), one block per category, while an unopted provider
   * keeps one tail block; so a rendered `choice.setting` pair cannot split. Naming neither `placement`
   * nor `order` keeps the pre-feature tail append exactly. An anchor that cannot be honoured falls back to the end, and
   * `/bridge-status` reports the landing that really happened (including a refused write left in the
   * tail) and why. Registration data: never persisted.
   */
  placement?: "start" | "end" | { after: string };
}

/**
 * What a card style's `top` receives (`src/types.ts`, `CardFrameTopContext`): the width the bridge
 * measured and the heading it extracted. A style never parses a card; it only draws.
 */
interface CardFrameTopLike {
  width: number;
  title?: string;
  hint?: string;
}

/** What a style's `line` receives: one body row's text, already stripped of the host's frame. */
interface CardFrameLineLike {
  text: string;
  width: number;
  first: boolean;
}

/** What a style's `bottom` receives. */
interface CardFrameBottomLike {
  width: number;
}

/** The three functions a style draws with (`src/types.ts`, `CardFrame`). */
interface CardFrameLike {
  top(ctx: CardFrameTopLike): string;
  line(ctx: CardFrameLineLike): string;
  bottom(ctx: CardFrameBottomLike): string;
}

/**
 * One card style as the bridge accepts it (`src/types.ts`, `CardStyleRegistration`). The id is the
 * stored selection key and stays internal; `label` is the short value the user reads on the line.
 */
interface CardStyleLike {
  id: string;
  name?: string;
  label: string;
  rowLabel?: string;
  frame: CardFrameLike;
  preview?(): { title: string; sample: string };
  order?: number;
}

/**
 * One tool design as the bridge accepts it (`src/types.ts`, `ToolDesignRegistration`). The host's
 * rows go in, the rows to draw come out; `apply` never sees Pi and never owns the frame.
 *
 * Exactly one of `tool` / (`line` + `tools`) is required. This example uses the UNGROUPED shape, so
 * it keeps its own `Card bash` line. A design that paints several tools at once names a line and the
 * tools it covers (`{ line: "tools", tools: ["bash", "grep"], … }`), and the customize menu then
 * shows ONE `Card tools` line for all of them.
 */
interface ToolDesignLike {
  /** Ungrouped: the tool this design draws, and the name of its own `Card <tool>` line. */
  tool?: string;
  /** Grouped: the line this design joins; several designs naming it share one `Card <line>`. */
  line?: string;
  /** Grouped: the tools this design paints. Required with `line`, refused with `tool`. */
  tools?: readonly string[];
  id: string;
  /** The plugin's INTEGRATIONS row, honoured on the first registration only. */
  name?: string;
  label: string;
  description?: string;
  preview?(): { title: string; sample: string };
  apply(lines: readonly string[], ctx: ToolDesignContextLike): string[];
}

/** What a design is handed on every render pass (`src/types.ts`, `ToolDesignContext`). */
interface ToolDesignContextLike {
  /** The width the host asked its own component to render at; the row it returned is that wide. */
  width: number;
  /** The tool name this design was declared for, never anything the card draws. */
  tool: string;
  /** The host's opaque theme object. This file never reads a colour from it. */
  theme?: unknown;
  /**
   * Which half of the card this pass is drawing (S12): `renderCall` or `renderResult`. OPTIONAL here
   * because a bridge published before the field existed hands a context without it; this file then
   * treats the part as UNKNOWN and keeps its previous behaviour (the row grammar decides), so an
   * older bridge decorates exactly what it decorated before.
   */
  part?: "call" | "result";
  /**
   * What the host's render context says about THIS call (`src/types.ts`, `ToolDesignRender`): its
   * `args` (read-only, the host's own object), `isPartial` (still running), `isError`, `durationMs`,
   * `toolCallId`, `expanded`. OPTIONAL: an older bridge, or a host with no render context, leaves it out,
   * and this file does not read it today. A design that needs it must draw its previous output without.
   */
  render?: {
    toolCallId?: string;
    args?: unknown;
    isPartial?: boolean;
    isError?: boolean;
    durationMs?: number;
    expanded?: boolean;
  };
}

/**
 * One structured section row (`SectionRow` in `src/types.ts`): an icon, a semantic tone, a
 * right-aligned live `meta` and an optional `onClick`. `tone` names one of the host's own roles
 * (`text`, `muted`, `dim`, `accent`, `success`, `error`, `warning`), never a colour.
 */
interface SectionRowLike {
  label: string;
  meta?: string;
  glyph?: string;
  tone?: "text" | "muted" | "dim" | "accent" | "success" | "error" | "warning";
  onClick?: () => void;
}

/**
 * The section contract (`docs/contract.md` §11), structural like every host shape here. A section
 * writes content only: no `choice`, no `action`, no `preview` — the bridge contributes the toggle,
 * the header, the collapse control and the pointer handling.
 */
interface SidebarSectionLike {
  id: string;
  title: string;
  rowLabel?: string;
  meta?(ctx: { theme: unknown; configHome: string }): string | undefined;
  /** A plain string is drawn byte for byte; a structured row is drawn like a native one. */
  lines(ctx: { theme: unknown; configHome: string }): Array<string | SectionRowLike>;
  defaultVisible?: boolean;
  order?: number;
  /**
   * Where the card sits in the rail: `"start"` (top), `"end"` (the default, after every native
   * card), or `{ after: "<id>" }` — another section's id, or one of the host's own parts `todo`,
   * `jobs`, `agents`, `footer`. Registration data like `order`: the bridge resolves it every frame,
   * never stores it, and reports where the card really landed (with the reason) in
   * `/bridge-status`. Absent or unrecognisable means `"end"`, so an older bridge draws this card
   * exactly where it drew it before the field existed.
   */
  placement?: "start" | "end" | { after: string };
}

/**
 * The API object `gentle-shell-bridge` publishes (`src/api.ts`, `BridgeApi`): the members this
 * example calls, structurally. Nothing here imports the package, so the shape has to be declared.
 *
 * `registerToolDesign` is OPTIONAL by contract: the published object is first-wins, so a process
 * running an older copy can hand back an object without it. A consumer gates with `typeof
 * api.registerToolDesign === "function"` and keeps the section working. The same applies to
 * `registerRows`, `registerCardStyle` and `requestRepaint`: an older bridge keeps the design, the
 * plain style and the section, and the example degrades to no demo category rather than throwing.
 */
interface BridgeApiLike {
  readonly schema: string;
  readonly version: number;
  registerSection(section: SidebarSectionLike): () => void;
  registerToolDesign?(design: ToolDesignLike): () => void;
  registerCardStyle?(style: CardStyleLike): () => void;
  registerRows?(provider: RowProviderLike): () => void;
  requestRepaint?(): void;
  createStore(pluginId: string): BridgeStoreLike;
}

/** The part of Pi's `session_start` context this file reads. */
interface SessionContextLike {
  hasUI?: boolean;
  ui?: unknown;
}

/** The one channel Pi gives an extension for text that is not a row: the in-TUI notification. */
interface NoticeUiLike {
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
}

/** The part of `ExtensionAPI` this extension uses. */
interface ExtensionApiLike {
  /** `session_start` carries the UI context, so this is where a buffered notice is delivered. */
  on?(event: "session_start", handler: (event: unknown, ctx: SessionContextLike) => void): void;
  /** Pi's cross-extension bus (`docs/extensions.md:1965-1972`); absent on a bare harness. */
  events?: unknown;
}

/** The one member of `pi.events` this file needs: subscribe, and keep the unsubscribe if handed. */
type EventUnsubscribe = () => void;

interface ExtensionEventsLike {
  on(channel: string, handler: (payload: unknown) => void): EventUnsubscribe | void;
}

// ---------------------------------------------------------------------------------------------
// The design: `bash` where the host prints its bare `$` mark
// ---------------------------------------------------------------------------------------------
//
// WHAT THE HOST REALLY DRAWS (S11/T17; the fixtures in `test/fake-transcript.ts` carry the source
// lines, and `test/example-bash-matrix.test.ts` drives every cell):
//
// | card style | card content | the heading row the host draws                          |
// | ---------- | ------------ | ------------------------------------------------------- |
// | `float`    | `minimal`    | ` ▎ $ npm test (timeout 30s) …… ctrl+o to expand   `      |
// | `neon`     | `minimal`    | `╭─ $ npm test (timeout 30s) ────── ctrl+o to expand ╮` |
// | any        | `default`    | `$ npm test (timeout 30s)      …padding…` (pi's native row) |
//
// So the mark is `$` in every cell, and only the amount of frame around it changes. The design
// therefore keys on the MARK and on its POSITION, never on a frame's shape, colour or fill:
//
// 1. the heading is the component's first row that carries a letter, a digit or the mark;
// 2. the mark must be the first non-decoration character on that row, followed by a space — a `$`
//    inside a command or an output line (`PATH=$HOME`, `$(date)`) is never a prompt;
// 3. the rows before it, when there are any, must be frame decoration and must NOT include a blank
//    row: pi's native RESULT component starts with a blank `Spacer` row (`Spacer(1)` in
//    `dist/core/tools/renderers/bash.js`), and a bash result is not a heading — that one row is what
//    tells the two components apart in the `default` cell;
// 4. the row must not begin with the outline frame's SIDE or CLOSING rule (`│`, `╰`): a heading is
//    always on the card's top, so a `$` on a body row of the `neon` card (`cat script.sh` printing a
//    prompt) is output, not a heading.
//
// In the `float` cell the top row and a body row share both chrome and position, so this row grammar
// alone could not tell a heading from output — which is why the bridge says WHICH part of the card it
// is drawing (`ctx.part`, S12). The design acts on the CALL only: everything the result component
// draws is returned byte-identical, so a script that echoes `$ …` keeps its output intact.
//
// The word replaces the mark and the row's padding or rule fill gives back the columns it adds, so
// the row keeps the width the host made it. When there is no fill to take them from — a heading whose
// command already fills the row — the design takes them from the HOST'S OWN ABBREVIATION instead:
// the host collapses a long command with `…`, and only that already-shortened text loses three more
// columns, at a grapheme boundary, keeping the ellipsis. A command the host shows in FULL is never
// shortened (a design must not hide what a command does): such a row is returned byte for byte and
// reported once, through the same two channels the rest of this file uses (`ctx.ui.notify` and the
// CARD BASH section), instead of silently drawing nothing the way the first iterations did.
//
// The three limits this rule leaves, all of them stated in README.md and pinned by
// `test/example-bash-matrix.test.ts`: the fill is the row's WIDEST run, so a command carrying a wider
// run of spaces than the frame's fill would have those shortened instead; a heading is only looked
// for in the component's first content row, so a chrome that adds a second row above the heading is
// reported as unrecognised rather than guessed at; and an abbreviation whose graphemes cannot pay
// exactly three columns (a run of two-column glyphs, for example) is refused rather than widened or
// half-cut. Nothing here parses the frame, and the result component is never touched at all
// (`ctx.part === "result"` returns the host's bytes).

/** The heading mark the host prints, and the word the design puts in its place. */
const MARK = "$";
const WORD = "bash";
/** Columns the replacement adds, which the row's own fill has to give back. */
const WORD_COLUMNS = WORD.length - MARK.length;

/** The outline frame's side and closing rules: a `$` on such a row is output, never a heading. */
const FRAME_BODY_STARTS: ReadonlySet<string> = new Set(["│", "╰"]);

/** One visible character of a row and where it starts in the raw string (ANSI skipped). */
interface VisibleChar {
  char: string;
  raw: number;
}

/**
 * One escape sequence the design must not see as text: an SGR colour run or an OSC-8 hyperlink.
 * Sticky, so it is anchored exactly where the reader is looking.
 */
const ESCAPE = /\u001b\[[0-9;]*m|\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/uy;

/**
 * The row's visible characters with their raw offsets. SGR sequences and OSC-8 hyperlinks are
 * skipped, so `raw` always points at the character a reader sees — which is what lets the design
 * splice the mark without touching a single escape sequence.
 */
function visibleChars(line: string): VisibleChar[] {
  const chars: VisibleChar[] = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] === "\u001b") {
      ESCAPE.lastIndex = index;
      const escape = ESCAPE.exec(line);
      if (escape !== null) {
        index += escape[0].length;
        continue;
      }
    }
    const codePoint = line.codePointAt(index);
    const char = codePoint === undefined ? line[index] : String.fromCodePoint(codePoint);
    chars.push({ char, raw: index });
    index += char.length;
  }
  return chars;
}

/** `true` for a character that makes a row content rather than frame: a letter or a digit. */
function isWordCharacter(char: string): boolean {
  return /[\p{L}\p{N}]/u.test(char);
}

/** The columns a reader sees: the row's visible characters, ANSI ignored. */
function visibleWidth(line: string): number {
  let width = 0;
  for (const cluster of graphemes(visibleChars(line))) width += cluster.width;
  return width;
}

/** The segmenter's shape, declared locally so the example needs no lib newer than its host. */
interface GraphemeSegmenterLike {
  segment(input: string): Iterable<{ segment: string; index: number }>;
}

/** The shared grapheme segmenter: one cluster is one thing the terminal draws, never half of it. */
// SAFETY: every runtime the host supports (Node >= 22.18, `package.json` engines) ships
// `Intl.Segmenter`; the standard lib this example is checked against older than ES2022 does not
// declare it, so the constructor is read through a locally declared shape instead of a newer lib.
const GRAPHEMES = new (
  Intl as unknown as {
    Segmenter: new (
      locales?: string,
      options?: { granularity: "grapheme" },
    ) => GraphemeSegmenterLike;
  }
).Segmenter(undefined, { granularity: "grapheme" });

/** Marks, format characters and controls occupy no cell of their own. */
const ZERO_WIDTH_CLUSTER = new RegExp(
  "^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Mark}|\\p{Surrogate})+$",
  "v",
);
/** Leading non-printing code points of a cluster, stripped before its base character is measured. */
const LEADING_NON_PRINTING = new RegExp(
  "^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Mark}\\p{Surrogate}]+",
  "v",
);

/**
 * The columns one grapheme cluster occupies, mirroring pi-tui's `visibleWidth` model closely enough
 * for the abbreviations the host produces: ASCII is one column, a tab is three, a cluster of marks
 * is zero, and an East Asian wide or emoji base is two. The design never needs the full Unicode
 * table, because it only measures text the host itself already clipped.
 */
function graphemeColumns(segment: string): number {
  if (segment.length === 1) {
    const code = segment.charCodeAt(0);
    if (code === 0x09) return 3;
    if (code >= 0x20 && code <= 0x7e) return 1;
  }
  if (ZERO_WIDTH_CLUSTER.test(segment)) return 0;
  const base = segment.replace(LEADING_NON_PRINTING, "");
  const code = base.codePointAt(0);
  if (code === undefined) return 0;
  if (code >= 0x1f1e6 && code <= 0x1f1ff) return 2;
  return isWideCodePoint(code) ? 2 : 1;
}

/** The East Asian wide/fullwidth and emoji blocks a terminal charges two columns for. */
function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f000 && code <= 0x1fbff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** One grapheme cluster of a row, with the visible characters it is made of and its column cost. */
interface Grapheme {
  chars: VisibleChar[];
  width: number;
}

/**
 * The row's grapheme clusters, in order. `visibleChars` already dropped every escape sequence, so a
 * cluster is never cut through an SGR run; the raw offsets on each character are what a caller
 * deletes from.
 */
function graphemes(chars: readonly VisibleChar[]): Grapheme[] {
  const text = chars.map((entry) => entry.char).join("");
  const byOffset = new Map<number, number>();
  let offset = 0;
  for (const [index, entry] of chars.entries()) {
    byOffset.set(offset, index);
    offset += entry.char.length;
  }
  byOffset.set(offset, chars.length);

  const clusters: Grapheme[] = [];
  for (const part of GRAPHEMES.segment(text)) {
    const start = byOffset.get(part.index);
    const end = byOffset.get(part.index + part.segment.length);
    if (start === undefined || end === undefined || end <= start) continue;
    clusters.push({ chars: chars.slice(start, end), width: graphemeColumns(part.segment) });
  }
  return clusters;
}

/**
 * Why a frame the design was handed is not a bash heading. Each reason carries a short label (the
 * CARD BASH row the user reads) and a full sentence (the one-time notice).
 */
const UNRECOGNISED = {
  /** The mark sits on a row of the outlined frame's body, not on the card's top. */
  bodyRow: {
    short: "outline body row",
    detail: "the mark is on an outline body row, never on the card's top",
  },
  /** A blank row comes first: pi's native result component opens with one. */
  blankFirst: {
    short: "blank row first",
    detail: "a blank row comes before the mark, as pi's native result component draws",
  },
  /** The word's columns cannot be taken back without growing the row. */
  noRoom: {
    short: "no fill",
    detail:
      `the row has no padding or rule fill to take the word's ${WORD_COLUMNS} columns from, and the ` +
      "command is shown in full (the design never shortens a command the host did not abbreviate)",
  },
} as const;

/** One reason a frame was refused. */
type Unrecognised = (typeof UNRECOGNISED)[keyof typeof UNRECOGNISED];

/** The card's heading mark: which row it is on, where it starts, and how many columns it costs. */
interface HeadingSite {
  row: number;
  /** Raw offset of the mark in the row, so the word replaces the mark and nothing else. */
  raw: number;
  /** Visible columns the replacement adds, taken back from the row's fill. */
  extra: number;
}

/** What the design could make of one component's rows. Every outcome is a reported answer. */
type Recognition =
  | { kind: "heading"; site: HeadingSite }
  | { kind: "none" }
  | { kind: "unrecognised"; reason: Unrecognised };

/**
 * Where the heading is, or why it cannot be proved. The rule is in the header of this section:
 * content position first, then the mark, then the two shapes that prove the row is not a heading.
 */
function headingSite(lines: readonly string[]): Recognition {
  let row = -1;
  let chars: VisibleChar[] = [];
  for (const [index, line] of lines.entries()) {
    const candidates = visibleChars(line);
    if (!candidates.some((entry) => isWordCharacter(entry.char) || entry.char === MARK)) continue;
    row = index;
    chars = candidates;
    break;
  }
  // No content at all (a padding row, a closing rule): there is nothing to recognise, and nothing
  // to report — this is what a card's last component looks like when the command printed nothing.
  if (row < 0) return { kind: "none" };

  const markIndex = chars.findIndex((entry) => entry.char === MARK);
  // Content without the host's mark: another tool's card, or a bash result. Silently the host's.
  if (markIndex < 0) return { kind: "none" };
  const mark = chars[markIndex];
  if (mark === undefined) return { kind: "none" };

  // A `$` on the outline's side or closing rule is output that happens to start with a prompt.
  const first = chars.find((entry) => entry.char.trim() !== "");
  if (first !== undefined && FRAME_BODY_STARTS.has(first.char)) {
    return { kind: "unrecognised", reason: UNRECOGNISED.bodyRow };
  }

  // A blank row before the mark means this component is not the card's top: pi's native result
  // component opens with a `Spacer` row, so its first output row sits exactly where a heading sits.
  for (const previous of lines.slice(0, row)) {
    if (visibleChars(previous).every((entry) => entry.char.trim() === "")) {
      return { kind: "unrecognised", reason: UNRECOGNISED.blankFirst };
    }
  }

  // The mark must be the row's first non-decoration character (frame padding, a bar, a rule), and a
  // prompt rather than a shell expansion: `$HOME`, `$(date)` and `a$b` are not the mark.
  const before = chars
    .slice(0, markIndex)
    .map((entry) => entry.char)
    .join("");
  if (!/^[^\p{L}\p{N}]*$/u.test(before)) return { kind: "none" };
  const after = chars[markIndex + 1];
  if (after !== undefined && after.char !== " ") return { kind: "none" };

  return { kind: "heading", site: { row, raw: mark.raw, extra: WORD_COLUMNS } };
}

/**
 * Give back the columns the longer mark added, out of the row's own fill: `float`'s space fill,
 * `neon`'s rule fill, pi's trailing padding. The fill is the row's WIDEST run of spaces or rules,
 * which is what the host paints it with in every cell (`cardTop`'s ` ${fill}` and `cardLine`'s
 * padding), and a run no wider than the columns needed is not a fill at all: `undefined` means the
 * row must not be touched. Between equally wide runs the one with no letter or digit beside it wins,
 * so the command text is the last thing this design would shorten; that preference is the documented
 * second limit — a command carrying a wider run of spaces than the frame's fill would have those
 * shortened instead.
 */
function shortenFill(line: string, columns: number): string | undefined {
  const chars = visibleChars(line);
  interface Run {
    start: number;
    length: number;
    /** No letter or digit on either side: unmistakably padding, never part of the words. */
    bounded: boolean;
  }
  const runs: Run[] = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]?.char;
    if (char !== " " && char !== "─") continue;
    let end = index;
    // A fill is one CONTIGUOUS raw run: the host closes the styled run it belongs to before the
    // padding, the hint and the rule that follow, so a space on the other side of an escape sequence
    // belongs to a different part of the row and is never merged into it.
    while (
      end + 1 < chars.length &&
      chars[end + 1]?.char === char &&
      chars[end + 1]?.raw === (chars[end]?.raw ?? 0) + 1
    ) {
      end += 1;
    }
    const before = chars[index - 1]?.char;
    const after = chars[end + 1]?.char;
    runs.push({
      start: index,
      length: end - index + 1,
      bounded:
        (before === undefined || !isWordCharacter(before)) &&
        (after === undefined || !isWordCharacter(after)),
    });
    index = end;
  }
  if (runs.length === 0) return undefined;
  const widest = Math.max(...runs.map((run) => run.length));
  // As wide as the columns needed (or narrower) would empty the fill: the row keeps its bytes.
  if (widest <= columns) return undefined;
  const candidates = runs.filter((run) => run.length === widest);
  const chosen = candidates.find((run) => run.bounded) ?? candidates[0];
  if (chosen === undefined) return undefined;

  let shortened = line;
  for (let index = chosen.start + chosen.length - 1; index >= chosen.start + chosen.length - columns; index -= 1) {
    const at = chars[index]?.raw;
    if (at === undefined) return undefined;
    shortened = `${shortened.slice(0, at)}${shortened.slice(at + 1)}`;
  }
  return shortened;
}

/**
 * Take the word's extra columns out of the command text ITSELF, but only when the host has already
 * abbreviated it: the command ends at the host's `…`, immediately before the optional muted
 * ` (timeout Ns)` suffix (or, with no suffix, before at least the frame's fill). A command the host
 * shows in full is never shortened — a design must not hide what a command does.
 *
 * The three columns are removed from the END of the visible command, one grapheme cluster at a
 * time, never inside an escape sequence and never through a cluster boundary. When whole clusters
 * cannot pay exactly three columns (a wide glyph costs two, for example) the row is refused rather
 * than widened or half-cut; `undefined` means "do not touch this row".
 */
function shortenAbbreviation(line: string, site: HeadingSite): string | undefined {
  const chars = visibleChars(line);
  const markIndex = chars.findIndex((entry) => entry.char === MARK);
  if (markIndex < 0) return undefined;

  let commandStart = markIndex + 1;
  while (chars[commandStart]?.char === " ") commandStart += 1;

  let ellipsis = -1;
  for (let index = commandStart; index < chars.length; index += 1) {
    if (chars[index]?.char === "…") {
      ellipsis = index;
      break;
    }
  }
  if (ellipsis <= commandStart) return undefined;

  // Prove the ellipsis is the HOST's abbreviation and not text the command carries: the host puts
  // either its timeout suffix immediately after it, or its fill (at least two columns) before the
  // hint. Anything else is a `…` shown in full, which must not be touched.
  const tail = chars
    .slice(ellipsis + 1)
    .map((entry) => entry.char)
    .join("");
  const timeout = /^ \(timeout \d+s\)/u.exec(tail);
  if (timeout === null) {
    if (!/^ {2,}(?:\S|$)/u.test(tail)) return undefined;
  } else if (!/^ *(?:\S|$)/u.test(tail.slice(timeout[0].length))) {
    return undefined;
  }

  const clusters = graphemes(chars.slice(commandStart, ellipsis));
  const removed: VisibleChar[] = [];
  let needed = site.extra;
  let index = clusters.length - 1;
  while (needed > 0 && index >= 0) {
    const cluster = clusters[index];
    if (cluster === undefined || cluster.width > needed) return undefined;
    needed -= cluster.width;
    removed.push(...cluster.chars);
    index -= 1;
  }
  // Fewer columns than needed, or every grapheme removed: the command (or its ellipsis) would not
  // survive, so the host's row stands.
  if (needed !== 0 || index < 0) return undefined;

  let shortened = line;
  for (const entry of [...removed].sort((left, right) => right.raw - left.raw)) {
    shortened = `${shortened.slice(0, entry.raw)}${shortened.slice(entry.raw + entry.char.length)}`;
  }
  return shortened;
}

/**
 * Every reason a frame was drawn unchanged, in the order it was first seen, deduplicated: the same
 * card is re-rendered on every frame, so a count would grow without telling the user anything.
 */
const unrecognisedFrames: Unrecognised[] = [];

/**
 * Record (once) that a frame the design was handed was left exactly as the host drew it. Both
 * channels this example owns are used: the TUI notice (delivered on the next `session_start`, and
 * only once per reason) and the live CARD BASH row below.
 */
function recordUnrecognised(reason: Unrecognised): void {
  if (unrecognisedFrames.some((entry) => entry.short === reason.short)) return;
  unrecognisedFrames.push(reason);
  recordNotice(
    `[bash-card] one bash card frame was left exactly as the host drew it: ${reason.detail}. The ` +
      "design only rewrites a heading it can prove, and never a row it cannot keep the width of; the " +
      "CARD BASH sidebar section reports this live.",
  );
}

/** The live report the CARD BASH section shows: `none`, or the last reason a frame was refused. */
function unrecognisedText(): string {
  const last = unrecognisedFrames[unrecognisedFrames.length - 1];
  return last?.short ?? "none";
}

/**
 * The design's whole behaviour: prove where the heading is, swap the mark for the word, keep the
 * row's width. Rows the design has nothing to do with — a body row, a closing rule, another tool's
 * card — are returned as they came, byte for byte; a frame it cannot prove is returned unchanged and
 * reported once.
 */
function applyBashHeading(lines: readonly string[], ctx: ToolDesignContextLike): string[] {
  // The tool name is the bridge's, and it is the same one this file declared; a design that
  // received another tool's rows would be a bridge bug, and drawing them unchanged is the safe
  // answer rather than rewriting a card the design was not for.
  if (ctx.tool !== TOOL_NAME) return [...lines];

  // Only the CALL component heads a card (S12). The host draws the call and the result with the same
  // chrome, so in the `float` cell a result body row that begins with `$ ` sits exactly where a
  // heading sits — and real output does begin with `$ ` when a script echoes its commands. The
  // bridge wraps the two renderers separately and says which one this is, so output is never
  // rewritten. A context with NO `part` comes from an older bridge and is UNKNOWN, not a result:
  // the previous behaviour stands and the row grammar below decides.
  if (ctx.part === "result") return [...lines];

  const recognition = headingSite(lines);
  if (recognition.kind === "unrecognised") {
    recordUnrecognised(recognition.reason);
    return [...lines];
  }
  if (recognition.kind === "none") return [...lines];

  const { site } = recognition;
  const row = lines[site.row];
  if (row === undefined) return [...lines];

  const replaced = `${row.slice(0, site.raw)}${WORD}${row.slice(site.raw + MARK.length)}`;
  const hostWidth = visibleWidth(row);

  // First the host's own fill pays, exactly as before. Only when it cannot — the row's command
  // already fills it — is the HOST'S OWN ABBREVIATION shortened by the same three columns (S14).
  const balanced = shortenFill(replaced, site.extra);
  if (balanced !== undefined && visibleWidth(balanced) === hostWidth) {
    return [...lines.slice(0, site.row), balanced, ...lines.slice(site.row + 1)];
  }

  // The abbreviation is measured on the HOST'S row, where the mark is still in place; the removal
  // is after the mark, so the word can replace it at the same raw offset afterwards.
  const abbreviated = shortenAbbreviation(row, site);
  if (abbreviated !== undefined) {
    const headed = `${abbreviated.slice(0, site.raw)}${WORD}${abbreviated.slice(site.raw + MARK.length)}`;
    if (visibleWidth(headed) === hostWidth) {
      return [...lines.slice(0, site.row), headed, ...lines.slice(site.row + 1)];
    }
  }

  // Growing the row would break the frame the host drew, so the host's row stands.
  recordUnrecognised(UNRECOGNISED.noRoom);
  return [...lines];
}

/**
 * A literal depiction for `/gentle:customize`'s preview. A Cards value draws ONE row (D5), so the
 * sample is the card's heading row and nothing else: the bridge uses a preview's first line.
 */
const DESIGN_PREVIEW = {
  title: `Cards · ${DESIGN_LABEL}`,
  sample: "╭─ bash npm test ───────╮",
};

/** The one registration this file sends. The caller decides whether the surface exists. */
function bashHeadingDesign(): ToolDesignLike {
  return {
    tool: TOOL_NAME,
    id: DESIGN_ID,
    name: PLUGIN_NAME,
    label: DESIGN_LABEL,
    description: "heads the card with bash instead of the host's $ mark",
    preview: () => ({ ...DESIGN_PREVIEW }),
    apply: applyBashHeading,
  };
}

// ---------------------------------------------------------------------------------------------
// The card style: one gutter character per row, for tool cards in general (S17)
// ---------------------------------------------------------------------------------------------
//
// Restored from the version this file had before the design rewrite (`5c0c123:examples/bash-card.ts`
// lines 344-415): the SAME id, so a stored selection still resolves, the same label and the same
// literal preview. Nothing about it is bash-specific — the bridge hands a style the heading, the
// hint and the body text it extracted from any tool card, and the style only decides what chrome to
// draw around them.

/** Stable across loads and unique on the line: `/reload` replaces this value, never adds a second. */
const CARD_STYLE_ID = "bash-card.plain";
/**
 * What the user reads on the host's own `Card style` line. Short, and it collides with neither the
 * host's values (`neon`, `float`), the bridge's `native`, nor another style's label — the bridge
 * rejects a duplicate label at registration (`docs/contract.md` §12).
 */
const CARD_STYLE_LABEL = "plain";
/**
 * What the style's row reads in `/gentle:customize`. Its id (`bash-card.plain`) stays internal: it
 * is the replacement and selection key, and it would read as a dotted key in the menu.
 */
const CARD_STYLE_ROW_LABEL = "plain";

/** One character of gutter per row: no box, no border glyphs, cheap to read. */
const CARD_STYLE_GUTTER = "\u258c";

/** Width-clips one line with a trailing ellipsis, so a row never overflows the width it was given. */
function clipLine(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (width === 1) return "\u2026";
  return `${Array.from(text).slice(0, width - 1).join("")}\u2026`;
}

/**
 * The frame. Three functions, each handed a width and text the BRIDGE already measured and
 * extracted; nothing here looks for a title in a line or strips a frame. Every row goes through
 * `clipLine`, so the style can never emit a line wider than the width it was given.
 *
 * A card in this style at width 40:
 *
 * ```text
 * \u258c read                        ctrl+o
 * \u258c config.ts
 * \u258c
 * ```
 */
const PLAIN_CARD_FRAME: CardFrameLike = {
  top: (ctx) => {
    const head = `${CARD_STYLE_GUTTER} ${ctx.title ?? ""}`.replace(/\s+$/u, "");
    const hint = ctx.hint;
    if (hint === undefined) return clipLine(head, ctx.width);
    // Right-align the hint when there is room for it and at least one space between; otherwise the
    // heading wins and the hint is dropped rather than making the row ambiguous.
    const gap = ctx.width - visibleWidth(head) - visibleWidth(hint) - 2;
    if (gap < 1) return clipLine(head, ctx.width);
    return clipLine(`${head}${" ".repeat(gap)}  ${hint}`, ctx.width);
  },
  line: (ctx) => {
    const row = ctx.text === "" ? CARD_STYLE_GUTTER : `${CARD_STYLE_GUTTER} ${ctx.text}`;
    return clipLine(row, ctx.width);
  },
  // A bare gutter closes the card: the style has no bottom border to draw, and the row costs one
  // column instead of a rule across the frame.
  bottom: (ctx) => (ctx.width > 0 ? CARD_STYLE_GUTTER : ""),
};

/** A literal depiction for `/gentle:customize`'s preview, drawn by the row's `preview()`.
 * Exactly as restored: the same two sample rows and the same closing gutter the user saw before. */
const CARD_STYLE_PREVIEW = {
  title: "Cards \u00b7 plain",
  sample: [
    `${CARD_STYLE_GUTTER} read                 ctrl+o`,
    `${CARD_STYLE_GUTTER} config.ts`,
    `${CARD_STYLE_GUTTER}`,
  ].join("\n"),
};

/**
 * The registration this file sends, or nothing. A style draws what it is given: the bridge owns
 * detection, the heading and the width.
 */
function bashCardStyle(): CardStyleLike {
  return {
    id: CARD_STYLE_ID,
    label: CARD_STYLE_LABEL,
    // A label a user reads, passed explicitly so a reader copies the shape; the bridge would derive
    // `plain` from the label anyway, and the id never appears in a row.
    rowLabel: CARD_STYLE_ROW_LABEL,
    // After any style the host or another plugin leaves unordered; the host's own values come
    // first regardless (`docs/contract.md` §12).
    order: 30,
    frame: PLAIN_CARD_FRAME,
    preview: () => ({ ...CARD_STYLE_PREVIEW }),
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the bridge's selection: one function, so the header and the row can never disagree
// ---------------------------------------------------------------------------------------------

/**
 * The value selected for `bash` right now, read LIVE so the card follows the menu without a reload.
 * Anything unreadable, malformed or missing reads as `native` — the host's own card — which is what
 * the bridge itself would draw.
 */
function readSelection(store: BridgeStoreLike | undefined): string {
  if (store === undefined) return NATIVE_VALUE;
  try {
    const selections: unknown = store.get<unknown>(DESIGNS_STORE_KEY, {});
    if (typeof selections !== "object" || selections === null) return NATIVE_VALUE;
    const selected: unknown = (selections as Record<string, unknown>)[TOOL_NAME];
    return typeof selected === "string" && selected.trim() !== "" ? selected : NATIVE_VALUE;
  } catch {
    return NATIVE_VALUE;
  }
}

/**
 * What a user reads for one stored value. `native` (read as `default`) is the host's card; this file's own design is its
 * label; a value another plugin owns reads as `other design` — an id is internal and never a row.
 */
function selectionText(selected: string): string {
  if (selected === NATIVE_VALUE) return "default";
  if (selected === DESIGN_ID) return DESIGN_LABEL;
  return "other design";
}

// ---------------------------------------------------------------------------------------------
// The demo category: one toggle and one button, and the visible effect in the section
// ---------------------------------------------------------------------------------------------

/** The two values the demo toggle offers; the default is `off`. */
type DemoToggle = "on" | "off";

/** Live read from the example's OWN store; anything unreadable is the default, never a crash. */
function readDemoToggle(store: BridgeStoreLike | undefined): DemoToggle {
  if (store === undefined) return "off";
  try {
    return store.get<unknown>(DEMO_TOGGLE_KEY, "off") === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

/** The button's press count, read live; anything malformed reads as zero. */
function readDemoPresses(store: BridgeStoreLike | undefined): number {
  if (store === undefined) return 0;
  try {
    const stored = store.get<unknown>(DEMO_PRESSES_KEY, 0);
    return typeof stored === "number" && Number.isFinite(stored) && stored > 0 ? Math.floor(stored) : 0;
  } catch {
    return 0;
  }
}

/** Persist one demo value. A store that refuses costs the demo its memory, never the action. */
function writeDemo(store: BridgeStoreLike | undefined, key: string, value: unknown): void {
  if (store === undefined) return;
  try {
    store.set(key, value);
  } catch {
    // The user's next frame reads the old value, which is the honest result of a failed write.
  }
}

/** Ask the bridge to repaint when the published object offers it; an older bridge simply does not. */
function requestSurfaceRepaint(request: (() => void) | undefined): void {
  if (request === undefined) return;
  try {
    request();
  } catch {
    // A failed repaint cannot undo the value the user just changed.
  }
}

/** Short literal depictions for the two demo rows, every line well under 40 columns. */
const DEMO_TOGGLE_PREVIEW = {
  title: "Card bash · Demo toggle",
  sample: ["Demo toggle: on / off", "The sidebar shows the value"].join("\n"),
};
const DEMO_BUTTON_PREVIEW = {
  title: "Card bash · Demo button",
  sample: ["Demo button: one press", "The counter goes up"].join("\n"),
};

/**
 * The example's ONE row provider: a brand-new `Card bash` category with two rows as the user reads
 * them — a two-value toggle and a plain button. Neither does anything real: the toggle is stored,
 * and the button counts its presses, so the user can see both work in the section below.
 */
function demoProvider(store: BridgeStoreLike | undefined, repaint: (() => void) | undefined): RowProviderLike {
  const toggle = (value: DemoToggle): CustomizeRowLike => ({
    category: DEMO_CATEGORY,
    label: DEMO_TOGGLE_SETTING,
    choice: {
      setting: DEMO_TOGGLE_SETTING,
      value,
      current: () => readDemoToggle(store) === value,
    },
    preview: () => ({ ...DEMO_TOGGLE_PREVIEW }),
    action: () => {
      writeDemo(store, DEMO_TOGGLE_KEY, value);
      requestSurfaceRepaint(repaint);
    },
  });

  return {
    id: DEMO_PROVIDER_ID,
    category: DEMO_CATEGORY,
    rows: () => [
      toggle("on"),
      toggle("off"),
      {
        category: DEMO_CATEGORY,
        label: DEMO_BUTTON_LABEL,
        preview: () => ({ ...DEMO_BUTTON_PREVIEW }),
        action: () => {
          writeDemo(store, DEMO_PRESSES_KEY, readDemoPresses(store) + 1);
          requestSurfaceRepaint(repaint);
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// The sidebar section: the live design state
// ---------------------------------------------------------------------------------------------

/**
 * Live state for the card: the value selected for `bash`, and whether this load's design reached the
 * bridge. A function rather than a boolean, so the row stays honest if registration came later than
 * this section's creation.
 */
function bashDesignSection(
  store: BridgeStoreLike | undefined,
  demoStore: BridgeStoreLike | undefined,
  repaint: (() => void) | undefined,
  designRegistered: () => boolean,
  cardStyleRegistered: () => boolean,
): SidebarSectionLike {
  const selectedLabel = (): string => selectionText(readSelection(store));
  return {
    id: SECTION_ID,
    title: SECTION_TITLE,
    // The row label, not the id: the menu reads `card bash  ● shown  ○ hidden`, next to the host's
    // own `stats` / `agents` lines.
    rowLabel: SECTION_ROW_LABEL,
    // The right-aligned meta: the same value the `Cards` row writes, so the two surfaces cannot
    // disagree. Read per frame, which is what makes it LIVE (N14). This is the ONE place the
    // selection is printed; a second body row above the reports only repeated it.
    meta: () => selectedLabel(),
    lines: () => [
      // A plain string, inert on purpose: it reports whether this load's design reached the bus.
      // The per-CARD mount count is the bridge's own diagnostic (`/bridge-status`), not a plugin's.
      `resolver  ${designRegistered() ? "registered" : "absent"}`,
      // The same answer for the restored `plain` style, so an older bridge cannot look like it
      // accepted a surface it never had: `absent` is the honest state, never an assumed `registered`.
      `card style  ${cardStyleRegistered() ? "registered" : "absent"}`,
      // The live answer to "did the design recognise the cards it was handed?". `none` until a frame
      // is refused, then the reason, once — a card is re-rendered on every pass, so a count would say
      // nothing. The same reason is delivered once through `ctx.ui.notify` (`recordUnrecognised`).
      `unrecognised  ${unrecognisedText()}`,
      // The demo's toggle value: a plain string row, rebuilt every frame, so the user sees the change
      // without opening a file.
      `demo toggle  ${readDemoToggle(demoStore)}`,
      // The section's ONE action row (N12): the count is the right-aligned meta, and a click
      // increments the example's own store ONCE and asks the bridge to repaint the section. The
      // bridge draws it like the host's own clickable rows — and paints it with the host's hover
      // role — so the live pointer path can be verified without a debug build.
      {
        label: SECTION_PRESSES_LABEL,
        meta: String(readDemoPresses(demoStore)),
        onClick: () => {
          writeDemo(demoStore, DEMO_PRESSES_KEY, readDemoPresses(demoStore) + 1);
          requestSurfaceRepaint(repaint);
        },
      },
    ],
    // Visible on install: a section needs no extra step from the plugin or the user.
    defaultVisible: true,
    // `order` is read INSIDE one placement slot: a finite order first, ascending, ties by id — never
    // by load order, so two plugins cannot swap cards between sessions.
    order: 20,
    // Where the card sits. `"end"` is the default (after every native card) and is spelled out here
    // because it is the placement that reads best for a status card; `"start"` puts it above the
    // host's own Todo card, and `{ after: "agents" }` right after the Agents card. A section placed
    // after THIS one reads `{ after: SECTION_ID }`.
    placement: "end",
  };
}

// ---------------------------------------------------------------------------------------------
// Reaching gentle-shell-bridge: a runtime handshake, not a path
// ---------------------------------------------------------------------------------------------
//
// A Pi extension lives outside every package, so it cannot resolve a bare specifier, and an absolute
// path is not a contract between two independent projects. So the bridge and the plugin meet on
// `globalThis`, the one channel Pi sanctions (`docs/extensions.md:1965-1972`), behind one stable
// symbol:
//
//   Symbol.for("gentle-shell-bridge/api/v1")  → the frozen, versioned API object
//
// Registration happens in this file's own `session_start` handler, AND on the bridge's
// announcement. Pi does not guarantee that the package loaded first: global extensions load and
// receive `session_start` before a configured package's module publishes, which is exactly the
// order the real TUI reported. So when the symbol is absent the example subscribes to
// `"gentle-shell-bridge:ready"` and registers when it fires; when the symbol is present there is
// nothing to wait for and no listener is taken. Each path calls the same guarded registration.
//
// The constant and the gate MIRROR `src/api.ts` and are inlined on purpose: this file must not
// import the bridge, not even to say hello. Keep them in sync — a breaking change is a new `v2` key,
// never a mutation of this one.

/** The published API object's key. */
const BRIDGE_API_KEY = Symbol.for("gentle-shell-bridge/api/v1");

/**
 * The channel the bridge announces itself on. The string MIRRORS `src/api.ts`: this file cannot
 * import it, so the two are kept in sync by hand. The announcement is a notification, never a
 * registry: it says "the object is published now", and this file reads the symbol again.
 */
const BRIDGE_READY_EVENT = "gentle-shell-bridge:ready";

function bridgeHost(): Record<symbol, unknown> {
  // SAFETY: `globalThis` accepts symbol keys; every value read through this view is gated by
  // `isBridgeApi` before use.
  return globalThis as unknown as Record<symbol, unknown>;
}

/**
 * The shape gate: the schema string, `version === 1` and the members this example calls. Anything
 * else — another library's object, a future major version, a partial object — is treated as ABSENT,
 * never as an error, exactly as the bridge's own `isBridgeApi` does.
 */
function isBridgeApi(value: unknown): value is BridgeApiLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === "gentle-shell-bridge/api" &&
    candidate.version === 1 &&
    typeof candidate.registerSection === "function" &&
    typeof candidate.createStore === "function"
  );
}

/**
 * The two notices for "no published object yet", which are honestly DIFFERENT states:
 *
 * - with a bus, the bridge may still load and announce itself, so the example is waiting and says
 *   what will register when the announcement arrives;
 * - without one, nothing can arrive in this process, so this load adds nothing and says that.
 *
 * Neither claims the bridge is not installed unless nothing can arrive.
 */
const NO_SIGNAL_NOTICE =
  "[bash-card] no compatible gentle-shell-bridge is installed, and this Pi has no cross-extension " +
  "event bus (`pi.events`) for one to announce itself on, so nothing can arrive later: this load " +
  "adds nothing — no bash design, no plain card style, no demo category and no CARD BASH sidebar " +
  "section. A slot that holds another object is treated as absent, never used.";

const WAITING_NOTICE =
  "[bash-card] no compatible gentle-shell-bridge API is published yet, so this load is waiting for " +
  'the "gentle-shell-bridge:ready" announcement the bridge emits when it publishes. If a bridge is ' +
  "installed it registers the bash design for the `bash` tool and the CARD BASH sidebar section " +
  "when the announcement arrives — together with the example's plain card style and its demo " +
  "category; if it is not installed, or the published object is incompatible, " +
  "nothing arrives and nothing registers. A slot that holds another object is treated as absent, " +
  "never used.";

// ---------------------------------------------------------------------------------------------
// The host's cross-extension bus: how a later bridge reaches this load
// ---------------------------------------------------------------------------------------------

/**
 * The host's event bus, when this Pi has one and it looks usable. Reading `pi.events` is guarded
 * because it is host state: a getter that throws must cost the announcement, not the load.
 */
function extensionEvents(pi: ExtensionApiLike): ExtensionEventsLike | undefined {
  let events: unknown;
  try {
    events = pi.events;
  } catch {
    return undefined;
  }
  if (typeof events !== "object" || events === null) return undefined;
  const candidate = events as { on?: unknown };
  return typeof candidate.on === "function" ? (candidate as ExtensionEventsLike) : undefined;
}

// ---------------------------------------------------------------------------------------------
// The in-TUI diagnostics channel
// ---------------------------------------------------------------------------------------------

/**
 * A message that must reach Pi's TUI but cannot yet: at module load no context exists. Notices are
 * NEVER printed — Pi renders its own diagnostics inside the TUI, and text written to the terminal at
 * startup lands outside the report the user reads.
 */
interface PendingNotice {
  message: string;
  /** Drop it once the surfaces register: "waiting" stops being true at that moment. */
  untilRegistered: boolean;
}

const pendingNotices: PendingNotice[] = [];
/** How many a session already showed; a delivered message is never delivered twice. */
let deliveredNotices = 0;

function recordNotice(message: string, options: { untilRegistered?: boolean } = {}): void {
  if (pendingNotices.some((entry) => entry.message === message)) return;
  pendingNotices.push({ message, untilRegistered: options.untilRegistered === true });
}

/**
 * Forget a notice a later registration made untrue. Already-delivered messages stay in the buffer
 * (so they are never shown twice); every other pending message keeps its order.
 */
function withdrawWaitingNotice(): void {
  const stillPending = pendingNotices
    .slice(deliveredNotices)
    .filter((entry) => !entry.untilRegistered);
  pendingNotices.length = deliveredNotices;
  pendingNotices.push(...stillPending);
}

/**
 * Deliver every pending notice through `ctx.ui.notify`. A context without a `notify` delivers
 * nothing, and a `notify` that throws leaves the remaining messages pending for the next session.
 * `settled` means the surfaces are registered, so a "waiting" notice must not be shown.
 */
function flushNotices(ui: unknown, settled: boolean): void {
  const surface = typeof ui === "object" && ui !== null ? (ui as NoticeUiLike) : undefined;
  const notify = surface?.notify;
  if (typeof notify !== "function") return;
  if (settled) withdrawWaitingNotice();
  while (deliveredNotices < pendingNotices.length) {
    try {
      notify.call(surface, pendingNotices[deliveredNotices].message, "warning");
    } catch {
      return;
    }
    deliveredNotices += 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------------------------

export default function bashCardExample(pi: ExtensionApiLike): () => void {
  // Holds whether each optional surface was there at registration. `false` means the bridge is
  // older than that surface: the section still registers and states which one is absent.
  const state: {
    designRegistered: boolean;
    cardStyleRegistered: boolean;
  } = {
    designRegistered: false,
    cardStyleRegistered: false,
  };

  const disposers: Array<() => void> = [];
  let closed = false;
  let bridgeRegistered = false;
  // The bus this Pi offers, when it offers one: the only channel a later-loading bridge can use.
  const events = extensionEvents(pi);
  let unsubscribeReady: EventUnsubscribe | undefined;

  /** Stop listening for the announcement. Anything that throws here cannot cost the load. */
  const stopListening = (): void => {
    const off = unsubscribeReady;
    unsubscribeReady = undefined;
    if (off === undefined) return;
    try {
      off();
    } catch {
      // A disposer that throws cannot resurrect the subscription.
    }
  };

  /** Every surface belongs to one registration lifetime: disposing must not leave half of them. */
  const dispose = (): void => {
    closed = true;
    stopListening();
    for (const registered of disposers.splice(0, disposers.length)) {
      try {
        registered();
      } catch {
        // A disposer that throws must not strand the others.
      }
    }
  };

  /** Register the bridge surfaces once. A stable id each, so a `/reload` replaces, not stacks. */
  const registerWithBridge = (api: BridgeApiLike): void => {
    if (closed || bridgeRegistered) return;

    // The selection is the BRIDGE's: this file opens the published store to READ the value the
    // `Cards` row writes. A store that refuses to answer only costs the section its live text.
    let store: BridgeStoreLike | undefined;
    try {
      store = api.createStore(DESIGNS_STORE_ID);
    } catch (error) {
      recordNotice(
        `[bash-card] could not read the bridge's design selections: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // The demo's OWN store, under this example's plugin id. It is not the bridge's selection file:
    // a plugin's state belongs to the plugin. A store that refuses to open only costs the demo its
    // memory, never the section or the design.
    let demoStore: BridgeStoreLike | undefined;
    try {
      demoStore = api.createStore(EXAMPLE_STORE_ID);
    } catch (error) {
      recordNotice(
        `[bash-card] could not open the example's own store: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // The design first, so its explicit `name` fixes the plugin's one INTEGRATIONS row before the
    // section's registration inherits it. Optional by contract: an object published by an older copy
    // passes the gate without it, and then only the section registers. Its own failure is reported
    // and never costs the section: one surface refusing is not the plugin going silent (the bridge
    // records the rejection in `/bridge-status` as well).
    const registerDesign = api.registerToolDesign;
    if (typeof registerDesign === "function") {
      try {
        disposers.push(registerDesign.call(api, bashHeadingDesign()));
        state.designRegistered = true;
      } catch (error) {
        recordNotice(
          `[bash-card] the bridge refused the bash design: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // The card style: the same optional discipline as the design. An older object without
    // `registerCardStyle` keeps the design, the section and the demo category, and the section says
    // `card style  absent` instead of claiming a surface that never registered.
    const registerCardStyle = api.registerCardStyle;
    if (typeof registerCardStyle === "function") {
      try {
        disposers.push(registerCardStyle.call(api, bashCardStyle()));
        state.cardStyleRegistered = true;
      } catch (error) {
        recordNotice(
          `[bash-card] the bridge refused the plain card style: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // The demo provider: ONE stable id, so a `/reload` replaces it in place instead of stacking a
    // second category. `registerRows` is optional by contract, so an older bridge keeps the design
    // and the section and simply contributes no demo category.
    const registerRows = api.registerRows;
    if (typeof registerRows === "function") {
      try {
        disposers.push(registerRows.call(api, demoProvider(demoStore, api.requestRepaint)));
      } catch (error) {
        recordNotice(
          `[bash-card] the bridge refused the demo category: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    disposers.push(
      api.registerSection(
        bashDesignSection(
          store,
          demoStore,
          api.requestRepaint,
          () => state.designRegistered,
          () => state.cardStyleRegistered,
        ),
      ),
    );
    bridgeRegistered = true;
  };

  /**
   * Register through the published object, if there is one. Three outcomes, because "absent" and
   * "present but unusable" need different notices: the design registration is the one call that can
   * fail while the API is right there.
   */
  const tryRegister = (): "registered" | "absent" | "failed" => {
    if (closed || bridgeRegistered) return "registered";
    const published = bridgeHost()[BRIDGE_API_KEY];
    if (!isBridgeApi(published)) return "absent";
    try {
      registerWithBridge(published);
    } catch (error) {
      recordNotice(
        `[bash-card] the published bridge refused to register its section: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return "failed";
    }
    return bridgeRegistered ? "registered" : "failed";
  };

  /**
   * The bridge published after this file loaded. Registration is the same guarded call
   * `session_start` makes, so an announcement and a later session cannot both register, and a
   * "waiting" notice the user has not seen yet is withdrawn because it is no longer true.
   */
  const onBridgeReady = (): void => {
    // The announcement only says "look again": the symbol is the authority.
    if (tryRegister() === "absent") return;
    withdrawWaitingNotice();
    stopListening();
  };

  // The symbol first. If the bridge loaded before this file there is nothing to wait for, so no
  // listener is taken at all. Otherwise the announcement is the only way a later bridge is heard.
  if (events !== undefined && !isBridgeApi(bridgeHost()[BRIDGE_API_KEY])) {
    try {
      const off = events.on(BRIDGE_READY_EVENT, onBridgeReady);
      if (typeof off === "function") unsubscribeReady = off;
    } catch {
      // No subscription: the `session_start` attempt below still tries the symbol.
    }
  }

  // Pi renders diagnostics inside the TUI, so every message this example produces is delivered
  // there — never on stdout/stderr — and the handler does nothing when the context has no UI.
  const onSessionStart = (_event: unknown, ctx: SessionContextLike): void => {
    if (closed || ctx.hasUI !== true) return;

    if (tryRegister() === "absent") {
      // Two honest states: with a bus the bridge may still announce itself, without one nothing can
      // arrive in this process. The notice says which, and the waiting one is withdrawn if it
      // happens to register before the next session shows it.
      if (events === undefined) recordNotice(NO_SIGNAL_NOTICE);
      else recordNotice(WAITING_NOTICE, { untilRegistered: true });
    }

    flushNotices(ctx.ui, bridgeRegistered);
  };
  if (typeof pi.on === "function") pi.on("session_start", onSessionStart);

  // Nothing depends on this return value — the stable ids are what make a `/reload` replace rather
  // than stack — it exists so a programmatic caller can tear every surface down together, and it
  // drops the announcement listener with them.
  return dispose;
}
