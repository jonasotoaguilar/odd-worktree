/**
 * Move the cursor, press Enter to apply (A1–A4, L4).
 *
 * The user's report: a line the bridge added changes its value the moment ←/→ touches it — the `›`
 * cursor and "Enter applies" never appear — while the host's own `Stats` line moves the cursor and
 * applies on Enter. The host's rule is PER ROW, not per line, so the fix is a row field:
 *
 * - `lib/visual-customize-view.ts:552-566` steps the cursor inside one setting line and runs
 *   `rows[next].action()` only while `rows[next].choice?.applyOnMove !== false`;
 * - `:409-417` lands a line on its current value, which is the cursor the user sees first;
 * - `:590-592` marks the focused non-current value with `›`, and `:35-38,751` prints
 *   `←/→ choose · Enter apply` for a focused line whose row defers.
 *
 * `KeyDriver` below is that rule, modelled once and driven over the REAL rows the bridge emits —
 * the `Sections` toggle, the card-style values in both modes (mixed with the host's own), and a
 * plugin provider's own rows (a fixture with the shape the worked example used to demonstrate).
 * It counts the actions it runs, so "a move applies
 * nothing" and "Enter applies exactly once" are observations, not assumptions.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BRIDGE_API_KEY, publishBridgeApi, resetBridgeApiForTests } from "../src/api.ts";
import { armBridge } from "../src/arm.ts";
import {
  registerCardStyle,
  registerRows,
  registerSection,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
} from "../src/bus.ts";
import { installCardStyleRows, resetCardStyleRowStateForTests } from "../src/card-style-rows.ts";
import { HOST_CARD_STYLE_SETTING } from "../src/card-style-line.ts";
import { getCardStyleSelection } from "../src/card-styles.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { getRepaintDiagnostics, resetRepaintForTests } from "../src/repaint.ts";
import { buildRows, resetRowBuildStateForTests } from "../src/rows.ts";
import { installSectionRows } from "../src/sections-rows.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CardStyleRegistration, CustomizeRow, InlineHelpers, RowContext, SidebarSection } from "../src/types.ts";
import { createFakeHost, type FakeRow } from "./fake-host.ts";

const inlineHelpers: InlineHelpers = {
  input: async () => undefined,
  confirm: async () => true,
  capture: async () => undefined,
};

const isVisible = (row: FakeRow): boolean => {
  if (row.visible === undefined) return true;
  try {
    return row.visible();
  } catch {
    return false; // the renderer fails closed
  }
};

interface KeyDriver {
  /** Focus one setting line: the host lands on the value that is current (`:409-417`). */
  focus: (setting: string) => { first: number; count: number; index: number };
  /** ←/→ inside the focused line: move the cursor, then apply ONLY if the row allows it (`:565`). */
  arrow: (direction: -1 | 1) => Promise<void>;
  /** Enter on the focused value: always applies (`:575-577`). */
  enter: () => Promise<void>;
  /** How many row actions the host has run so far. */
  actions: () => number;
  /** The row the cursor sits on. */
  focused: () => FakeRow;
  /** The line the host would draw right now (`:583-595`): `●` current, `›` the cursor. */
  line: () => string;
}

/**
 * The host's keyboard rule over whatever rows are live right now, taken row by row from
 * `lib/visual-customize-view.ts` — including the per-row deferral the bridge rows now carry.
 */
