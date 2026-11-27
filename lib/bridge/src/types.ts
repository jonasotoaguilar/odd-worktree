/**
 * The public row/provider contract, mirroring `docs/contract.md` §2–§3.
 *
 * The bridge carries rows through unchanged: it never reads, rewrites or interprets a row, so
 * every field here is a pass-through of what gentle-shell's renderer already understands
 * (`lib/visual-customize-view.ts:107-140`).
 */

/**
 * Context handed to a provider's `rows(ctx)` once per menu build.
 *
 * `theme` is the host's opaque theme object, passed through untouched; the bridge does not
 * depend on its shape, so consumers narrow it themselves. `configHome` is the resolved
 * gentle-shell config home (see `./config.ts`), so a plugin can place per-user state without
 * re-deriving the path.
 */
export interface RowContext {
  readonly theme: unknown;
  readonly configHome: string;
}

/** Row text; a function is evaluated when the menu is built. */
export type RowLabel = string | (() => string);

/** One value of a setting. Consecutive rows sharing `setting` share one rendered line. */
export interface RowChoice {
  setting: string;
  value: string;
  current(): boolean;
  hint?: string;
  /** `false` makes Enter apply the choice instead of applying on ←/→. */
  applyOnMove?: boolean;
}

/** Read-only depiction of the highlighted choice; never an application. */
export interface RowPreview {
  title: string;
  sample: string;
}

/**
 * Inline helpers available to `action`, so a row never opens a nested native dialog.
 * Shapes mirror `lib/visual-customize-view.ts:129-140`.
 */
export interface InlineHelpers {
  input(options: { prompt: string; value?: string }): Promise<string | undefined>;
  confirm(message: string): Promise<boolean>;
  capture(prompt: string): Promise<string | undefined>;
}

/**
 * A settings row as gentle-shell's renderer understands it. There are exactly two kinds (S16), and
 * both are first class — neither is an accident of a missing field:
 *
 * - a TOGGLE row carries a `choice`. Consecutive rows sharing `choice.setting` render as one line and
 *   ←/→ moves the cursor; the bridge stages every such row with `applyOnMove: false` so Enter applies;
 * - a BUTTON row carries an `action` and NO `choice`. Enter (or Space) runs it — exactly the shape of
 *   the host's own `Reset` and `Profiles` rows (`extensions/gentle-shell.ts:3541,3550`, run at
 *   `lib/visual-customize-view.ts:575-577`). Its whole visible text is its `label`.
 *
 * `category` names the page. The host derives its pages from the rows it holds, but a page it owns
 * differently is not open to plugins: `Keymaps` is REFUSED (S15) — the whole registration when that
 * is the provider's own category, and the single row when the row names it, so its siblings still
 * render. Every other value is an ordinary category.
 *
 * `label` — and a button's label above all, because it is the row's entire visible text — is a row
 * name: one to three plain words with no arrow, colon, dot, pipe, slash or bracket (`./row-names.ts`).
 * A label that breaks the shape is refused and reported verbatim, never rewritten.
 *
 * The bridge adds nothing to a button row: no `choice` is invented and no `applyOnMove` is staged
 * (`./rows.ts`). Its one deliberate change is the `action`, which it wraps so a throw or a rejected
 * promise is reported once through the bridge's notice channel and never reaches the menu.
 */
export interface CustomizeRow {
  /**
   * Optional here: a provider whose rows all belong to its own `provider.category` may omit it,
   * and the capture backend fills it from there (shallow-cloning the row, never mutating it).
   * The host's renderer still requires a category on every row it receives.
   *
   * `Keymaps` is the one reserved value (S15): the row is refused and reported instead of appearing
   * on the host's key-capture page.
   */
  category?: string;
  label?: RowLabel;
  choice?: RowChoice;
  preview?: () => RowPreview;
  /** Hidden when false; a throw fails closed (row hidden). */
  visible?: () => boolean;
  keyhint?: string;
  /**
   * Runs on Enter/Space. The host requires it on every row (`lib/visual-customize-view.ts:124`); on a
   * button row (no `choice`) it is what makes the row do anything at all.
   *
   * The bridge hands the host a wrapped copy and never the raw function: a synchronous throw or a
   * rejected promise is caught, reported once in `/bridge-status` (and by the next `ui.notify`), and
   * swallowed, so neither the menu nor the other rows can be broken by one failing action. The
   * provider's own object is not mutated.
   */
  action?: (inline: InlineHelpers) => void | Promise<void>;
}

/**
 * Context handed to a section's `lines(ctx)` and `meta(ctx)` on every frame.
 *
 * The same shape as `RowContext` — the host's theme, passed through untouched, and the resolved
 * gentle-shell config home — so a plugin that already builds rows uses one context type for both
 * surfaces and never re-derives the path. Aliased rather than duplicated: two identical interfaces
 * would drift.
 */
