/**
 * T33/T34 / S18: a provider's BRAND-NEW category reaches the user's menu.
 *
 * E8, verified against the host: the view derives its page list ONCE, in its constructor —
 * `this.categories = [...new Set(options.rows.map(row => row.category ?? "Settings"))]`
 * (`lib/visual-customize-view.ts:387`) — while `categoryRows()` filters `options.rows` live on every
 * read (`:391-393`). A row that joins an EXISTING page therefore appears even when it is pushed
 * after the view exists; a row that names a NEW page cannot, because nothing can select a page the
 * list does not hold.
 *
 * The bridge appends the providers' rows BEFORE the constructor's `map` reads the array, and only
 * for an array PROVEN to be the menu's rows (`src/capture.ts`): the host's own mapper must derive
 * `category ?? "Settings"` for the array's own elements AND for two synthetic rows the host never
 * had — one with no category, one naming a page that cannot exist — and it must not throw. The
 * same mapper is also run over the rows to append BEFORE they are pushed (S20).
 *
 * That early step is PROVISIONAL (S20): it is a guess made before the factory finished, so it is
 * reconciled against the late decision at the end of the factory, and rolled back on a throw, on
 * another array, on ambiguity or on an async factory. The net guarantee this suite pins: after any
 * factory invocation, no array holds bridge rows except the one the late decision chose.
 *
 * Through the real entry (`publishBridgeApi().registerRows`, `armBridge`) and a view that computes
 * its pages in its constructor exactly like the host's, this suite proves:
 *
 * - the new page appears once, AFTER the host's own pages and never before them;
 * - its toggle and its button rows are in it, in the provider's order;
 * - two providers in the same new page share one page;
 * - a provider in an existing page still joins it (no regression);
 * - `Keymaps` is still refused and never creates a page;
 * - an incidental row-shaped array in the same factory is never written to;
 * - nested capture does not steal the outer menu's page, and an inner rollback never touches it;
 * - a host that invokes its factory in a later microtask still gets its page;
 * - calling the factory twice does not duplicate rows or pages;
 * - `/bridge-status` reports the injection exactly as before;
 * - JD-A-001..005, the five defects the adversarial review found in the early step, each stay dead.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishBridgeApi, resetBridgeApiForTests } from "../src/api.ts";
import { armBridge } from "../src/arm.ts";
import {
  registerCardStyle,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  resetTransformsForTests,
} from "../src/bus.ts";
import { resetCardStyleRowStateForTests } from "../src/card-style-rows.ts";
import { HOST_CARD_STYLE_SETTING } from "../src/card-style-line.ts";
import { disableCaptureBackend, getCaptureDiagnostics, resetCaptureStateForTests } from "../src/capture.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import {
  getRowNameRejections,
  resetRowNameRejectionsForTests,
  RESERVED_CATEGORY_RULE,
} from "../src/row-names.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CardStyleRegistration, CustomizeRow, RowLabel } from "../src/types.ts";

const labelText = (label: RowLabel | undefined): string => {
  if (typeof label === "function") return label();
  return label ?? "";
};

const visible = (row: CustomizeRow): boolean => {
  if (row.visible === undefined) return true;
  try {
    return row.visible();
  } catch {
    return false; // the host's renderer fails closed
  }
};

/**
 * "Byte-identical", in the only sense that matters here: the same row objects, in the same order,
 * with nothing added and nothing removed. `assert.deepEqual` would accept a rebuild that happens to
 * look alike, which is exactly the trace a rollback must not leave.
 */
const sameRows = (rows: readonly CustomizeRow[], before: readonly CustomizeRow[]): boolean =>
  rows.length === before.length && rows.every((row, index) => row === before[index]);

/** The bridge's own rows wherever they are, by the label the provider gave them. */
const bridgeLabels = (rows: readonly CustomizeRow[]): string[] =>
  rows.map((row) => labelText(row.label)).filter((label) => label.startsWith("Loon"));

/** Rows an incidental array can hold: row-shaped, above the capture threshold, no provider identity. */
const incidentalRows = (prefix: string, category: string): CustomizeRow[] => [
  { category, label: `${prefix} one`, action: () => {} },
  { category, label: `${prefix} two`, action: () => {} },
  { category, label: `${prefix} three`, action: () => {} },
];

/** A registered card style, as little as the splice needs (`src/card-style-rows.ts:376-390`). */
const cardStyle = (id: string): CardStyleRegistration => ({
  id,
  label: id,
  frame: {
    top: (ctx: { width: number }) => "▛".repeat(ctx.width),
    line: (ctx: { text: string }) => ctx.text,
    bottom: (ctx: { width: number }) => "▙".repeat(ctx.width),
  },
});

/** The host's own `Card style` line, shaped like `extensions/gentle-shell.ts:3405-3419`. */
const hostStyleRow = (value: "neon" | "float"): CustomizeRow => ({
  category: "Cards",
  label: () => `Card style: ${value}`,
  action: () => {},
  choice: { setting: HOST_CARD_STYLE_SETTING, value, current: () => value === "neon" },
});

