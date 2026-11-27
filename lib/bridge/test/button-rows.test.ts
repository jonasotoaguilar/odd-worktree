/**
 * T27 / S16: a BUTTON row is a first-class kind, not an accident of a missing field.
 *
 * The host's row type (`lib/visual-customize-view.ts:107-130`) makes `choice` optional and
 * `action(inline)` required, and Enter/Space runs `action` (`:575-577`) exactly as it does for the
 * host's own `Profiles` and `Reset` rows (`extensions/gentle-shell.ts:3541,3550`). So a row with
 * `category`, `label`, `action` and NO `choice` is the second supported kind, and this suite pins
 * everything about it through the real entry (`publishBridgeApi().registerRows`) and the real
 * capture path:
 *
 * - it is accepted, reaches the host's array with its category untouched, and renders as its own
 *   row — never a value of another row's setting;
 * - `preview`, `keyhint`, `visible` and a function-valued `label` are reference-identical, so the
 *   bridge passes them through instead of re-deriving them;
 * - its label is the WHOLE visible text of the row, so the bridge's plain-word row-name rule applies
 *   to it exactly as it applies to a toggle's label: a mark, or more than three words, is refused
 *   and reported verbatim, and the row is absent rather than rewritten;
 * - `confirmOnEnter` never touches it: no `choice` appears, no `applyOnMove` is injected, and the
 *   provider's own object is not mutated;
 * - a throwing (or rejecting) `action` is contained by the bridge and reported ONCE through the
 *   notice channel that `/bridge-status` lists, so the menu and every other row stay usable;
 * - a provider may mix toggles and buttons in one category, and the order it gave is kept.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishBridgeApi, resetBridgeApiForTests } from "../src/api.ts";
import { armBridge } from "../src/arm.ts";
import {
  registerRows,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  resetTransformsForTests,
} from "../src/bus.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests, snapshotNotices } from "../src/notices.ts";
import { getRowNameRejections, resetRowNameRejectionsForTests } from "../src/row-names.ts";
import { getLastRowBuild, resetRowBuildStateForTests } from "../src/rows.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CustomizeRow, RowLabel } from "../src/types.ts";
import { createFakeHost, type FakeHost } from "./fake-host.ts";

const MARK_RULE =
  "a row name is one to three plain words with no arrow, colon, dot, pipe, slash or bracket";
const WORD_RULE = "a row name is one to three plain words";

const labelText = (label: RowLabel | undefined): string => {
  if (typeof label === "function") return label();
  return label ?? "";
};

const loonLabels = (host: FakeHost): string[] =>
  host
    .liveRows()
    .map((row) => labelText(row.label))
    .filter((label) => label.startsWith("Loon"));

const rowsOfLastBuild = (providerId: string): CustomizeRow[] =>
  getLastRowBuild()?.find((record) => record.providerId === providerId)?.rows ?? [];

/** The one visible row a provider contributed, as the host holds it right now. */
const liveRow = (host: FakeHost, label: string): CustomizeRow => {
  const row = host.liveRows().find((candidate) => labelText(candidate.label) === label);
  assert.ok(row !== undefined, `the host holds no row labelled ${JSON.stringify(label)}`);
  return row;
};

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-button-rows-"));
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
  resetTransformsForTests();
  resetRowNameRejectionsForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetNoticesForTests();
  resetStoreStateForTests();
  disableCaptureBackend();
});

const menuHost = (): FakeHost => {
  const host = createFakeHost();
  armBridge(host.ui);
  return host;
};

/** A toggle line: consecutive rows sharing one `choice.setting`, the existing kind. */
const toggles = (setting: string, label: string, values: [string, string]): CustomizeRow[] =>
  values.map((value) => ({
    category: "Cards",
    label,
    choice: { setting, value, current: () => value === values[0] },
    action: () => {},
  }));

// ---------------------------------------------------------------------------------------------
// Accepted, rendered, and never a value of somebody else's setting
// ---------------------------------------------------------------------------------------------

test("a button row is accepted in an existing category and Enter runs its action once", async () => {
  const calls: string[] = [];
  publishBridgeApi().registerRows({
    id: "loon.buttons",
    category: "Cards",
    rows: () => [
      ...toggles("Bash rendering", "Bash rendering", ["default", "tool"]),
      { category: "Cards", label: "Loon refresh", action: () => void calls.push("refresh") },
    ],
  });

  const host = menuHost();
  host.buildMenu();

  assert.ok(host.categories().includes("Cards"), "an existing category is reused");
  assert.deepEqual(loonLabels(host), ["Loon refresh"], "the row is drawn as its own line");
  assert.deepEqual(
    host.toggleLines(),
    ["Bash rendering ● default ○ tool"],
    "and it is not a value of the toggle line it sits after",
  );

  const row = liveRow(host, "Loon refresh");
  assert.equal(row.choice, undefined, "a button carries no choice");
  assert.equal("choice" in row, false, "and no choice is invented for it");

  await host.press("Loon refresh");
  assert.deepEqual(calls, ["refresh"], "Enter (or Space) runs the action exactly once");
});