export type SectionContext = RowContext;

/**
 * The semantic roles a section row may paint with (N10). They are the host's own theme roles —
 * `lib/shell-bar.ts:98-101` paints `fg(role, text)` for exactly these names, and
 * `lib/shell-sidebar-layout.ts:123-124` signatures a theme with nine of them — so a row says what it
 * MEANS (`error`, `success`, `muted`) and the theme decides the colour. A raw colour, an SGR code or
 * any other word is rejected when the row is built, never coerced: a row the theme cannot paint
 * would otherwise reach the terminal as plain text the author believed was styled.
 */
export type Tone = "text" | "muted" | "dim" | "accent" | "success" | "error" | "warning";

/** The roles a `Tone` may name, for validation and for the docs. */
export const TONES: readonly Tone[] = [
  "text",
  "muted",
  "dim",
  "accent",
  "success",
  "error",
  "warning",
];

/**
 * One body row of a section (N10): what the host's own `AGENTS` rows carry, and nothing more.
 *
 * `label` is the row's text; `meta` is the right-aligned secondary column (tokens, elapsed time, a
 * value — the field that updates live, N14); `glyph` is a one-character mark before the label;
 * `tone` names a semantic role; `onClick` is what makes the row CLICKABLE (N12). A row without
 * `onClick` is inert: it never highlights under the pointer and never answers a click.
 */
export interface SectionRow {
  label: string;
  meta?: string;
  glyph?: string;
  tone?: Tone;
  onClick?: () => void;
}

/**
 * One body row: a plain string (kept byte-identical, so no existing plugin changes appearance) or a
 * structured row.
 */
export type SectionLine = string | SectionRow;

/**
 * The rail parts the host actually paints, in paint order (`lib/shell-sidebar-layout.ts:344`, host
 * checkout `e4f8a4b29`): `todo`, `jobs`, `agents`, `footer`. A part outside this list never renders,
 * so contributing to it would be invisible; a part that is absent, or whose render is empty, is not
 * painted either.
 */
export const RAIL_PARTS = ["todo", "jobs", "agents", "footer"] as const;

/** One painted rail part. `footer` is the host's last part, which is why `"end"` is `after footer`. */
export type RailPart = (typeof RAIL_PARTS)[number];

/**
 * Where a section asks to sit (S1). Absent means `"end"`, the historical behaviour: after every
 * native part. It is registration data, like `order` — never persisted, never a setting, and it
 * names a PLACEMENT in the rail, never a rail key the plugin writes.
 */
export type SectionPlacement = "start" | "end" | { after: string };

/**
 * A plugin's sidebar section: the analogue of `RowProvider` for the rail, mirroring the sidebar
 * spec's S2. The plugin writes content only — it never names a `setting`, a rail key or a card
 * frame; the bridge frames the section, draws the host's header and contributes the section's
 * visibility and collapse controls.
 */
export interface SidebarSection {
  /** Unique and stable: the key for ordering, replacement and the persisted visibility toggle. */
  id: string;
  /** The section heading, drawn like the host's own `AGENTS`/`CHANGES`/`STATS` titles. */
  title: string;
  /** Optional display name for the plugin's INTEGRATIONS line; see `RowProvider.name`. */
  name?: string;
  /**
   * What the `Sections` rows read, e.g. `"music"`. Optional: when absent the bridge derives it from
   * `title` (lowercase words, no dots, no prefix), and two sections whose labels read the same are
   * disambiguated deterministically and reported by `/bridge-status`. The `id` is never shown.
   */
  rowLabel?: string;
  /** Optional right-aligned text, the analogue of `idle` / `clean` / `3`. */
  meta?(ctx: SectionContext): string | undefined;
  /**
   * The body, evaluated per frame, so live state is honest without a redraw API. A throw drops
   * this section's body, and only this section's. A row is a plain string or a `SectionRow`
   * (N10), and a structured row's `meta` — like the body itself — is read at render time, so a
   * plugin that changes it is repainted without re-registering (N14). A collapsed section is not
   * built at all (N13).
   */
  lines(ctx: SectionContext): SectionLine[];
  /** Visible unless the user (or the plugin) says otherwise; defaults to `true`. */
  defaultVisible?: boolean;
  /**
   * Optional integer, read INSIDE one placement slot: sections with an `order` render first,
   * ascending; sections without one follow. Ties (equal `order`, or both missing) are broken by
   * `id` — never by load order, so the same registrations in any order draw the same rail (S2).
   */
  order?: number;
  /**
   * Where the card sits in the rail (S1). Absent means `"end"`: after every native part, exactly as
   * before this field existed. `"start"` sits before the first painted native part; `{ after: id }`
   * sits right after that section, or after one of the native parts `todo`, `jobs`, `agents`,
   * `footer`. An anchor that cannot be honoured (unknown, a cycle, a native part the host does not
   * paint) falls back deterministically, and `/bridge-status` reports where the card really went and
   * why. A malformed value is reported the way a rejected `rowLabel` is, and the card is placed at
   * the end instead of vanishing.
   */
  placement?: SectionPlacement;
}

