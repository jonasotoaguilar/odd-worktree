/**
 * The `Card style` line (S1, S12): the host's own line, extended in place, with a separate-line
 * fallback that is reported rather than silent.
 *
 * These tests drive the REAL capture path (`armBridge` on the fake host), because the whole point
 * of the design is that the bridge does not add a second line: it splices the host's rows out of
 * the captured array and puts them back at the same index, immediately followed by one row per
 * registered style, so the host coalesces them into one line. What a test asserts is what the
 * renderer draws (`fakeHost.toggleLines()`), plus the live row objects themselves.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { armBridge } from "../src/arm.ts";
import {
  registerCardStyle,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  snapshotProviders,
} from "../src/bus.ts";
import {
  CARD_STYLE_FALLBACK_SETTING,
  CARD_STYLE_ROWS_PROVIDER_ID,
  CARD_STYLE_ROW_LABEL,
  cardStyleRowMode,
  extendCardStyleLine,
  installCardStyleRows,
  resetCardStyleRowStateForTests,
} from "../src/card-style-rows.ts";
import { HOST_CARD_STYLE_SETTING } from "../src/card-style-line.ts";
import { CARD_STYLE_STORE_ID, getCardStyleSelection, setCardStyleSelection } from "../src/card-styles.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { snapshotNotices, resetNoticesForTests } from "../src/notices.ts";
import { collectStatus } from "../src/status.ts";
import { transformCardLines } from "../src/card-style-transform.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CardStyleRegistration, RowProvider } from "../src/types.ts";
import { createFakeHost, type FakeRow } from "./fake-host.ts";
import { READ_CARD } from "./fake-transcript.ts";

/** The host's own state: which native card style its config file holds. */
let hostStyle: "neon" | "float";
let hostActions: string[];

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-card-line-"));
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
  resetBusForTests();
  resetSectionsForTests();
  resetCardStylesForTests();
  resetCardStyleRowStateForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetStoreStateForTests();
  disableCaptureBackend();
  hostStyle = "float";
  hostActions = [];
});

const frame = () => ({
  top: (ctx: { width: number }) => "▛".repeat(ctx.width),
  line: (ctx: { text: string }) => ctx.text,
  bottom: (ctx: { width: number }) => "▙".repeat(ctx.width),
});

const style = (id: string, extra: Partial<CardStyleRegistration> = {}): CardStyleRegistration => ({
  id,
  label: id,
  frame: frame(),
  ...extra,
});

/** The host's own `Card style` row, shaped like `extensions/gentle-shell.ts:3405-3419`. */
const hostStyleRow = (value: "neon" | "float", action?: () => Promise<void>): FakeRow => ({
  category: "Cards",
  label: () => `Card style: ${value}`,
  preview: () => ({ title: `Cards · ${value}`, sample: `${value} chrome + prompt` }),
  action:
    action ??
    (async () => {
      hostStyle = value;
      hostActions.push(value);
    }),
  choice: {
    setting: HOST_CARD_STYLE_SETTING,
    value,
    current: () => hostStyle === value,
    hint: "How conversation cards are drawn",
  },
});

/** The host's menu, with its own `Card style` line inside `Cards`. */
const rowsWithHostLine = (floatAction?: () => Promise<void>): FakeRow[] => [
  { category: "Cards", label: "Card bash: builtin", action: () => {} },
  { category: "Cards", label: "Card output: builtin", action: () => {} },
  {
    category: "Cards",
    label: "Card content: default",
    action: () => {},
    choice: { setting: "Card content", value: "default", current: () => true },
  },
  hostStyleRow("neon"),
  hostStyleRow("float", floatAction),
  { category: "Layout", label: "Layout: builtin", action: () => {} },
];

/** The same menu WITHOUT the host's line: the fallback path (a renamed setting, a narrower host). */
const rowsWithoutHostLine = (): FakeRow[] => [
  { category: "Cards", label: "Card bash: builtin", action: () => {} },
  { category: "Cards", label: "Card output: builtin", action: () => {} },
  { category: "Layout", label: "Layout: builtin", action: () => {} },
];