test("a button row in a new category keeps that category untouched", () => {
  publishBridgeApi().registerRows({
    id: "loon.buttons",
    category: "Loon",
    rows: () => [{ label: "Loon refresh", action: () => {} }],
  });

  const host = menuHost();
  host.buildMenu();

  const row = liveRow(host, "Loon refresh");
  assert.equal(row.category, "Loon", "the provider's own category name is not rewritten");
  assert.ok(
    host.liveRows().some((candidate) => candidate.category === "Loon"),
    "the row is in the array the host derives its categories from (visual-customize-view.ts:387)",
  );
  // Fixed by S18: the bridge appends the providers' rows BEFORE the view's constructor runs
  // `options.rows.map(...)` (`visual-customize-view.ts:387`), so the page the row names exists to be
  // selected. A late push — after the factory returned — could only join a page the list already
  // held, which is why a brand-new category was invisible before (E8).
  assert.equal(
    host.categories().includes("Loon"),
    true,
    "the new page is in the category list the view computed",
  );
});

// ---------------------------------------------------------------------------------------------
// Pass-through: nothing is re-derived
// ---------------------------------------------------------------------------------------------

test("preview, keyhint, visible and a function label pass through untouched", () => {
  const preview = () => ({ title: "Loon · refresh", sample: "redraws the rail" });
  const visible = () => true;
  const label = () => "Loon refresh";
  const action = () => {};
  publishBridgeApi().registerRows({
    id: "loon.buttons",
    category: "Cards",
    rows: () => [{ category: "Cards", label, preview, keyhint: "Enter refresh · Esc close", visible, action }],
  });

  const host = menuHost();
  host.buildMenu();
  const row = liveRow(host, "Loon refresh");

  assert.equal(row.label, label, "a function label is handed over as the same function");
  assert.equal(row.preview, preview, "preview is the provider's function");
  assert.equal(row.keyhint, "Enter refresh · Esc close", "keyhint is verbatim");
  assert.equal(row.visible, visible, "visible is the provider's function");
  assert.deepEqual(row.preview?.(), { title: "Loon · refresh", sample: "redraws the rail" });
  assert.equal(row.visible?.(), true);
  assert.notEqual(row.action, action, "the action is the ONE thing the bridge wraps (see below)");
  assert.deepEqual(
    Object.keys(row).sort(),
    ["action", "category", "keyhint", "label", "preview", "visible"],
    "no field is added, dropped or renamed on the way through",
  );
});

// ---------------------------------------------------------------------------------------------
// The label is the row's whole visible text, so the row-name rule applies to it unchanged
// ---------------------------------------------------------------------------------------------

test("a button label with a structural mark is refused and reported, and its siblings stay", () => {
  publishBridgeApi().registerRows({
    id: "loon.buttons",
    category: "Cards",
    rows: () => [
      { category: "Cards", label: "Loon: refresh", action: () => {} },
      { category: "Cards", label: "Loon refresh the rail now", action: () => {} },
      { category: "Cards", label: () => "Loon: functional label", action: () => {} },
      { category: "Cards", label: "Loon refresh", action: () => {} },
    ],
  });

  const host = menuHost();
  host.buildMenu();

  assert.deepEqual(loonLabels(host), ["Loon refresh"], "only the conforming row reaches the menu");
  assert.deepEqual(
    getRowNameRejections(),
    [
      {
        surface: "rows",
        id: "loon.buttons",
        field: "row label",
        value: "Loon: refresh",
        rule: "mark",
        reason: `it contains ":"; ${MARK_RULE}`,
      },
      {
        surface: "rows",
        id: "loon.buttons",
        field: "row label",
        value: "Loon refresh the rail now",
        rule: "words",
        reason: `it has 5 words; ${WORD_RULE}`,
      },
      {
        surface: "rows",
        id: "loon.buttons",
        field: "row label",
        value: "Loon: functional label",
        rule: "mark",
        reason: `it contains ":"; ${MARK_RULE}`,
      },
    ],
    "the same rule as a toggle's label, and a function label is evaluated to check it",
  );
  assert.deepEqual(
    rowsOfLastBuild("loon.buttons").map((row) => labelText(row.label)),
    ["Loon refresh"],
    "the refused rows are absent from the effective set, not merely hidden",
  );
});

// ---------------------------------------------------------------------------------------------
// confirmOnEnter leaves a button row alone
// ---------------------------------------------------------------------------------------------