/**
 * Where a provider asks its block of rows to sit inside its category (S1). Absent means `"end"`,
 * the historical behaviour: after the host's own rows of that category. It is registration data,
 * like `order` — never persisted, never a setting, and it names a PLACEMENT in the menu, never a
 * category or a setting the plugin writes.
 */
export type RowPlacement = "start" | "end" | { after: string };

/**
 * Where the PAGE a provider's block opens sits among the menu's pages (S21). Only a block whose
 * `category` is a page the host does not already list opens one; a block that joins an existing
 * page is ordered by `placement` instead, inside that page.
 */
export type CategoryPlacement = "end" | { after: string };

/** A plugin's contribution: rows for one category, built lazily per menu build. */
export interface RowProvider {
  /** Unique and stable, e.g. `"loon.banner-source"`; the key for ordering and replacement. */
  id: string;
  /**
   * The category this provider adds rows to. `Keymaps` is reserved (S15): a registration naming it is
   * refused with an error that says why, before anything is stored, and the refusal is reported in
   * the plugin's INTEGRATIONS line. Place the rows in one of the host's setting categories instead.
   */
  category: string;
  /**
   * Optional display name for this plugin's INTEGRATIONS line, e.g. `"Loon kit"`. Honoured on the
   * plugin's FIRST registration only; later ones are ignored. It overrides the name derived from the
   * owning package, must obey the row-name shape (one to three plain words, no structural marks) and
   * is never rewritten: a rejected name produces no line at all. A single-file extension with no
   * `package.json` above it is otherwise unattributable and gets no line — naming it here is how it
   * gets one.
   */
  name?: string;
  /** Evaluated each time the menu is built, never at registration. */
  rows(ctx: RowContext): CustomizeRow[];
  /**
   * Optional finite number, read INSIDE one placement slot: providers with a finite `order` draw
   * first, ascending; providers without one follow. Every tie (equal `order`, or both missing) is
   * broken by `id` — never by load order, so the same registrations in any order draw the same menu
   * (S2).
   */
  order?: number;
  /**
   * Where this provider's block sits in its category (S1). Absent means `"end"`: after the host's
   * own rows of that category, exactly as before this field existed. `"start"` sits before the
   * category's first row; `{ after: id }` sits right after another row provider's block, where
   * `id` is a PROVIDER id — a host row's label is not an anchor. An anchor that cannot be honoured
   * (unknown, in another category, a cycle, or a category the host did not build) falls back
   * deterministically, and `/bridge-status` reports where the block really went and why. A
   * malformed value is reported the way a rejected section `placement` is, and the block is placed
   * at the end instead of vanishing.
   */
  placement?: RowPlacement;
  /**
   * Where the PAGE this block opens sits among the menu's pages (S21). Absent means `"end"`, exactly
   * as before this field existed. `{ after: name }` sits right after that category's block, so
   * `{ after: "Sections" }` opens the page between `Sections` and the page that follows it. A name
   * that cannot be honoured — unknown, the provider's own category, or a page this build does not
   * produce — falls back to the end deterministically, and `/bridge-status` reports the landing and
   * why. It is honoured while the menu is being built: a page list the host already derived cannot
   * be resequenced afterwards.
   */
  categoryPlacement?: CategoryPlacement;
}

/**
 * What a card style's `top` receives: the measured width, plus the pieces of the host's own frame
 * the bridge extracted once, in one place (S2). A style must never try to parse them back out of a
 * line.
 */
export interface CardFrameTopContext {
  readonly width: number;
  /** The card's title as the host printed it, without the glyph; absent when it could not be found. */
  readonly title?: string;
  /** The right-aligned hint as the host printed it, e.g. `ctrl+o`; absent when the card had none. */
  readonly hint?: string;
}

/** What a card style's `line` receives: one body row of the host's card. */
export interface CardFrameLineContext {
  readonly text: string;
  readonly width: number;
  /** `true` for the first body row of the card, `false` for every continuation row. */
  readonly first: boolean;
}

/** What a card style's `bottom` receives. */
export interface CardFrameBottomContext {
  readonly width: number;
}