/** The host's menu with its own `Card style` line inside `Cards`, so a splice can be observed. */
const rowsWithHostLine = (): CustomizeRow[] => [
  { category: "Cards", label: "Card bash: builtin", action: () => {} },
  { category: "Cards", label: "Card output: builtin", action: () => {} },
  hostStyleRow("neon"),
  hostStyleRow("float"),
  { category: "Layout", label: "Layout: builtin", action: () => {} },
];

/**
 * The host's view, reduced to the two lines the feature depends on — transcribed, not approximated:
 * `lib/visual-customize-view.ts:387` (pages derived once, in the constructor) and `:391-393` (a
 * page's rows filtered from the live array on every read). The view itself is private to the host
 * (`extensions/gentle-shell.ts:3550-3561` returns an adapter), so the harness below is the only one
 * allowed to read it.
 */
class HostCustomizeView {
  private readonly categories: string[];
  readonly pane: "categories" | "controls";
  private readonly options: { rows: CustomizeRow[] };

  constructor(options: {
    rows: CustomizeRow[];
    /**
     * The host's ONE page derivation, replaceable so a test can give it an observable side effect
     * (an impure mapper, JD-A-003) without pretending the host has a different shape. The default
     * is the transcribed line above.
     */
    deriveCategories?: (rows: CustomizeRow[]) => string[];
  }) {
    this.options = options;
    const derive = options.deriveCategories;
    this.categories =
      derive !== undefined
        ? derive(options.rows)
        : [...new Set(options.rows.map((row) => row.category ?? "Settings"))];
    this.pane = options.rows.some((row) => row.category) ? "categories" : "controls";
  }

  /** What the CATEGORIES pane lists (`:527` reads `this.categories.length`). */
  pages(): string[] {
    return [...this.categories];
  }

  /** One page's visible rows, as the controls pane draws them (`:391-393`). */
  rowsOf(page: string): CustomizeRow[] {
    return this.options.rows.filter(
      (row) => (row.category ?? "Settings") === page && visible(row),
    );
  }
}

/** The host's own pages: four rows over three of them, above the capture threshold. */
const hostRows = (): CustomizeRow[] => [
  { category: "Cards", label: "Card bash: builtin", action: () => {} },
  { category: "Cards", label: "Card output: builtin", action: () => {} },
  { category: "Banner", label: "Banner: builtin", action: () => {} },
  { category: "Layout", label: "Layout: builtin", action: () => {} },
];

const THEME = {
  fg: (_color: string, text: string): string => text,
  bg: (_color: string, text: string): string => text,
};

type HostFactory = (ui: unknown, theme: unknown, ...rest: unknown[]) => unknown;

interface MenuHostOptions {
  rows?: CustomizeRow[];
  /** A row-shaped array the factory maps BEFORE the menu, as a host helper might. */
  incidental?: CustomizeRow[];
  /** A nested `custom` call the factory makes and abandons, as a provider's own UI work could. */
  nested?: CustomizeRow[];
  /** Resolve the factory in a later microtask, like `Promise.resolve().then(factory)`. */
  deferred?: boolean;
  /** Extra work the factory does BEFORE it builds its view, in the host's own order. */
  preBuild?: (rows: CustomizeRow[]) => void;
  /** Extra work the factory does AFTER it built its view — the last thing before it returns. */
  postBuild?: () => void;
  /** The factory's own result is a promise, while the view was built synchronously (JD-A-005). */
  factoryPromise?: boolean;
  /** The host's page derivation, so a test can count or throw on the host's own mapper. */
  deriveCategories?: (rows: CustomizeRow[]) => string[];
}

interface MenuHost {
  ui: { custom: (factory: HostFactory, ...rest: unknown[]) => unknown };
  build: () => unknown;
  view: () => HostCustomizeView;
  liveRows: () => CustomizeRow[];
  invalidateCount: () => number;
}

/** `extensions/gentle-shell.ts:3550-3562`: the view is built inside the factory, which returns an adapter. */
function createMenuHost(options: MenuHostOptions = {}): MenuHost {
  const rows = options.rows ?? hostRows();
  let view: HostCustomizeView | undefined;
  let invalidations = 0;

  const build = (): unknown => {
    view = new HostCustomizeView({ rows, ...(options.deriveCategories === undefined ? {} : { deriveCategories: options.deriveCategories }) });
    return {
      render: (): string[] => view?.pages() ?? [],
      handleInput: (): void => {},
      invalidate: (): void => {
        invalidations += 1;
      },
      dispose: (): void => {},
    };
  };

  const ui = {
    custom(inner: HostFactory, ..._rest: unknown[]): unknown {
      if (options.deferred === true) {
        return Promise.resolve().then(() => inner(ui, THEME, { keybindings: "fake" }, () => {}));
      }
      return inner(ui, THEME, { keybindings: "fake" }, () => {});
    },
  };

  const factory: HostFactory = () => {
    if (options.incidental !== undefined) options.incidental.map((row) => row.label);
    if (options.nested !== undefined) {
      const nested = options.nested;
      try {
        ui.custom(() => {
          nested.map((row) => row.label);
          throw new Error("nested factory exploded");
        });
      } catch {
        // the host survives a nested failure and finishes its own menu
      }
    }
    options.preBuild?.(rows);
    const built = build();
    options.postBuild?.();
    return options.factoryPromise === true ? Promise.resolve(built) : built;
  };

  return {
    ui,
    build: () => ui.custom(factory),
    view: () => {
      assert.ok(view !== undefined, "the host built no view");
      return view;
    },
    liveRows: () => rows,
    invalidateCount: () => invalidations,
  };
}