test("a button row keeps no choice and no applyOnMove, and the provider's object is not mutated", () => {
  const providerRow: CustomizeRow = { category: "Cards", label: "Loon refresh", action: () => {} };
  const toggleRow: CustomizeRow = {
    category: "Cards",
    label: "Loon rendering",
    choice: { setting: "Loon rendering", value: "on", current: () => true },
    action: () => {},
  };
  publishBridgeApi().registerRows({
    id: "loon.buttons",
    category: "Cards",
    rows: () => [providerRow, toggleRow],
  });

  const host = menuHost();
  host.buildMenu();

  assert.deepEqual(
    Object.keys(providerRow).sort(),
    ["action", "category", "label"],
    "the bridge never writes to the row the provider keeps",
  );
  const row = liveRow(host, "Loon refresh");
  assert.equal("choice" in row, false);
  assert.equal("applyOnMove" in row, false);

  // PRESERVE: the existing kind is unchanged — a choice row still defers its value to Enter.
  const toggle = liveRow(host, "Loon rendering");
  assert.equal(toggle.choice?.applyOnMove, false);
  assert.equal(toggle.action, toggleRow.action, "and its action is handed over untouched");
});

// ---------------------------------------------------------------------------------------------
// A failing action is contained and reported once
// ---------------------------------------------------------------------------------------------

const failureNotice = (label: string, message: string): string =>
  `gentle-shell-bridge: the button row ${JSON.stringify(label)} from "loon.buttons" failed: ` +
  `${message}. The menu stays open; fix the row's action.`;

test("a synchronously throwing action is contained and reported once", async () => {
  const ran: string[] = [];
  publishBridgeApi().registerRows({
    id: "loon.buttons",
    category: "Cards",
    rows: () => [
      {
        category: "Cards",
        label: "Loon explode",
        action: () => {
          ran.push("explode");
          throw new Error("row action exploded");
        },
      },
      { category: "Cards", label: "Loon refresh", action: () => void ran.push("refresh") },
    ],
  });

  const host = menuHost();
  host.buildMenu();
  assert.deepEqual(loonLabels(host), ["Loon explode", "Loon refresh"]);

  await host.press("Loon explode");
  await host.press("Loon explode");

  assert.deepEqual(ran, ["explode", "explode"], "the row ran; the throw did not escape the bridge");
  assert.deepEqual(
    snapshotNotices().entries.map((entry) => `${entry.level}: ${entry.message}`),
    [`error: ${failureNotice("Loon explode", "row action exploded")}`],
    "one report for one repeated failure, not one per press",
  );

  // The menu is still usable: the other row renders and its action still runs.
  assert.deepEqual(loonLabels(host), ["Loon explode", "Loon refresh"]);
  await host.press("Loon refresh");
  assert.deepEqual(ran, ["explode", "explode", "refresh"]);
});

test("a rejecting action is contained and reported once", async () => {
  publishBridgeApi().registerRows({
    id: "loon.buttons",
    category: "Cards",
    rows: () => [
      {
        category: "Cards",
        label: "Loon explode",
        action: async () => {
          throw new Error("row action rejected");
        },
      },
    ],
  });

  const host = menuHost();
  host.buildMenu();

  await host.press("Loon explode");
  await host.press("Loon explode");

  assert.deepEqual(
    snapshotNotices().entries.map((entry) => entry.message),
    [failureNotice("Loon explode", "row action rejected")],
    "a rejected promise is a failure too, and it is reported once",
  );
});

// ---------------------------------------------------------------------------------------------
// One provider, both kinds, in its own order
// ---------------------------------------------------------------------------------------------

test("toggles and buttons in one category keep the provider's order", () => {
  publishBridgeApi().registerRows({
    id: "loon.buttons",
    category: "Cards",
    rows: () => [
      ...toggles("Loon alpha", "Loon alpha", ["on", "off"]),
      { category: "Cards", label: "Loon refresh", action: () => {} },
      ...toggles("Loon beta", "Loon beta", ["low", "high"]),
    ],
  });

  const host = menuHost();
  host.buildMenu();

  assert.deepEqual(
    rowsOfLastBuild("loon.buttons").map((row) => labelText(row.label)),
    ["Loon alpha", "Loon alpha", "Loon refresh", "Loon beta", "Loon beta"],
    "the build keeps the provider's order across both kinds",
  );
  assert.deepEqual(
    host.toggleLines(),
    ["Loon alpha ● on ○ off", "Loon beta ● low ○ high"],
    "each toggle line is still one line; the button is its own row between them",
  );
});

test("a placed block keeps its toggle pair and its button together, before the host rows", () => {
  publishBridgeApi().registerRows({
    id: "loon.block",
    category: "Cards",
    placement: "start",
    rows: () => [
      ...toggles("Loon alpha", "Loon alpha", ["on", "off"]),
      { category: "Cards", label: "Loon refresh", action: () => {} },
    ],
  });

  const host = menuHost();
  host.buildMenu();

  assert.deepEqual(
    host.liveRows().filter((row) => row.category === "Cards").map((row) => labelText(row.label)),
    ["Loon alpha", "Loon alpha", "Loon refresh", "Card bash: builtin", "Card output: builtin"],
    "one block, before the host's own Card rows",
  );
  assert.deepEqual(
    host.toggleLines(),
    ["Loon alpha ● on ○ off"],
    "and its two values are still one line",
  );
});