/**
 * The three functions a style draws with, and the whole of what the bridge calls (S2). The bridge
 * supplies the width and the text; it never asks the style where anything is.
 */
export interface CardFrame {
  top(ctx: CardFrameTopContext): string;
  line(ctx: CardFrameLineContext): string;
  bottom(ctx: CardFrameBottomContext): string;
}

/**
 * What a transform reports about its own frame (F1): how many candidate cards it examined, how many
 * it recognised, how many it rewrote, and — when its grammar has several shapes — which shape
 * matched, by the transform's own name for it.
 *
 * COUNTS ONLY. A frame carries the user's private output, so nothing of it may be stored or shown:
 * no line, no text, no plugin output. A shape name is therefore a NAME and nothing else — lowercase
 * letters, digits, `_`, `.` or `-`, at most 24 characters — and anything else is dropped rather than
 * recorded (`src/transform-pipeline.ts` sanitises every value before it is stored).
 */
export interface TransformCounts {
  /** Rows the transform examined as a possible card head. */
  candidates: number;
  /** Candidates its grammar accepted. */
  recognised: number;
  /** Cards it actually rewrote this frame; `0` when its setting leaves them alone. */
  rewritten: number;
  /** Which shape matched, by name, and how many times. Absent when the grammar has one shape. */
  shapes?: Readonly<Record<string, number>>;
}

/**
 * Which host child produced one drawn row (S1).
 *
 * The identity comes from the COMPONENT, never from the drawn words: the host heads a bash card
 * with the activity it inferred (`extensions/quiet-tools.ts:672` in `cards-bash-v2`), so a grammar
 * over the title breaks the next time a title changes. `toolName` is exactly the member the host's
 * own tool rows carry and `pi-cinlodev-cute` reads (`src/transcript/transcript-dispatcher.ts:30-40`:
 * `child.toolName === "bash"`), and `component` is the child's `constructor.name` — the fallback for
 * a child that carries no tool name at all (a banner, a spacer, a host block drawn by its own class).
 *
 * A plugin narrows with these two members and nothing else; no component reference is handed out, so
 * a transform can neither re-render nor mutate the host's tree. The bridge derives one entry per row
 * from the layout the host's own render pass published (`mouseLayout`), never by rendering children
 * a second time.
 */
export interface RowOrigin {
  /** The row's index in the frame: row 0 is the first row handed to the transform. */
  readonly index: number;
  /** The child's `toolName`, e.g. `"bash"`; absent when it carries none as a string. */
  readonly toolName?: string;
  /** The child's `constructor.name`, e.g. `"ToolExecutionComponent"`; absent when it has none. */
  readonly component?: string;
}

/**
 * Context handed to a transform on every frame. `width` is the width the host rendered the
 * conversation at, which is also the hard limit on what the transform may return (S4).
 */
export interface TransformContext {
  readonly width: number;
  /**
   * Which host child drew each row, one entry per row of this frame (S1), or an EMPTY array when the
   * origin is unknown — a host render that published no layout, a layout measured at another width,
   * or heights that do not add up to the frame. Unknown is reported as empty, never as a guess and
   * never as an error: a transform that does not need the origin ignores the field and behaves
   * exactly as it did before it existed.
   *
   * Optional for the same reason `report` is: a context produced by a copy (or a probe) older than
   * this field has no such member. The pipeline ALWAYS sets it — unknown origins are `[]`, never
   * `undefined` — so a transform reads `ctx.rows ?? []` and works against either producer.
   */
  readonly rows?: readonly RowOrigin[];
  /**
   * Report this frame's counts (F1). The bridge adds the line count and the outcome itself, records
   * the result in this frame's entry for `/bridge-status`, and never lets it reach the frame: a
   * throw, or nonsense, costs the counts and nothing else (F4).
   *
   * Optional because a published bridge older than the telemetry has no such member: call it behind
   * `typeof ctx.report === "function"` and the transform keeps working with either.
   */
  report?(counts: TransformCounts): void;
}

/**
 * A plugin's transcript transform (S1): a function over the conversation's lines.
 *
 * Unlike a card style, a transform is not given a detected card — it sees the rows the host (and
 * any earlier transform) produced and returns the rows to draw. That is the layer a rendering
 * choice needs to apply to cards that are ALREADY on screen: a tool renderer resolves once, when a
 * row is built, while the conversation component renders every frame.
 *
 * The bridge clips whatever comes back to `ctx.width`, skips the transform for the frame if it
 * throws, and never lets a transform into Pi's render loop (S3, S4).
 */