function keyDriver(rowsNow: () => FakeRow[]): KeyDriver {
  const rows = (): FakeRow[] => rowsNow().filter(isVisible);
  let setting: string | undefined;
  let index = 0;
  let actions = 0;

  const range = (name: string): { first: number; count: number } => {
    const all = rows();
    const first = all.findIndex((row) => row.choice?.setting === name);
    if (first < 0) throw new Error(`keyDriver: no setting line ${JSON.stringify(name)}`);
    let count = 1;
    while (first + count < all.length && all[first + count]?.choice?.setting === name) count += 1;
    return { first, count };
  };

  const run = async (row: FakeRow): Promise<void> => {
    actions += 1;
    await row.action?.(inlineHelpers);
  };

  return {
    focus(name) {
      const { first, count } = range(name);
      setting = name;
      index = first;
      const all = rows();
      for (let i = first; i < first + count; i += 1) {
        try {
          if (all[i]!.choice?.current() === true) {
            index = i;
            break;
          }
        } catch {
          // An unreadable value lands on the first choice, exactly as the host does.
        }
      }
      return { first, count, index };
    },
    async arrow(direction) {
      if (setting === undefined) throw new Error("keyDriver: focus a line first");
      const { first, count } = range(setting);
      const next = index + direction;
      // Stepping out of the value range does nothing; the host leaves the cursor where it is.
      if (next < first || next >= first + count) return;
      index = next;
      const row = rows()[next]!;
      // THE rule under test (`visual-customize-view.ts:565`): an explicit `false` defers to Enter.
      if (row.choice?.applyOnMove !== false) await run(row);
    },
    async enter() {
      if (setting === undefined) throw new Error("keyDriver: focus a line first");
      await run(rows()[index]!);
    },
    actions: () => actions,
    focused: () => rows()[index]!,
    line() {
      if (setting === undefined) throw new Error("keyDriver: focus a line first");
      const { first, count } = range(setting);
      const marks = rows()
        .slice(first, first + count)
        .map((row, offset) => {
          const current = row.choice?.current() === true;
          const cursor = !current && first + offset === index;
          return `${current ? "●" : cursor ? "›" : "○"} ${row.choice?.value ?? ""}`;
        });
      return `${setting} ${marks.join("  ")}`;
    },
  };
}

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-apply-on-move-"));
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
  delete (globalThis as unknown as Record<symbol, unknown>)[BRIDGE_API_KEY];
  resetBridgeApiForTests();
  resetBusForTests();
  resetSectionsForTests();
  resetCardStylesForTests();
  resetCardStyleRowStateForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetRepaintForTests();
  resetStoreStateForTests();
  disableCaptureBackend();
});

const ctx = (): RowContext => ({ theme: undefined, configHome });

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

const frame = () => ({
  top: (given: { width: number }) => "▛".repeat(given.width),
  line: (given: { text: string }) => given.text,
  bottom: (given: { width: number }) => "▙".repeat(given.width),
});

const style = (id: string, extra: Partial<CardStyleRegistration> = {}): CardStyleRegistration => ({
  id,
  label: id,
  frame: frame(),
  ...extra,
});

/** The host's own `Card style` row, shaped like `extensions/gentle-shell.ts:3405-3419`. */
const hostStyleRow = (value: "neon" | "float", actions: string[]): FakeRow => ({
  category: "Cards",
  label: () => `Card style: ${value}`,
  preview: () => ({ title: `Cards · ${value}`, sample: `${value} chrome + prompt` }),
  action: async () => {
    actions.push(value);
  },
  choice: { setting: HOST_CARD_STYLE_SETTING, value, current: () => value === "float" },
});

const rowsWithHostLine = (actions: string[]): FakeRow[] => [
  { category: "Cards", label: "Card bash: builtin", action: () => {} },
  { category: "Cards", label: "Card output: builtin", action: () => {} },
  { category: "Layout", label: "Layout: builtin", action: () => {} },
  hostStyleRow("neon", actions),
  hostStyleRow("float", actions),
];

const sectionStorePath = (): string => join(configHome, "gentle-shell-bridge", "bridge-sections.json");