/** The real entry: arm the bridge on a host-shaped `ctx.ui`, then ask the host to build its menu. */
const menuHost = (options: MenuHostOptions = {}): MenuHost => {
  const host = createMenuHost(options);
  armBridge(host.ui);
  return host;
};

/** A toggle row: consecutive rows sharing one `choice.setting` are one line in the host. */
const toggles = (setting: string, label: string, values: [string, string]): CustomizeRow[] =>
  values.map((value) => ({
    label,
    choice: { setting, value, current: () => value === values[0] },
    action: () => {},
  }));

/** A button row: `action` and no `choice`, the host's own `Reset`/`Profiles` shape. */
const button = (label: string): CustomizeRow => ({ label, action: () => {} });

/** The page the example contributes in the live TUI (L6: a new category with a toggle and a button). */
const loonPage = (): CustomizeRow[] => [
  ...toggles("Loon heading", "Loon heading", ["default", "tool"]),
  button("Loon repaint"),
];

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-new-category-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetBridgeApiForTests();
  resetBusForTests();
  resetSectionsForTests();
  resetCardStylesForTests();
  resetCardStyleRowStateForTests();
  resetTransformsForTests();
  resetRowNameRejectionsForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetNoticesForTests();
  resetStoreStateForTests();
  disableCaptureBackend();
});

// ---------------------------------------------------------------------------------------------
// The page exists, once, after the host's own pages
// ---------------------------------------------------------------------------------------------

test("a provider's new page appears once, after the host's own pages and never before them", () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });

  const host = menuHost();
  host.build();

  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Banner", "Layout", "Loon page"],
    "the host's three pages come first, then the provider's own page exactly once",
  );
  assert.equal(host.view().pane, "categories", "a menu of pages is still the categories pane");
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, { kind: "injected", injectedRows: 3 });
  assert.equal(host.invalidateCount(), 1, "the adapter is invalidated once, as before");
});

test("S21: a provider can place its own page after another category's block", () => {
  // The page list is the FIRST appearance of each category in the rows the host maps, so the block
  // has to be inserted there, not appended: `Sections` is one of the host's pages, and the provider
  // asks to open its page right after it.
  publishBridgeApi().registerRows({
    id: "loon.page",
    category: "Loon page",
    rows: loonPage,
    categoryPlacement: { after: "Cards" },
  });

  const host = menuHost();
  host.build();

  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Loon page", "Banner", "Layout"],
    "the provider's page sits between the anchor page and the one that followed it",
  );
});

test("S21: an anchor the menu does not have falls back to the end, as before", () => {
  publishBridgeApi().registerRows({
    id: "loon.page",
    category: "Loon page",
    rows: loonPage,
    categoryPlacement: { after: "No such page" },
  });

  const host = menuHost();
  host.build();

  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Banner", "Layout", "Loon page"],
    "an unhonourable anchor leaves the pre-feature order, and the page still exists",
  );
});

test("S21: only the rows of the page being placed move, never the whole block", () => {
  // A block's rows may each declare their own category (`src/rows.ts:326-338`). Moving the block
  // would drag the first appearance of the OTHER page to the anchor as well.
  publishBridgeApi().registerRows({
    id: "loon.split",
    category: "Loon page",
    categoryPlacement: { after: "Cards" },
    rows: () => [
      ...toggles("Loon heading", "Loon heading", ["default", "tool"]),
      button("Loon repaint"),
      { label: "Loon stray", category: "Loon other" } as CustomizeRow,
    ],
  });

  const host = menuHost();
  host.build();

  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Loon page", "Banner", "Layout", "Loon other"],
    "the placed page moves; the block's other page keeps the pre-feature tail order",
  );
});