export interface TranscriptTransform {
  /** Unique and stable: the replacement key, the ordering key and the `/bridge-status` name. */
  id: string;
  /** Optional display name for the plugin's INTEGRATIONS line; see `RowProvider.name`. */
  name?: string;
  /**
   * Optional integer. Transforms with an `order` run first, ascending; the rest follow in
   * registration order, so several plugins always produce one deterministic pipeline (S2).
   */
  order?: number;
  /** The rows, and the width to honour. Return the rows to draw. */
  transform(lines: readonly string[], ctx: TransformContext): readonly string[];
}

/**
 * Context handed to a tool design's `apply` on EVERY render pass of the host's card (S5).
 *
 * `width` is the width the host asked its own component to render at, `tool` is the tool name the
 * design was declared for (never anything the card draws), and `theme` is the opaque theme object the
 * host handed that renderer (`renderCall`'s second argument, `renderResult`'s third). The bridge does
 * not depend on the theme's shape, so a design that wants a colour narrows it itself.
 *
 * `part` says WHICH half of the card this pass is drawing (S12). A card has two components — the call
 * and the result — and the host draws them with the same chrome, so from rows alone the two are
 * indistinguishable: a float result body row that begins with `$ ` (a script echoing commands) sits
 * exactly where a float heading sits. The bridge wraps the two renderers separately and sets `part`
 * per renderer, so a design can act on the call alone instead of guessing from drawn text. A design
 * that ignores `part` behaves exactly as it did before the field existed.
 *
 * `cardStyle` is the style the USER has selected right now (S22): `native` when the bridge paints
 * nothing, the live registration when a plugin's style is selected, and `missing` for an id nobody
 * owns any more. It is what lets a design honour `float`/`neon` on a card the host never styles
 * itself — a tool another extension registers, like `bash_background`. Resolved on ACCESS and at
 * most once per pass, so a design that never reads it draws exactly what it drew before the field
 * existed, and pays nothing for it; a design that reads it twice gets ONE answer, so a switch landing
 * mid-pass can never draw half of each.
 */
export interface ToolDesignContext {
  readonly width: number;
  readonly tool: string;
  readonly theme?: unknown;
  /** The renderer this pass came from: `renderCall` or `renderResult`. */
  readonly part: "call" | "result";
  /**
   * What Pi's render context says about THIS tool call, read at this pass: the call's arguments and
   * whether it is running, failed or finished, and how long it took. Optional because a host that
   * hands no render context (or an older bridge) leaves it out; a design that needs it must work
   * without it.
   */
  readonly render?: ToolDesignRender;
  /**
   * The style the user has selected, resolved live on access. Absent on a bridge older than S22, and
   * `missing` for a style that was disposed while it was selected (a `/reload`, a plugin unloaded):
   * a design must degrade to its own default in both cases, exactly as the bridge itself does.
   */
  readonly cardStyle?: CardStyleSelection;
}

/**
 * The fields of the host's render context a design may read, copied by value so a design cannot
 * reach the host's live context. Every field is optional: the bridge forwards only what the host
 * actually provided, with the type it has.
 */
export interface ToolDesignRender {
  /** Stable across the call's and the result's passes: the key that ties the two halves of a card. */
  readonly toolCallId?: string;
  /**
   * The call's arguments exactly as Pi holds them (for `bash`, `{ command, timeout? }`): the HOST's own
   * object, forwarded by reference and never cloned or frozen. Treat it as read-only; mutating it is
   * unsupported (Pi keeps updating it while the call streams).
   */
  readonly args?: unknown;
  /** The result is partial or streaming: the call is still running. */
  readonly isPartial?: boolean;
  /** The finished call reported an error. */
  readonly isError?: boolean;
  /** Milliseconds the execution took; undefined while it runs or when none was recorded. */
  readonly durationMs?: number;
  /** The row is expanded. */
  readonly expanded?: boolean;
}

/**
 * ONE call of a tool, as a scope sees it (S7/S10): the tool name and the arguments Pi holds for that
 * call, forwarded BY REFERENCE and never cloned or frozen. A scope never sees the card's `part`, so
 * both halves of one card are resolved with the same INPUT — and the same procedure. The arguments
 * are read again on each pass and Pi keeps updating them while a call streams, so a scope that reads
 * a field the host mutates mid-call can answer differently for the two halves: read fields that are
 * stable for the life of a call (a `path`), never a streaming body.
 */
export interface ToolDesignCall {
  readonly tool: string;
  readonly args?: unknown;
}

/**
 * The narrower-than-a-tool claim a line may declare (S7): the calls of its tools this line OWNS.
 *
 * A scope is a PREDICATE, never a declarative path rule: path identity ("under `skills/` or `odd/`")
 * is the consumer's own rule, and this bridge is tool-agnostic by construction. It is the same trust
 * model `apply` already has — plugin code the host runs, isolated on throw — because a function has
 * no printable form, `description` is required: the menu and `/bridge-status` have to explain which
 * calls the line owns.
 */