const settingLines = (lines: readonly string[], setting: string): string[] =>
  lines.filter((line) => line.startsWith(`${setting} `));

// ---------------------------------------------------------------------------------------------
// Extended mode: the host's line grows, in the host's position
// ---------------------------------------------------------------------------------------------

test("capture extends the host's own Card style line instead of adding a second one", () => {
  const host = createFakeHost({ rows: rowsWithHostLine() });
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", { label: "cute" }));

  host.buildMenu();

  assert.equal(cardStyleRowMode(), "extended");
  assert.deepEqual(settingLines(host.toggleLines(), HOST_CARD_STYLE_SETTING), [
    "Card style ○ neon ● float ○ cute",
  ]);
  assert.deepEqual(
    settingLines(host.toggleLines(), CARD_STYLE_FALLBACK_SETTING),
    [],
    "no second line was contributed",
  );
});

test("the host's rows stay at their index; only their current() is wrapped (S13)", () => {
  const rows = rowsWithHostLine();
  const [neonRow, floatRow] = [rows[3] as FakeRow, rows[4] as FakeRow];
  const host = createFakeHost({ rows });
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", { label: "cute" }));

  host.buildMenu();

  const live = host.liveRows();
  const wrapped = live[3] as FakeRow;
  assert.notEqual(wrapped, neonRow, "a shallow clone, because current() must answer differently");
  assert.equal(live[4] === floatRow, false, "both host rows are wrapped, not just the first");

  // Presentation and identity are the host's own; only the two behaviour hooks are wrapped.
  for (const field of ["label", "preview", "category", "keyhint", "visible"] as const) {
    assert.equal(wrapped[field], neonRow[field], `${field} is the host's own`);
  }
  const before = neonRow.choice!;
  const after = wrapped.choice!;
  for (const field of ["setting", "value", "hint", "applyOnMove"] as const) {
    assert.equal(after[field], before[field], `choice.${field} is untouched`);
  }
  assert.notEqual(after.current, before.current, "current() is wrapped (S13)");
  assert.equal(after.current(), before.current(), "and it delegates while no bridge style is selected");
  assert.notEqual(wrapped.action, neonRow.action, "action() is wrapped: pressing a host value exits (S13)");

  assert.equal(live[5]?.choice?.value, "cute", "the registered value follows immediately");
  assert.deepEqual(
    live.filter((row) => row.category === "Cards").map((row) => row.choice?.setting ?? "—"),
    ["—", "—", "Card content", HOST_CARD_STYLE_SETTING, HOST_CARD_STYLE_SETTING, HOST_CARD_STYLE_SETTING],
    "the line stays where the host put it, after Card content",
  );
});

test("while a bridge style is selected the host's own values are NOT current (S13)", async () => {
  const host = createFakeHost({ rows: rowsWithHostLine() });
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", { label: "cute" }));
  host.buildMenu();

  assert.deepEqual(settingLines(host.toggleLines(), HOST_CARD_STYLE_SETTING), [
    "Card style ○ neon ● float ○ cute",
  ], "native: the host's own answer, delegated, and no bridge value is current");

  await host.pressRow(
    (row) => row.choice?.setting === HOST_CARD_STYLE_SETTING && row.choice?.value === "cute",
  );

  assert.deepEqual(settingLines(host.toggleLines(), HOST_CARD_STYLE_SETTING), [
    "Card style ○ neon ○ float ● cute",
  ], "one current value, and it is the bridge's");

  // Pressing a host value IS the way back (S13): the host's own action runs, and the wrapped action
  // clears the bridge selection, so the host renders again.
  await host.press("Card style: float");
  assert.equal(hostActions.at(-1), "float", "the host's setter ran");
  assert.equal(getCardStyleSelection(), "native", "and the bridge selection is native again");
  assert.deepEqual(settingLines(host.toggleLines(), HOST_CARD_STYLE_SETTING), [
    "Card style ○ neon ● float ○ cute",
  ], "exactly one bullet, on the host's value");

  const nextFrame = [...READ_CARD];
  assert.equal(
    transformCardLines(nextFrame, 40),
    nextFrame,
    "and the next frame is not transformed: the user is back to the host's rendering",
  );
});