test("S21: a rollback still removes a page placed in the MIDDLE of the host's rows", async () => {
  // The rollback primitive is tail-shaped, so a mid-array insert has to record what it wrote: with
  // `Cards` as the anchor the insertion index is not `original.length`, and a tail-shaped removal
  // would leave the bridge rows behind (and could remove host rows instead).
  publishBridgeApi().registerRows({
    id: "loon.page",
    category: "Loon page",
    rows: loonPage,
    categoryPlacement: { after: "Cards" },
  });

  const twin: CustomizeRow[] = incidentalRows("Twin", "Cards");
  const host = menuHost({ preBuild: () => void twin.map((row) => row.category ?? "Settings") });
  const before = [...host.liveRows()];
  host.build();

  assert.deepEqual(
    getCaptureDiagnostics().lastOutcome,
    { kind: "uncaptured", injectedRows: 0, reason: "ambiguous" },
    "the late decision disagrees with the early guess",
  );
  assert.deepEqual(bridgeLabels(host.liveRows()), [], "no bridge row survives the rollback");
  assert.ok(sameRows(host.liveRows(), before), "the host's own rows are exactly as they were");
});

test("the new page holds its toggle and its button, in the provider's order", () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });

  const host = menuHost();
  host.build();
  const rows = host.view().rowsOf("Loon page");

  assert.deepEqual(
    rows.map((row) => labelText(row.label)),
    ["Loon heading", "Loon heading", "Loon repaint"],
    "the toggle's two values and then the button, in the order the provider gave",
  );
  assert.deepEqual(
    rows.map((row) => row.choice?.value ?? "button"),
    ["default", "tool", "button"],
    "the first two are the one setting's values; the last carries no choice at all",
  );
  assert.deepEqual(
    rows.map((row) => row.category),
    ["Loon page", "Loon page", "Loon page"],
    "the page's own name is on every row the view filters by",
  );
  assert.equal("choice" in rows[2]!, false, "and a button never gains one");
});

// ---------------------------------------------------------------------------------------------
// Two providers, one page / an existing page unchanged
// ---------------------------------------------------------------------------------------------

test("two providers naming the same new page share it, in registration order", () => {
  publishBridgeApi().registerRows({
    id: "loon.first",
    category: "Loon page",
    rows: () => [button("Loon alpha")],
  });
  publishBridgeApi().registerRows({
    id: "loon.second",
    category: "Loon page",
    rows: () => [button("Loon beta")],
  });

  const host = menuHost();
  host.build();

  assert.deepEqual(
    host.view().pages().filter((page) => page === "Loon page"),
    ["Loon page"],
    "one page, not one per provider",
  );
  assert.deepEqual(
    host.view().rowsOf("Loon page").map((row) => labelText(row.label)),
    ["Loon alpha", "Loon beta"],
    "both providers' rows land in it, in the order they registered",
  );
});

test("a provider in an existing page still joins it and adds no page (PRESERVE)", () => {
  publishBridgeApi().registerRows({
    id: "loon.cards",
    category: "Cards",
    rows: () => [button("Loon card")],
  });

  const host = menuHost();
  host.build();

  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Banner", "Layout"],
    "the page list is unchanged by a provider that joins an existing page",
  );
  assert.deepEqual(
    host.view().rowsOf("Cards").map((row) => labelText(row.label)),
    ["Card bash: builtin", "Card output: builtin", "Loon card"],
    "and its row is appended to that page, after the host's own rows",
  );
});

test("a single ROW naming a new page creates it, with the provider's own page untouched", () => {
  publishBridgeApi().registerRows({
    id: "loon.row-page",
    category: "Cards",
    rows: () => [
      button("Loon card"),
      { category: "Loon page", label: "Loon alpha", action: () => {} },
    ],
  });

  const host = menuHost();
  host.build();

  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Banner", "Layout", "Loon page"],
    "the row's OWN category is a page, exactly like a provider's category",
  );
  assert.deepEqual(
    host.view().rowsOf("Loon page").map((row) => labelText(row.label)),
    ["Loon alpha"],
    "and only that row is in it",
  );
  assert.deepEqual(
    host.view().rowsOf("Cards").map((row) => labelText(row.label)),
    ["Card bash: builtin", "Card output: builtin", "Loon card"],
    "the sibling without its own category stays on the provider's page",
  );
});

// ---------------------------------------------------------------------------------------------
// Keymaps is still closed to plugins
// ---------------------------------------------------------------------------------------------