export interface ToolDesignScope {
  /**
   * One short line a preview and `/bridge-status` can show, e.g. `paths under skills/ or odd/`. One
   * line LITERALLY (S18): the bridge renders it INSIDE an existing row, so a CR or LF would add a row
   * and the registration is refused whole.
   */
  readonly description: string;
  /**
   * Whether this line owns THIS call, answered SYNCHRONOUSLY with `true` or `false` (S18). A paint
   * cannot await, so any other answer (a Promise, a truthy string, `undefined`) counts as "this line
   * does not own the call" and is reported in `/bridge-status`. Cheap and pure; the bridge isolates a
   * throw.
   */
  matches(call: ToolDesignCall): boolean;
}

/**
 * A plugin's design for ONE tool's card (S4, S5, S7).
 *
 * A design never owns the frame: the host's own renderer runs first, and the design receives the
 * rows that card produced and returns the rows to draw. Anything it does not deliberately change must
 * come back byte for byte — including ANSI sequences and trailing padding — because the frame is
 * still the host's (`neon` stays neon, `float` stays float).
 *
 * A design is declared for a TOOL NAME (`bash`, `write`, `edit`, `mcp__engram__mem_save`, ...), never
 * for bash specifically: a design declared for a tool that has no card yet applies as soon as Pi
 * builds one, because Pi resolves renderers when the card is constructed.
 */
export interface ToolDesignRegistration {
  /**
   * The tool name this design draws, for an UNGROUPED registration: it gets its own `Card <tool>`
   * line. Exactly one of `tool` / (`line` + `tools`) is required; mixing them is refused.
   */
  tool?: string;
  /**
   * The line this design joins, for a GROUPED registration. Several registrations naming the same
   * line — from one plugin or two — join ONE `Card <line>` line whose values are its designs in
   * registration order (S3), and whose tool set is the union of their `tools`.
   */
  line?: string;
  /**
   * The tools a GROUPED design paints. Required with `line`, refused with `tool`. Non-empty,
   * deduplicated, each a valid tool name. A tool's claim is UNSCOPED when neither `scopes[tool]` nor
   * the `scope` shorthand supplies a scope for it. A tool has at most ONE unscoped claim (S9/D1): a
   * registration whose unscoped claim meets another one on the same tool is refused whole, and
   * reported in `/bridge-status` — the other claim may live on a different line, or on the tool's own
   * legacy `Card <tool>` line. A claim that carries a scope claims only the calls its scope matches,
   * so any number of scoped claims may name one tool, beside that one unscoped claim.
   */
  tools?: readonly string[];
  /**
   * Optional. The scope of each TOOL's claim (S19): a key is one of THIS registration's `tools`, and
   * the value is the `ToolDesignScope` that line owns of that tool's calls. A tool with no entry
   * claims EVERY call of it, exactly as a registration carrying no scope at all does.
   *
   * A scope belongs to the (line, tool) CLAIM and not to the line, so one line may own some tools
   * unconditionally and narrow others — `Card tools` paints bash/grep/find/ls/read for every call
   * and write/edit only under `skills/` or `odd/` — while another line carries the generic claim on
   * the same tools. Specific beats generic at paint time: the matching scoped claims answer first and
   * the one unscoped claim answers last. An invalid map (not an object, empty, a key that is not one
   * of `tools`, a value that is not a scope) refuses the whole registration. Declared on a GROUPED
   * registration only, like `scope`.
   */
  readonly scopes?: Readonly<Record<string, ToolDesignScope>>;
  /** Unique per line (or per tool when ungrouped): the value the user selects and the key for replacement. */
  id: string;
  /**
   * Optional display name for the plugin's INTEGRATIONS line, e.g. `"Loon kit"`. Same rule as
   * `RowProvider.name`: honoured on the plugin's FIRST registration only, must obey the row-name
   * shape, and never rewritten. A single-file extension with no `package.json` above it has no
   * attributable package and gets no line unless it names itself here — which is why a plugin that
   * contributes ONLY designs still needs this member.
   */
  name?: string;
  /**
   * The tool-design switch this design follows instead of having a switch of its own (S1, 0.12.0).
   * A following design contributes NO value to the customize menu: the value the user already picked on
   * that tool line is what turns it on. Omit it for a design with its own `Message <line>` line, which
   * is what every 0.11.0 registration does.
   */
  follows?: MessageDesignFollow;
  /** The short text shown on the customize line as this design's value. */
  label: string;
  /** One line a preview can show about what the design does. */
  description?: string;
  /** Optional literal depiction of the design, drawn in the customize preview. */
  preview?(): RowPreview;
  /**
   * Optional SHORTHAND for `scopes` (S19): the SAME scope object on every tool of `tools`. Refused
   * together with `scopes`, because the two spellings of one claim would disagree.
   *
   * A claim without a scope claims EVERY call of its tool, exactly as before (S7/S8). A scoped claim
   * owns only the calls `matches` answers true for, so another line may name the same tool for the
   * calls this one does not own. A scope is declared on a GROUPED registration ONLY (`line` +
   * `tools`): an ungrouped registration IS the tool's own `Card <tool>` line, which means every call
   * of the tool by definition, so `{ tool, scope, … }` is refused whole. Every live registration of
   * ONE line that names a tool must share the SAME scope object for that tool: a line is one switch
   * per call of a tool, and a scope per design would make one switch mean different calls. A
   * registration that does not name the tool does not constrain it. An invalid scope (no
   * description, no `matches`) refuses the whole registration.
   */
  readonly scope?: ToolDesignScope;
  /**
   * The host's rows in, the rows to draw out. The bridge hands a fresh copy, clips nothing and
   * isolates a throw: an `apply` that throws (or returns something that is not an array of strings)
   * leaves the host's own card on screen and is reported in `/bridge-status`.
   */
  apply(lines: readonly string[], ctx: ToolDesignContext): string[];
}