test("a stale selection lets the host's own values speak again (S12, S13)", () => {
  const dispose = registerCardStyle(style("loon.cute", { label: "cute" }));
  const host = createFakeHost({ rows: rowsWithHostLine() });
  armBridge(host.ui);
  installCardStyleRows();
  setCardStyleSelection("loon.cute");
  host.buildMenu();
  assert.match(settingLines(host.toggleLines(), HOST_CARD_STYLE_SETTING)[0] ?? "", /● cute$/u);

  dispose();
  const reopened = createFakeHost({ rows: rowsWithHostLine() });
  resetCaptureStateForTests();
  armBridge(reopened.ui);
  reopened.buildMenu();

  assert.deepEqual(settingLines(reopened.toggleLines(), HOST_CARD_STYLE_SETTING), [
    "Card style ○ neon ● float",
  ], "the selection names a style nobody owns: native behaviour, no dead bullet");
});

test("a throwing host action still returns to native and never throws out of the menu (S13)", async () => {
  const host = createFakeHost({
    rows: rowsWithHostLine(async () => {
      throw new Error("host setter exploded");
    }),
  });
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", { label: "cute" }));
  host.buildMenu();
  await host.pressRow(
    (row) => row.choice?.setting === HOST_CARD_STYLE_SETTING && row.choice?.value === "cute",
  );
  assert.equal(getCardStyleSelection(), "loon.cute");

  await assert.doesNotReject(async () => host.press("Card style: float"), "the menu keeps working");

  assert.equal(
    getCardStyleSelection(),
    "native",
    "a failed host action must not leave the user trapped in a bridge style",
  );
  const noticed = snapshotNotices().entries.map((entry) => entry.message).join("\n");
  assert.match(noticed, /host setter exploded/u, "and the failure is recorded, not swallowed silently");
});

test("pressing a native value calls the host's own action; a registered value is the bridge's", async () => {
  const host = createFakeHost({ rows: rowsWithHostLine() });
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", { label: "cute" }));
  host.buildMenu();

  await host.press("Card style: neon");
  assert.deepEqual(hostActions, ["neon"], "the host's setter ran; the bridge did not replace it");
  assert.equal(getCardStyleSelection(), "native", "and the bridge store was not touched");

  await host.pressRow(
    (row) => row.choice?.setting === HOST_CARD_STYLE_SETTING && row.choice?.value === "cute",
  );
  assert.equal(getCardStyleSelection(), "loon.cute", "the bridge persisted first");
  assert.deepEqual(hostActions, ["neon"], "and the host's own setter never ran for our value");
  const file = join(configHome, "gentle-shell-bridge", `${CARD_STYLE_STORE_ID}.json`);
  assert.equal(
    (JSON.parse(readFileSync(file, "utf8")) as { values: Record<string, string> }).values.cardStyle,
    "loon.cute",
  );
  assert.deepEqual(settingLines(host.toggleLines(), HOST_CARD_STYLE_SETTING), [
    "Card style ○ neon ○ float ● cute",
  ], "the bridge's value is the only current one (S13)");
});

test("three plugins, three styles, one line, deterministic order", () => {
  const host = createFakeHost({ rows: rowsWithHostLine() });
  armBridge(host.ui);
  installCardStyleRows();
  // Three independent plugins registering in an arbitrary order; `order` decides among two of them.
  registerCardStyle(style("loon.loud", { label: "loud", order: 20 }));
  registerCardStyle(style("pix.mono", { label: "mono", order: 10 }));
  registerCardStyle(style("zephyr.wave", { label: "wave" }));

  host.buildMenu();

  assert.deepEqual(settingLines(host.toggleLines(), HOST_CARD_STYLE_SETTING), [
    "Card style ○ neon ● float ○ mono ○ loud ○ wave",
  ]);
});