test("Keymaps is refused at registration and per row, and never becomes a page", () => {
  const api = publishBridgeApi();
  assert.throws(
    () => api.registerRows({ id: "loon.keymaps", category: "Keymaps", rows: () => [] }),
    new RegExp(`reserved category "Keymaps"`),
    "a provider standing in Keymaps is refused",
  );

  api.registerRows({
    id: "loon.mixed",
    category: "Cards",
    rows: () => [
      { category: "Keymaps", label: "Loon bind", action: () => {} },
      button("Loon kept"),
    ],
  });

  const host = menuHost();
  host.build();

  assert.equal(
    host.view().pages().includes("Keymaps"),
    false,
    "no key-capture page is created for a plugin",
  );
  assert.deepEqual(
    host.liveRows().filter((row) => row.category === "Keymaps"),
    [],
    "and no row is left behind on it",
  );
  assert.deepEqual(
    host.view().rowsOf("Cards").map((row) => labelText(row.label)),
    ["Card bash: builtin", "Card output: builtin", "Loon kept"],
    "the row's siblings still reach their own page",
  );
  assert.deepEqual(
    getRowNameRejections().map((rejection) => [rejection.field, rejection.value, rejection.rule]),
    [["category", "Keymaps", "reserved category"]],
    `the refusal is reported, with the rule ${JSON.stringify(RESERVED_CATEGORY_RULE)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// The qualification: an incidental row-shaped array is never written to
// ---------------------------------------------------------------------------------------------

test("an incidental row-shaped array in the same factory is not injected into, and the page still appears", () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });
  const incidental: CustomizeRow[] = [
    { category: "Cards", label: "Incidental one", action: () => {} },
    { category: "Cards", label: "Incidental two", action: () => {} },
    { category: "Banner", label: "Incidental three", action: () => {} },
  ];

  const host = menuHost({ incidental });
  host.build();

  assert.deepEqual(
    incidental.map((row) => labelText(row.label)),
    ["Incidental one", "Incidental two", "Incidental three"],
    "an array mapped to its labels fails the page-derivation proof and is left byte-identical",
  );
  assert.ok(
    host.view().pages().includes("Loon page"),
    "the menu array itself was proven, so its page appears",
  );
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, { kind: "injected", injectedRows: 3 });
});

// ---------------------------------------------------------------------------------------------
// Nested capture still cannot steal the outer menu
// ---------------------------------------------------------------------------------------------

test("a nested custom call that throws does not steal the outer menu's page", () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });
  const nested: CustomizeRow[] = [
    { category: "Cards", label: "Nested one", action: () => {} },
    { category: "Cards", label: "Nested two", action: () => {} },
    { category: "Cards", label: "Nested three", action: () => {} },
  ];

  const host = menuHost({ nested });
  host.build();

  assert.deepEqual(
    nested.map((row) => labelText(row.label)),
    ["Nested one", "Nested two", "Nested three"],
    "the nested session that threw resolves nothing, so its array receives nothing",
  );
  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Banner", "Layout", "Loon page"],
    "the outer menu keeps its own capture and its new page",
  );
  assert.equal(
    host.view().rowsOf("Loon page").length,
    3,
    "and receives the rows exactly once",
  );
});

// ---------------------------------------------------------------------------------------------
// A deferred host still captures
// ---------------------------------------------------------------------------------------------

test("a host that invokes the factory in a later microtask still gets its page", async () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });

  const host = menuHost({ deferred: true });
  await host.build();

  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Banner", "Layout", "Loon page"],
    "the probe brackets the factory invocation, so the microtask is covered",
  );
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, { kind: "injected", injectedRows: 3 });
});

// ---------------------------------------------------------------------------------------------
// Building the same menu twice
// ---------------------------------------------------------------------------------------------

test("calling the factory twice neither duplicates the page nor its rows", () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });

  const host = menuHost();
  host.build();
  const afterFirst = host.view().pages();
  host.build();

  assert.deepEqual(afterFirst, ["Cards", "Banner", "Layout", "Loon page"]);
  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Banner", "Layout", "Loon page"],
    "the second build sees the same list, not a second page",
  );
  assert.deepEqual(
    host.view().rowsOf("Loon page").map((row) => labelText(row.label)),
    ["Loon heading", "Loon heading", "Loon repaint"],
    "and the same three rows",
  );
  assert.equal(host.invalidateCount(), 1, "the array's marker keeps the injection to one");
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, {
    kind: "already-injected",
    injectedRows: 0,
  });
});

// ---------------------------------------------------------------------------------------------
// /bridge-status still tells the truth about the capture
// ---------------------------------------------------------------------------------------------

test("/bridge-status reports the injection that delivered the page", () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });

  const host = menuHost();
  host.build();
  const lines = formatStatus(collectStatus());

  assert.ok(lines.includes("backend: capture"), "the capture backend is the active one");
  assert.ok(
    lines.includes("last capture: injected 3 rows"),
    "the outcome is the one that put the page in, not a second build",
  );

  host.build();
  assert.ok(
    formatStatus(collectStatus()).includes("last capture: already injected"),
    "a rebuild is reported as already injected, exactly as before",
  );
});

// ---------------------------------------------------------------------------------------------
// S20 / JD-A-001..005: the early step is PROVISIONAL and is reconciled with the late decision
// ---------------------------------------------------------------------------------------------

// JD-A-001: the first proof accepted any array whose mapper echoed its own categories, so an
// incidental array mapped with `row => row.category` (or with a constant equal to every row's
// category) received the rows, blocked the real menu behind `session.injected`, and diagnostics
// still said `injected`.
test("JD-A-001: an incidental array mapped to its categories, or to a constant, is left alone and blocks nothing", () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });

  const echo: CustomizeRow[] = incidentalRows("Echo", "Cards");
  const constant: CustomizeRow[] = incidentalRows("Constant", "Cards");
  const echoBefore = [...echo];
  const constantBefore = [...constant];

  const host = menuHost({
    preBuild: () => {
      echo.map((row) => row.category); // `row => row.category`
      constant.map(() => "Cards"); // a constant equal to every row's category
    },
  });
  host.build();

  assert.ok(
    sameRows(echo, echoBefore),
    "an array echoing its own categories never passes the synthetic rows' proof, so it stays byte-identical",
  );
  assert.ok(
    sameRows(constant, constantBefore),
    "and neither does an array mapped to a constant, however well it fits those rows",
  );
  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Banner", "Layout", "Loon page"],
    "the real menu still receives the rows, so its page exists",
  );
  assert.equal(
    host.view().rowsOf("Loon page").length,
    3,
    "and holds them once: nothing was left in the incidental arrays",
  );
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, { kind: "injected", injectedRows: 3 });
});

// JD-A-002: the array was recorded on the FIRST map call and never proved again, so mapping the
// menu's rows to labels first and to categories later lost the page.
test("JD-A-002: the page still appears when the menu's rows are mapped to labels before their categories", () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });

  const host = menuHost({ preBuild: (rows) => void rows.map((row) => row.label) });
  host.build();

  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Banner", "Layout", "Loon page"],
    "the later category map is proved on its own, not blocked by the earlier label map",
  );
  assert.equal(host.view().rowsOf("Loon page").length, 3, "and the page holds the provider's rows once");
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, { kind: "injected", injectedRows: 3 });
});

// JD-A-003 (first half): the proof ran the mapper of whatever row-like array it met, so an impure
// mapper ran extra times with nothing bounding the cost. Every bridge row the mapper must now read
// is read exactly twice: once by the pre-push check, once by the host's own map.
test("JD-A-003: an impure mapper reads each bridge row exactly twice, once before it is pushed", () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });

  const calls = { all: 0, bridge: 0 };
  const host = menuHost({
    deriveCategories: (rows) =>
      [
        ...new Set(
          rows.map((row) => {
            calls.all += 1;
            if (labelText(row.label).startsWith("Loon")) calls.bridge += 1;
            return row.category ?? "Settings";
          }),
        ),
      ],
  });
  host.build();

  assert.deepEqual(host.view().pages(), ["Cards", "Banner", "Layout", "Loon page"]);
  assert.equal(
    calls.bridge,
    6,
    "three bridge rows, read twice each: once by the pre-push check, once by the host's own map",
  );
  assert.equal(
    calls.all,
    16,
    "four host rows proved, two synthetic proof rows, three rows checked before the push, " +
      "seven rows mapped by the host — and nothing beyond that (JD-A-003: the cost is bounded)",
  );
});

// JD-A-003 (second half): the proof ran the mapper over host rows only, so a mapper that throws on
// a bridge row broke the factory AFTER the rows had been appended.
test("JD-A-003: a mapper that throws on a bridge row never meets one, so the factory survives", () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });

  const host = menuHost({
    deriveCategories: (rows) =>
      [
        ...new Set(
          rows.map((row) => {
            if (labelText(row.label).startsWith("Loon")) throw new Error("bridge row exploded");
            return row.category ?? "Settings";
          }),
        ),
      ],
  });

  assert.doesNotThrow(() => host.build(), "the host's own map never reads a row it cannot read");
  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Banner", "Layout"],
    "no page is claimed: the host's mapper cannot read a bridge row, so the proof fails and the page list is the host's own",
  );
  assert.deepEqual(
    host.liveRows().map((row) => labelText(row.label)),
    [
      "Card bash: builtin",
      "Card output: builtin",
      "Banner: builtin",
      "Layout: builtin",
      "Loon heading",
      "Loon heading",
      "Loon repaint",
    ],
    "the rows still arrive through the late path, after the page list was fixed",
  );
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, { kind: "injected", injectedRows: 3 });
});

// JD-A-004: the early injection mutated the array before the factory returned, so a factory that
// mapped categories and then threw left its rows and its marker behind.
test("JD-A-004: a factory that maps categories and then throws leaves the array exactly as it was", () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });

  const host = menuHost({
    postBuild: () => {
      throw new Error("factory exploded after the map");
    },
  });
  const before = [...host.liveRows()];

  assert.throws(() => host.build(), /factory exploded after the map/);
  assert.ok(sameRows(host.liveRows(), before), "the host's own rows, in the host's own order, and nothing else");
  assert.deepEqual(
    Object.getOwnPropertySymbols(host.liveRows()),
    [],
    "no injection marker is left, so a later build may still inject once",
  );
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, {
    kind: "uncaptured",
    injectedRows: 0,
    reason: "factory-threw",
  });
});

// JD-A-005: an async factory built its view synchronously, received the early rows, and was then
// reported `uncaptured (async-factory)` with the rows still in the array.
test("JD-A-005: a factory that returns a promise keeps nothing and reports the previous outcome", async () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });

  const host = menuHost({ factoryPromise: true });
  const before = [...host.liveRows()];

  const result = host.build();
  assert.ok(result instanceof Promise, "the promise is returned unchanged");
  await result;

  assert.ok(
    sameRows(host.liveRows(), before),
    "the early rows went with the guess: no late decision ran, so nothing may stay injected",
  );
  assert.deepEqual(Object.getOwnPropertySymbols(host.liveRows()), [], "and the marker went with them");
  assert.equal(host.invalidateCount(), 0, "nothing was injected, so nothing was invalidated");
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, {
    kind: "uncaptured",
    injectedRows: 0,
    reason: "async-factory",
  });
});

// ---------------------------------------------------------------------------------------------
// The net guarantee: after any factory invocation, only the chosen array holds bridge rows
// ---------------------------------------------------------------------------------------------

test("the net guarantee: a rollback leaves no bridge row and no marker anywhere", async () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });

  // (a) the factory throws after the guess injected
  const incidentalThrow: CustomizeRow[] = incidentalRows("Throw", "Cards");
  const throwing = menuHost({
    preBuild: () => void incidentalThrow.map((row) => row.label),
    postBuild: () => {
      throw new Error("factory exploded after the map");
    },
  });
  const throwingBefore = [...throwing.liveRows()];
  assert.throws(() => throwing.build(), /factory exploded after the map/);
  assert.deepEqual(bridgeLabels(throwing.liveRows()), [], "a throw leaves the host's array free of bridge rows");
  assert.deepEqual(bridgeLabels(incidentalThrow), [], "and the incidental array was never touched");
  assert.ok(sameRows(throwing.liveRows(), throwingBefore));

  // (b) the factory returns a promise: no late decision will ever run
  const incidentalAsync: CustomizeRow[] = incidentalRows("Async", "Cards");
  const asyncHost = menuHost({
    preBuild: () => void incidentalAsync.map((row) => row.label),
    factoryPromise: true,
  });
  const asyncBefore = [...asyncHost.liveRows()];
  await asyncHost.build();
  assert.deepEqual(bridgeLabels(asyncHost.liveRows()), [], "an async factory keeps nothing either");
  assert.deepEqual(bridgeLabels(incidentalAsync), []);
  assert.ok(sameRows(asyncHost.liveRows(), asyncBefore));

  // (c) the late decision is ambiguous: two arrays proved to be the menu's rows
  const twin: CustomizeRow[] = incidentalRows("Twin", "Cards");
  const twinBefore = [...twin];
  const ambiguous = menuHost({ preBuild: () => void twin.map((row) => row.category ?? "Settings") });
  const ambiguousBefore = [...ambiguous.liveRows()];
  ambiguous.build();
  assert.deepEqual(
    getCaptureDiagnostics().lastOutcome,
    { kind: "uncaptured", injectedRows: 0, reason: "ambiguous" },
    "two arrays that both prove themselves are ambiguous, exactly like two row-like arrays",
  );
  assert.deepEqual(bridgeLabels(ambiguous.liveRows()), [], "so neither of them keeps a bridge row");
  assert.deepEqual(bridgeLabels(twin), []);
  assert.ok(sameRows(twin, twinBefore));
  assert.ok(sameRows(ambiguous.liveRows(), ambiguousBefore));

  // (d) the chosen array is the ONLY one that holds them, and the incidental one beside it is free
  const incidentalChosen: CustomizeRow[] = incidentalRows("Chosen", "Cards");
  const chosen = menuHost({ preBuild: () => void incidentalChosen.map((row) => row.label) });
  chosen.build();
  assert.deepEqual(bridgeLabels(chosen.liveRows()), ["Loon heading", "Loon heading", "Loon repaint"]);
  assert.deepEqual(bridgeLabels(incidentalChosen), []);
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, { kind: "injected", injectedRows: 3 });
});

// S1 / PRESERVE: the card style line is a ROW the bridge writes into the array it guessed, so a
// rollback has to put the host's own rows — and only those — back.
test("a rolled-back guess gives the host's own Card style rows back untouched (PRESERVE)", async () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });
  registerCardStyle(cardStyle("loon.cute"));

  const midBuild: string[][] = [];
  const host = menuHost({
    rows: rowsWithHostLine(),
    factoryPromise: true,
    // Observed INSIDE the factory, while the guess is live: this is the splice the rollback must undo.
    postBuild: () => {
      midBuild.push(host.liveRows().map((row) => String(row.choice?.value ?? "")));
    },
  });
  const before = [...host.liveRows()];

  await host.build();

  assert.ok(
    midBuild[0]?.includes("loon.cute") === true,
    "the provisional step did splice the registered value into the host's line",
  );
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, {
    kind: "uncaptured",
    injectedRows: 0,
    reason: "async-factory",
  });
  assert.ok(
    sameRows(host.liveRows(), before),
    "the host's own rows come back by identity, its own Card style rows included",
  );
  assert.deepEqual(
    host.liveRows().filter((row) => row.choice?.value === "loon.cute"),
    [],
    "the value the provisional splice inserted went with the guess",
  );
});

// S20: "including for nested sessions: an inner factory's rollback must never touch the outer
// session's array."
test("a nested session's rollback never touches the outer session's rows", () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });

  const inner: CustomizeRow[] = incidentalRows("Inner", "Cards");
  const innerBefore = [...inner];
  const host = menuHost({
    postBuild: () => {
      try {
        // A nested menu that proves itself, receives the rows, and then throws: its own rollback
        // runs in the inner factory's `finally`.
        host.ui.custom(() => {
          inner.map((row) => row.category ?? "Settings");
          throw new Error("nested exploded after its map");
        });
      } catch {
        // the host survives a nested failure and finishes its own menu
      }
    },
  });

  host.build();

  assert.ok(sameRows(inner, innerBefore), "the nested session's array received nothing, permanently");
  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Banner", "Layout", "Loon page"],
    "and the outer menu keeps the page its own guess earned",
  );
  assert.equal(host.view().rowsOf("Loon page").length, 3, "with the rows exactly once");
  assert.equal(
    bridgeLabels(host.liveRows()).length,
    3,
    "the nested rollback removed the inner rows without touching the outer ones",
  );
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, { kind: "injected", injectedRows: 3 });
});

// E10: found by the parent after the second review round. The rollback ran inside the `finally`
// BEFORE the session stack was popped and `Array.prototype.map` was restored, and nothing guarded it.
// A host that freezes its rows after the view was built and then throws made the rollback itself
// throw: the host's own error was replaced by a TypeError and the patched `map` stayed installed for
// the whole process, which is exactly what that `finally` exists to prevent.
test("E10: a rollback that cannot touch a frozen array never masks the host's error nor leaks the map patch", () => {
  publishBridgeApi().registerRows({ id: "loon.page", category: "Loon page", rows: loonPage });
  const nativeMap = Array.prototype.map;
  const rows = [...hostRows()];
  const host = menuHost({
    rows,
    postBuild: () => {
      Object.freeze(rows);
      throw new Error("host exploded after freezing its rows");
    },
  });

  assert.throws(() => host.build(), /host exploded after freezing its rows/, "the host's own error is the one that surfaces");
  assert.equal(Array.prototype.map, nativeMap, "Array.prototype.map is the native one again");
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, {
    kind: "uncaptured",
    injectedRows: 0,
    reason: "factory-threw",
  });
});

// ---------------------------------------------------------------------------------------------
// Row placement (S4, S5, S6): a new page still exists, and a placed block still rolls back
// ---------------------------------------------------------------------------------------------

test("a start placement on a page the host did not build is appended with a reason, and the page still appears", () => {
  publishBridgeApi().registerRows({
    id: "loon.placed-page",
    category: "Loon page",
    placement: "start",
    rows: loonPage,
  });

  const host = menuHost();
  host.build();

  assert.deepEqual(
    host.view().pages(),
    ["Cards", "Banner", "Layout", "Loon page"],
    "the page is still discovered before the host reads new Set(...), after the host's own pages",
  );
  assert.equal(host.view().rowsOf("Loon page").length, 3, "and holds the provider's rows once");

  const lines = formatStatus(collectStatus());
  assert.ok(
    lines.some((line) =>
      /^  - loon\.placed-page \(Loon page\), placement start → end \(the host did not build the category "Loon page"/u.test(
        line,
      ),
    ),
    lines.join("\n"),
  );
});

test("a rollback takes back a placed block and the Card style splice together, exactly", async () => {
  publishBridgeApi().registerRows({
    id: "loon.top",
    category: "Cards",
    placement: "start",
    rows: () => [button("Loon top")],
  });
  registerCardStyle(cardStyle("loon.cute"));

  const midBuild: string[][] = [];
  const host = menuHost({
    rows: rowsWithHostLine(),
    factoryPromise: true,
    postBuild: () => {
      midBuild.push(host.liveRows().map((row) => String(row.choice?.value ?? row.label ?? "")));
    },
  });
  const before = [...host.liveRows()];

  await host.build();

  assert.ok(
    midBuild[0]?.includes("Loon top") === true,
    "the provisional step did place the provider's block while the guess was live",
  );
  assert.ok(
    midBuild[0]?.includes("loon.cute") === true,
    "and it did splice the registered card style into the host's line",
  );
  assert.ok(
    sameRows(host.liveRows(), before),
    "the host's own rows come back by identity, in the host's own order",
  );
  assert.equal(host.liveRows().length, before.length, "same length");
  assert.deepEqual(
    host.liveRows().filter((row) => row.label === "Loon top"),
    [],
    "no placed block was left behind",
  );
  assert.deepEqual(
    host.liveRows().filter((row) => row.choice?.value === "loon.cute"),
    [],
    "and the Card style value went with the guess",
  );
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, {
    kind: "uncaptured",
    injectedRows: 0,
    reason: "async-factory",
  });
});