/**
 * A plugin's card style: chrome, never a parser (S1). The bridge owns detection and hands this
 * registration's `frame` the card it found; the style owns only what the card looks like.
 */
export interface CardStyleRegistration {
  /**
   * Unique and stable: it is the value the user selects and the key for ordering and replacement.
   * It may not be `native` (the bridge's own pass-through value) nor one of the host's own values,
   * because the line would then show the same value twice.
   */
  id: string;
  /** Optional display name for the plugin's INTEGRATIONS line; see `RowProvider.name`. */
  name?: string;
  /** The short text shown on the `Card style` line for this value. */
  label: string;
  /**
   * What this style's row reads in the menu, e.g. `"plain"`. Optional: when absent the bridge
   * derives it from `label` (lowercase words, no dots, no prefix). `label` stays the line's value and
   * the `id` stays internal; the row never shows the id.
   */
  rowLabel?: string;
  frame: CardFrame;
  /** Optional literal depiction of the style, drawn in the customize preview. */
  preview?(): RowPreview;
  /**
   * Optional integer. Styles with an `order` come first, ascending; the rest follow in registration
   * order, so several plugins always produce one deterministic value sequence (S12).
   */
  order?: number;
}

/**
 * What the stored card-style selection means right now (S12, S22).
 *
 * `native` is "the bridge paints nothing" and is the default, `style` is the live registration a
 * design should honour, and `missing` is a first-class answer rather than an error: a style that was
 * disposed while it was selected leaves a stored id nobody owns, and the bridge must degrade to
 * `native` and say so instead of rendering chrome that no longer exists. Resolving never throws for
 * any stored value, because that answer is what the transformer — and now a tool design — degrades
 * from.
 */
export type CardStyleSelection =
  | { kind: "native" }
  | { kind: "style"; style: CardStyleRegistration }
  | { kind: "missing"; id: string };

/**
 * What Pi's render context says about ONE custom message, read on every pass (S1). The message is the
 * HOST's own object, forwarded by reference exactly like `ToolDesignRender.args`: treat it as
 * read-only. `expanded` and `outputPad` are Pi's own render options, so a design can honour the
 * user's collapse choice instead of guessing from drawn text.
 */
export interface MessageDesignRender {
  /** The row is expanded: the user pressed the host's expand key on it. */
  readonly expanded: boolean;
  /** The host's own output padding for the message component. */
  readonly outputPad: number;
  /**
   * The custom message Pi is drawing, forwarded BY REFERENCE and never cloned or frozen: its
   * `customType`, its `content`, and whatever the sending extension put in it. Pi keeps it live, so
   * read it per pass and never cache it.
   */
  readonly message: unknown;
}

/**
 * Context handed to a message design's `apply` on EVERY pass of the message's component (S1).
 *
 * It is the tool-design context for a message: `width` is the width the host asked the component to
 * render at, `customType` is the type the design was declared for, `theme` is the host's opaque theme
 * object, and `cardStyle` is the same resolved selection a tool design reads (S22).
 *
 * `render` is NOT optional here: Pi hands a message renderer its `{ expanded, outputPad }` options and
 * the message itself at construction, so there is no "context arrived late" state to model. An older
 * copy of the bridge knows no message designs at all, so a design never meets a context without it.
 */