test("nothing capped or hidden: the row carries every registered value", () => {
  const host = createFakeHost({ rows: rowsWithHostLine() });
  armBridge(host.ui);
  installCardStyleRows();
  const registered = Array.from({ length: 12 }, (_, index) => `plugin.${index}`);
  for (const id of registered) registerCardStyle(style(id));

  host.buildMenu();

  const values = host
    .liveRows()
    .filter((row) => row.choice?.setting === HOST_CARD_STYLE_SETTING)
    .map((row) => row.choice?.value);
  assert.deepEqual(values, ["neon", "float", ...registered]);
});

test("with no style registered the host's line is left exactly as it was", () => {
  const host = createFakeHost({ rows: rowsWithHostLine() });
  armBridge(host.ui);
  installCardStyleRows();

  host.buildMenu();

  assert.equal(cardStyleRowMode(), "extended");
  assert.deepEqual(settingLines(host.toggleLines(), HOST_CARD_STYLE_SETTING), [
    "Card style ○ neon ● float",
  ]);
  assert.equal(host.liveRows().length, 6, "not a row more");
});

test("a registered value previews literally, and a throwing preview cannot break the menu", () => {
  const host = createFakeHost({ rows: rowsWithHostLine() });
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(
    style("loon.cute", {
      label: "cute",
      preview: () => ({ title: "Cute", sample: "╭─ ✿ cute ─╮" }),
    }),
  );
  registerCardStyle(
    style("loon.broken", {
      label: "broken",
      preview: () => {
        throw new Error("preview exploded");
      },
    }),
  );
  host.buildMenu();

  const live = host.liveRows();
  const cute = live.find((row) => row.choice?.value === "cute");
  const broken = live.find((row) => row.choice?.value === "broken");

  assert.deepEqual(cute?.preview?.(), { title: "Cute", sample: "╭─ ✿ cute ─╮" });
  const fallback = broken?.preview?.();
  assert.equal(fallback?.title, "Cards · broken");
  assert.match(fallback?.sample ?? "", /broken/u, "the literal fallback names the style");
});

test("a disposed style leaves the line and its row, and the rest keep working (S12)", () => {
  const host = createFakeHost({ rows: rowsWithHostLine() });
  armBridge(host.ui);
  installCardStyleRows();
  const dispose = registerCardStyle(style("loon.cute", { label: "cute" }));
  registerCardStyle(style("pix.mono", { label: "mono" }));
  host.buildMenu();
  assert.match(settingLines(host.toggleLines(), HOST_CARD_STYLE_SETTING)[0] ?? "", /cute/u);

  dispose();
  // The host rebuilds its rows array on every menu open (that is why the splice runs per capture);
  // a fresh fake host is the honest model of "the next open".
  const reopened = createFakeHost({ rows: rowsWithHostLine() });
  resetCaptureStateForTests();
  armBridge(reopened.ui);
  reopened.buildMenu();

  assert.deepEqual(settingLines(reopened.toggleLines(), HOST_CARD_STYLE_SETTING), [
    "Card style ○ neon ● float ○ mono",
  ]);
});

// ---------------------------------------------------------------------------------------------
// Fallback: one separate line, reported
// ---------------------------------------------------------------------------------------------

test("without a host line the bridge contributes its own line: native plus every style", () => {
  const host = createFakeHost({ rows: rowsWithoutHostLine() });
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", { label: "cute" }));

  host.buildMenu();

  assert.equal(cardStyleRowMode(), "separate");
  assert.deepEqual(settingLines(host.toggleLines(), CARD_STYLE_FALLBACK_SETTING), [
    "Bridge card style ● native ○ cute",
  ]);
  assert.deepEqual(settingLines(host.toggleLines(), HOST_CARD_STYLE_SETTING), []);
});