const storedSections = (): unknown => {
  try {
    return JSON.parse(readFileSync(sectionStorePath(), "utf8"));
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------------------------
// The bridge's own `Sections` toggle
// ---------------------------------------------------------------------------------------------

test("the Sections toggle moves with ←/→ and applies only on Enter (A1, A4)", async () => {
  registerSection(section("loon.music", { title: "MUSIC" }));
  installSectionRows();
  const host = createFakeHost();
  armBridge(host.ui);
  host.buildMenu();

  const keys = keyDriver(host.liveRows);
  keys.focus("music");

  assert.equal(keys.focused().choice?.applyOnMove, false, "the toggle defers to Enter");

  await keys.arrow(1);

  assert.equal(keys.focused().choice?.value, "hidden", "the cursor moved to the other value");
  assert.equal(keys.actions(), 0, "moving applied nothing");
  assert.deepEqual(storedSections(), undefined, "and wrote no state");
  assert.equal(getRepaintDiagnostics().lastTrigger, undefined, "nor asked for a frame");
  assert.equal(keys.line(), "music ● shown  › hidden", "the cursor is drawn on the value Enter would apply");

  await keys.enter();

  assert.equal(keys.actions(), 1, "Enter applied the choice exactly once");
  assert.deepEqual(storedSections(), {
    schemaVersion: 1,
    values: { sections: { "loon.music": false } },
  });
  assert.equal(
    getRepaintDiagnostics().lastTrigger?.cause,
    'section "loon.music" → hidden',
    "and the rail repaint still happens on the write, not on the move",
  );
  assert.equal(keys.line(), "music ○ shown  ● hidden");
});

// ---------------------------------------------------------------------------------------------
// Card styles: the fallback line and the host's own line
// ---------------------------------------------------------------------------------------------

test("a registered card style defers to Enter on the fallback line (A1)", async () => {
  const host = createFakeHost();
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", { label: "cute" }));
  host.buildMenu();

  const keys = keyDriver(host.liveRows);
  keys.focus("Bridge card style");

  await keys.arrow(1);

  assert.equal(keys.focused().choice?.value, "cute", "the cursor moved onto the registered style");
  assert.equal(keys.actions(), 0, "moving applied nothing");
  assert.equal(getCardStyleSelection(), "native", "the stored selection is untouched");
  assert.equal(getRepaintDiagnostics().lastTrigger, undefined, "and no surface was repainted");
  assert.equal(keys.line(), "Bridge card style ● native  › cute");

  await keys.enter();

  assert.equal(keys.actions(), 1, "Enter applied exactly once");
  assert.equal(getCardStyleSelection(), "loon.cute");
  assert.equal(getRepaintDiagnostics().lastTrigger?.cause, "card style → loon.cute");
  assert.deepEqual(getRepaintDiagnostics().lastTrigger?.surfaces, ["conversation", "rail"]);
});

test("the fallback line's native value defers too (A1)", async () => {
  const host = createFakeHost();
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", { label: "cute" }));
  host.buildMenu();

  const keys = keyDriver(host.liveRows);
  keys.focus("Bridge card style");
  await keys.arrow(1);
  await keys.enter(); // select cute first, so native is no longer current
  assert.equal(getCardStyleSelection(), "loon.cute");
  const before = keys.actions();

  keys.focus("Bridge card style");
  await keys.arrow(-1);

  assert.equal(keys.focused().choice?.value, "native", "the cursor moved back to native");
  assert.equal(keys.actions(), before, "moving applied nothing");
  assert.equal(getCardStyleSelection(), "loon.cute", "cute is still selected");

  await keys.enter();
  assert.equal(keys.actions(), before + 1, "Enter applied exactly once");
  assert.equal(getCardStyleSelection(), "native");
});

test("on the host's line the host's values keep their own field and the bridge's value defers (A3)", async () => {
  const hostActions: string[] = [];
  const host = createFakeHost({ rows: rowsWithHostLine(hostActions) });
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", { label: "cute" }));
  host.buildMenu();

  const live = host.liveRows();
  const hostRows = live.filter((row) => row.choice?.setting === HOST_CARD_STYLE_SETTING);
  assert.equal(hostRows.length, 3, "neon, float and the spliced bridge value on ONE line");
  assert.equal(hostRows[0]?.choice?.applyOnMove, undefined, "the host's neon row is the host's");
  assert.equal(hostRows[1]?.choice?.applyOnMove, undefined, "and so is float");
  assert.equal(hostRows[2]?.choice?.applyOnMove, false, "the bridge's value defers to Enter");

  const keys = keyDriver(host.liveRows);
  keys.focus(HOST_CARD_STYLE_SETTING);

  // The host's own value applies on the move, exactly as before: the bridge did not rewrite it.
  await keys.arrow(-1);
  assert.deepEqual(hostActions, ["neon"], "the host's own action ran on the move");
  keys.focus(HOST_CARD_STYLE_SETTING);

  // The bridge's value on the SAME line only takes focus.
  await keys.arrow(1);
  await keys.arrow(1);
  assert.equal(keys.focused().choice?.value, "cute", "the cursor reached the bridge value");
  assert.equal(getCardStyleSelection(), "native", "moving onto it applied nothing");
  assert.deepEqual(hostActions, ["neon"], "and ran no host action either");

  await keys.enter();
  assert.equal(getCardStyleSelection(), "loon.cute", "Enter applied the bridge value");
});

// ---------------------------------------------------------------------------------------------
// A plugin's own provider rows (a fixture, not the worked example)
// ---------------------------------------------------------------------------------------------
//
// The example contributes a tool DESIGN now, and the bridge owns the design line: its rows are not a
// provider's, so the provider path is driven by a fixture with the same shape and the same rules.
// Nothing here is specific to bash; the values are just two choices on one line.

test("a plugin's provider rows move without applying and apply on Enter (A1, A2)", async () => {
  publishBridgeApi();
  let stored = "native";
  const values = ["native", "bash heading"];
  registerRows({
    id: "loon.apply-on-move",
    category: "Cards",
    name: "Loon example",
    rows: () =>
      values.map((value) => ({
        category: "Cards",
        label: "Bash design",
        choice: {
          setting: "Bash design",
          value,
          current: (): boolean => stored === value,
        },
        action: async (): Promise<void> => {
          stored = value;
        },
      })),
  });

  const rows = buildRows(ctx()).rows;
  const design = rows.filter((row) => row.choice?.setting === "Bash design");
  assert.deepEqual(
    design.map((row) => row.choice?.value),
    ["native", "bash heading"],
    "the provider's two values are on one line",
  );

  const keys = keyDriver(() => rows);
  keys.focus("Bash design");

  await keys.arrow(1);

  assert.equal(keys.focused().choice?.value, "bash heading", "the cursor moved onto the other value");
  assert.equal(keys.actions(), 0, "moving applied nothing");
  assert.equal(design[0]?.choice?.current(), true, "the stored value is still the first one");
  assert.equal(design[1]?.choice?.current(), false);
  assert.equal(keys.line(), "Bash design ● native  › bash heading");

  await keys.enter();

  assert.equal(keys.actions(), 1, "Enter applied exactly once");
  assert.equal(design[0]?.choice?.current(), false, "and the stored value became the other one");
  assert.equal(design[1]?.choice?.current(), true);
});

// ---------------------------------------------------------------------------------------------
// The build boundary: every provider choice defers, and the provider's objects are untouched
// ---------------------------------------------------------------------------------------------

test("the build defers every provider choice on a copy, never mutating the provider's row (A2)", () => {
  const authored: CustomizeRow = {
    category: "Cards",
    label: "Loon mode",
    choice: { setting: "Loon mode", value: "first", current: () => true },
    action: () => {},
  };
  const alreadyDeferring: CustomizeRow = {
    category: "Cards",
    label: "Loon other",
    choice: { setting: "Loon other", value: "one", current: () => true, applyOnMove: false },
    action: () => {},
  };
  const explicitImmediate: CustomizeRow = {
    category: "Cards",
    label: "Loon third",
    choice: { setting: "Loon third", value: "one", current: () => true, applyOnMove: true },
    action: () => {},
  };
  const plain: CustomizeRow = { category: "Cards", label: "Loon action", action: () => {} };
  registerRows({
    id: "test.apply-on-move",
    category: "Cards",
    rows: () => [authored, alreadyDeferring, explicitImmediate, plain],
  });

  const built = buildRows(ctx()).rows;

  assert.equal(built.length, 4, "no row was dropped");
  for (const row of built) {
    if (row.choice !== undefined) {
      assert.equal(row.choice.applyOnMove, false, `${String(row.choice.setting)} defers to Enter`);
    }
  }

  // The emitted copy is not the provider's row, and the provider's own objects are untouched.
  assert.notEqual(built[0], authored, "the row reached the host as a copy");
  assert.notEqual(built[0]?.choice, authored.choice, "and so did its choice");
  assert.equal(authored.choice?.applyOnMove, undefined, "the provider's choice was not mutated");
  assert.equal(built[0]?.label, authored.label, "every other field is carried as the same reference");
  assert.equal(built[0]?.action, authored.action);

  assert.equal(built[1], alreadyDeferring, "an authored false already conforms: no copy is needed");
  assert.equal(explicitImmediate.choice?.applyOnMove, true, "an authored true is not mutated either");
  assert.equal(built[2]?.choice?.applyOnMove, false, "but the emitted copy defers");
  // A row without a choice is a BUTTON row (S16). The bridge hands the host a copy so it can contain
  // a failing `action`; nothing else about it changes and the provider's object is never mutated.
  assert.notEqual(built[3], plain, "a button row is a copy, so its action can be contained (S16)");
  assert.equal(built[3]?.label, plain.label, "its label is carried as the same reference");
  assert.notEqual(built[3]?.action, plain.action, "its action is the contained wrapper");
  assert.equal(built[3]?.choice, undefined, "no choice is invented for a button");
  assert.deepEqual(Object.keys(plain).sort(), ["action", "category", "label"], "the provider's row is not mutated");
});

test("a placed provider's rows defer to Enter, and the host's Card style pair is never split", async () => {
  const hostActions: string[] = [];
  const host = createFakeHost({ rows: rowsWithHostLine(hostActions) });
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", { label: "cute" }));
  registerRows({
    id: "loon.top",
    category: "Cards",
    placement: "start",
    rows: () => [
      {
        category: "Cards",
        label: "Loon mode",
        choice: { setting: "Loon mode", value: "on", current: () => true },
        action: () => {},
      },
      {
        category: "Cards",
        label: "Loon mode",
        choice: { setting: "Loon mode", value: "off", current: () => false },
        action: () => {},
      },
    ],
  });
  host.buildMenu();

  const live = host.liveRows();
  const styleRows = live.filter((row) => row.choice?.setting === HOST_CARD_STYLE_SETTING);
  const styleIndices = live
    .map((row, index) => (row.choice?.setting === HOST_CARD_STYLE_SETTING ? index : -1))
    .filter((index) => index !== -1);
  assert.equal(styleRows.length, 3, "the host's neon/float pair still holds the bridge's value");
  assert.deepEqual(
    styleIndices,
    [styleIndices[0], (styleIndices[0] ?? 0) + 1, (styleIndices[0] ?? 0) + 2],
    "the pair plus the bridge value stay one consecutive line",
  );
  assert.deepEqual(
    styleRows.map((row) => row.choice?.value),
    ["neon", "float", "cute"],
    "and the bridge's value still lands inside its pair",
  );

  const keys = keyDriver(host.liveRows);
  keys.focus("Loon mode");
  await keys.arrow(1);
  assert.equal(keys.focused().choice?.value, "off", "the cursor moved inside the placed block");
  assert.equal(keys.actions(), 0, "moving applied nothing");
  assert.equal(keys.focused().choice?.applyOnMove, false, "a placed row still defers to Enter");
});