export interface MessageDesignContext {
  readonly width: number;
  /** The custom type this design paints: one of its registration's `types`, or its `customType`. */
  readonly customType: string;
  readonly theme?: unknown;
  /** The style the user has selected, resolved live on access, exactly as for a tool design. */
  readonly cardStyle?: CardStyleSelection;
  readonly render: MessageDesignRender;
}

/**
 * The tool-design switch a message design FOLLOWS (S1, 0.12.0): while that line answers that design
 * id, this design is the one selected for its types; while it answers anything else (including the
 * host's own `native`), the message keeps the host's own output.
 *
 * It is a READ, never a write: nothing here produces a seed, a second switch or a value the user has
 * to pick twice, and the tool document is opened for reading only. It is answered live on every pass,
 * so flipping the tool switch repaints the messages already on screen and turns them off again.
 */
export interface MessageDesignFollow {
  /** The tool-design line whose switch decides this design, e.g. `"tags"`. */
  readonly line: string;
  /** The tool design id that must be selected on that line for this design to be active. */
  readonly id: string;
}

/**
 * What a follow answers right now, as `/bridge-status` and a plugin can read it.
 */
export interface MessageDesignFollowAnswer {
  /** The line the follow names. */
  readonly line: string;
  /** Whether a live tool-design line has that name at all. */
  readonly found: boolean;
  /** The design id that line answers right now, or `"none"` when there is no such line. */
  readonly answered: string;
  /** Whether `answered` is the id this follow waits for. */
  readonly active: boolean;
}

/**
 * A plugin's design for ONE custom message type, or for a line of several (S1).
 *
 * A custom message has no frame of the host's own to preserve: Pi draws a default box, or the
 * registering extension's renderer does. So a design works on ROWS, exactly like a tool design, and
 * what it receives says which case it is in:
 *
 * - the type HAS a host renderer: those rows, at the width Pi asked for, with the host's chrome
 *   already painted around them. The design returns the rows to draw and everything it does not
 *   deliberately change comes back byte for byte (S3);
 * - the type has NO host renderer (`gentle-pi.exploration-budget`, `gentle-pi.verifier-settle-reminder`,
 *   or any custom type nobody renders): the message's own body, plainly — its `[customType]` label, a
 *   blank row and its text — never a picture of Pi's styled box. The design owns the frame around a
 *   body it did not have to invent (S2), drawing from `ctx.render.message`, `ctx.width` and
 *   `ctx.cardStyle`, and those same rows are what a FAILING design falls back to, so a message the
 *   agent must read is never lost to a broken design.
 *
 * With NO design selected for a type the bridge does nothing at all: it never touches a message no
 * design claims (S4), so Pi's own output is byte-identical and no pass pays for the surface.
 */
export interface MessageDesignRegistration {
  /**
   * The custom type this design paints, for an UNGROUPED registration: it gets its own
   * `Message <type>` line. Exactly one of `customType` / (`line` + `types`) is required; mixing them
   * is refused.
   */
  customType?: string;
  /**
   * The line this design joins, for a GROUPED registration. Several registrations naming the same line
   * — from one plugin or two — join ONE `Message <line>` line, whose values are its designs in
   * registration order and whose type set is the union of their `types`.
   */
  line?: string;
  /**
   * The custom types a GROUPED design paints. Required with `line`, refused with `customType`.
   * Non-empty, deduplicated, each a non-empty string. A type belongs to at most ONE line: a second
   * claim on the same type — from another line, or from another ungrouped design — is refused whole and
   * reported, so no two switches can ever disagree about one message.
   */
  types?: readonly string[];
  /** Unique per line (or per type when ungrouped): the value the user selects and the key for replacement. */
  id: string;
  /** Optional display name for the plugin's INTEGRATIONS line; see `RowProvider.name`. */
  name?: string;
  /**
   * The tool-design switch this design follows instead of having a switch of its own (S1, 0.12.0).
   * A following design contributes NO value to the customize menu: the value the user already picked on
   * that tool line is what turns it on. Omit it for a design with its own `Message <line>` line, which
   * is what every 0.11.0 registration does.
   */
  follows?: MessageDesignFollow;
  /** The short text shown on the customize line as this design's value. */
  label: string;
  /** One line a preview can show about what the design does. */
  description?: string;
  /** Optional literal depiction of the design, drawn in the customize preview. */
  preview?(): RowPreview;
  /**
   * The rows the bridge hands the design in, and the rows it draws out. A design receives a COPY: one
   * that mutates its input cannot corrupt the rows the host still owns. A throw, or a return value that
   * is not an array of strings, leaves the host's own output on screen and is reported in
   * `/bridge-status`.
   */
  apply(lines: readonly string[], ctx: MessageDesignContext): string[];
}