test("the fallback setting and label never collide with the host's own Card style", () => {
  const host = createFakeHost({ rows: rowsWithoutHostLine() });
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", { label: "cute" }));
  host.buildMenu();

  const rows = host.liveRows().filter((row) => row.choice?.setting === CARD_STYLE_FALLBACK_SETTING);
  assert.equal(rows.length, 2);
  assert.notEqual(CARD_STYLE_FALLBACK_SETTING, HOST_CARD_STYLE_SETTING);
  const labels = rows.map((row) => (typeof row.label === "function" ? row.label() : row.label));
  assert.deepEqual(labels, [CARD_STYLE_ROW_LABEL, "cute"], "the line's name, then the style's own");
  for (const row of rows) {
    assert.equal(row.category, "Cards");
    assert.equal((labels.find((label) => label?.startsWith("Card style")) ?? undefined), undefined);
  }
});

test("in fallback mode native is the default and pressing it persists 'native'", async () => {
  const host = createFakeHost({ rows: rowsWithoutHostLine() });
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", { label: "cute" }));
  host.buildMenu();
  assert.deepEqual(settingLines(host.toggleLines(), CARD_STYLE_FALLBACK_SETTING), [
    "Bridge card style ● native ○ cute",
  ]);

  await host.pressRow(
    (row) => row.choice?.setting === CARD_STYLE_FALLBACK_SETTING && row.choice?.value === "cute",
  );
  assert.equal(getCardStyleSelection(), "loon.cute");
  await host.pressRow(
    (row) => row.choice?.setting === CARD_STYLE_FALLBACK_SETTING && row.choice?.value === "native",
  );
  assert.equal(getCardStyleSelection(), "native");
});

test("neither mode is reported as a duplicate setting by /bridge-status", () => {
  const host = createFakeHost({ rows: rowsWithHostLine() });
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", { label: "cute" }));
  host.buildMenu();
  assert.deepEqual(collectStatus().duplicates, [], "extended: one line, one contributor");

  const fallbackHost = createFakeHost({ rows: rowsWithoutHostLine() });
  resetCaptureStateForTests();
  resetRowBuildStateForTests();
  armBridge(fallbackHost.ui);
  fallbackHost.buildMenu();
  assert.deepEqual(collectStatus().duplicates, [], "separate: our own line, one contributor");
});

test("an array that cannot be spliced degrades to the fallback instead of throwing", () => {
  registerCardStyle(style("loon.cute", { label: "cute" }));
  installCardStyleRows();
  const rows = Object.freeze(rowsWithHostLine()) as FakeRow[];

  assert.equal(extendCardStyleLine(rows), "separate", "the outcome says which line the user got");
  assert.deepEqual(
    rows.filter((row) => row.choice?.setting === HOST_CARD_STYLE_SETTING).map((row) => row.choice?.value),
    ["neon", "float"],
    "and the host's own rows were left exactly where they were",
  );
  assert.equal(getCardStyleSelection(), "native");
});

// ---------------------------------------------------------------------------------------------
// Which provider exists
// ---------------------------------------------------------------------------------------------

test("the fallback provider is registered only while the separate line is what the user sees", () => {
  const host = createFakeHost({ rows: rowsWithHostLine() });
  armBridge(host.ui);
  installCardStyleRows();
  const providerIds = (): string[] =>
    snapshotProviders()
      .map((provider: RowProvider) => provider.id)
      .filter((id) => id === CARD_STYLE_ROWS_PROVIDER_ID);

  assert.deepEqual(providerIds(), [CARD_STYLE_ROWS_PROVIDER_ID], "wired, before any capture");
  host.buildMenu();
  assert.deepEqual(providerIds(), [], "the host line won: our separate line is gone");

  extendCardStyleLine(rowsWithoutHostLine());
  assert.deepEqual(providerIds(), [CARD_STYLE_ROWS_PROVIDER_ID], "and comes back with it");
});
