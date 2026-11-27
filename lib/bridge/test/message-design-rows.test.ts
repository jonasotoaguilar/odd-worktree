/**
 * S1 — the customize line for message designs, asserted without a host.
 *
 * The rows are built per menu build from the live registry (`./message-design-rows.ts`), so this file
 * drives that builder directly: the line's name, `default` first, one value per design, the preview, the
 * action that persists, and the "no design, no line" rule that keeps a session without design plugins
 * byte-identical.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resetBusForTests, snapshotProviders } from "../src/bus.ts";
import {
  MESSAGE_DESIGN_DEFAULT_LABEL,
  MESSAGE_DESIGN_NATIVE,
  getMessageDesignLineSelection,
  registerMessageDesign,
  resetMessageDesignsForTests,
  setMessageDesignSelection,
} from "../src/message-designs.ts";
import {
  MESSAGE_DESIGN_ROWS_PROVIDER_ID,
  installMessageDesignRows,
  messageDesignLineNames,
  messageDesignRows,
  resetMessageDesignRowStateForTests,
} from "../src/message-design-rows.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetPluginLinesForTests } from "../src/plugin-lines.ts";
import { resetRepaintForTests } from "../src/repaint.ts";
import { resetRowNameRejectionsForTests, rowNameProblem } from "../src/row-names.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CustomizeRow, InlineHelpers, MessageDesignRegistration } from "../src/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-message-rows-"));
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
  resetMessageDesignsForTests();
  resetMessageDesignRowStateForTests();
  resetRepaintForTests();
  resetStoreStateForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
  resetRowBuildStateForTests();
  resetRowNameRejectionsForTests();
  resetBusForTests();
});

const BUDGET_TYPE = "gentle-pi.exploration-budget";

const design = (extra: Partial<MessageDesignRegistration> = {}): MessageDesignRegistration => ({
  customType: BUDGET_TYPE,
  id: "loon.budget",
  label: "budget",
  apply: (lines: readonly string[]) => [...lines],
  ...extra,
});

const settingOf = (rows: readonly CustomizeRow[]): string | undefined => rows[0]?.choice?.setting;

// ---------------------------------------------------------------------------------------------
// No design, no line
// ---------------------------------------------------------------------------------------------

test("S1: with no design registered the provider contributes no row at all", () => {
  assert.deepEqual(messageDesignRows(), [], "an empty line would be worse than no line");
  assert.deepEqual(messageDesignLineNames(), []);
});

// ---------------------------------------------------------------------------------------------
// The line and its values
// ---------------------------------------------------------------------------------------------

test("S1: one design yields `default` first and the design second, on ONE setting", () => {
  registerMessageDesign(design());

  const rows = messageDesignRows();
  assert.equal(rows.length, 2, "default plus one value");
  assert.equal(rows[0].choice?.value, MESSAGE_DESIGN_DEFAULT_LABEL, "default is the first value");
  assert.equal(rows[1].choice?.value, "budget", "then the design's label, never its id");
  assert.equal(rows[0].choice?.setting, rows[1].choice?.setting, "one line, coalesced by the host");
  assert.equal(rows[0].category, rows[1].category, "and both in the Cards category");
});

test("S1: the line's name is `Message <words>` and passes the row-name rule", () => {
  registerMessageDesign(design());

  const name = messageDesignLineNames()[0].name;
  assert.match(name, /^Message /u, "the message surface's own word");
  assert.equal(
    rowNameProblem(name),
    undefined,
    `the derived name must satisfy the row-name rule: ${name}`,
  );
  assert.equal(messageDesignRows()[0].choice?.setting, name, "the row carries that name");
});

test("S1: several designs of one line are the values of ONE line, in registration order", () => {
  registerMessageDesign({
    line: "reminders",
    types: [BUDGET_TYPE],
    id: "loon.one",
    label: "one",
    apply: (lines: readonly string[]) => [...lines],
  });
  registerMessageDesign({
    line: "reminders",
    types: ["gentle-pi.verifier-settle-reminder"],
    id: "loon.two",
    label: "two",
    apply: (lines: readonly string[]) => [...lines],
  });

  const rows = messageDesignRows();
  assert.deepEqual(
    rows.map((row: CustomizeRow) => row.choice?.value),
    [MESSAGE_DESIGN_DEFAULT_LABEL, "one", "two"],
    "default, then the designs in the order they were registered",
  );
  assert.deepEqual(
    [...new Set(rows.map((row: CustomizeRow) => row.choice?.setting))],
    [settingOf(rows)],
    "all of them share the line's one setting",
  );
});

test("S1: two lines are told apart, and neither name breaks the rule", () => {
  registerMessageDesign(design({ customType: BUDGET_TYPE, id: "loon.budget" }));
  registerMessageDesign(design({ customType: "gentle-pi.verifier-settle-reminder", id: "loon.reminder" }));

  const names = messageDesignLineNames().map((line) => line.name);
  assert.equal(new Set(names).size, 2, "two distinct names");
  for (const name of names) assert.equal(rowNameProblem(name), undefined, name);
});

// ---------------------------------------------------------------------------------------------
// The bullet, the preview and the action
// ---------------------------------------------------------------------------------------------

test("S2: `current()` reads the live selection, and `default` is the identity `native`", () => {
  registerMessageDesign(design());
  assert.equal(messageDesignRows()[0].choice?.current(), true, "nothing chosen yet");
  assert.equal(messageDesignRows()[1].choice?.current(), false);

  setMessageDesignSelection(BUDGET_TYPE, "loon.budget");
  const rows = messageDesignRows();
  assert.equal(rows[0].choice?.current(), false, "the bullet left default");
  assert.equal(rows[1].choice?.current(), true, "and sits on the design");
});

test("S2: an action persists FIRST, and a press that changes nothing is a no-op", () => {
  registerMessageDesign(design());
  const [defaultRow, designRow] = messageDesignRows();
  // A row action receives the host's inline helpers; this one never opens a dialog, so an empty
  // object is enough and proves the signatures agree.
  const inline = {} as unknown as InlineHelpers;

  designRow.action?.(inline);
  assert.equal(
    getMessageDesignLineSelection("type", BUDGET_TYPE),
    "loon.budget",
    "the value is written before anything repaints",
  );

  // Pressing the same value again must not rewrite the store.
  const stored = getMessageDesignLineSelection("type", BUDGET_TYPE);
  designRow.action?.(inline);
  assert.equal(getMessageDesignLineSelection("type", BUDGET_TYPE), stored);

  defaultRow.action?.(inline);
  assert.equal(getMessageDesignLineSelection("type", BUDGET_TYPE), MESSAGE_DESIGN_NATIVE);
});

test("S2: a preview shows one row and says what the value paints", () => {
  registerMessageDesign(design({ description: "spends the budget as a bar" }));

  const preview = messageDesignRows()[1].preview?.();
  assert.equal(preview?.sample, "spends the budget as a bar", "the design's own description");
  assert.match(String(preview?.title), /budget/u);
  assert.equal(preview?.sample.split("\n").length, 1, "one row, never two");
});

test("S2: a throwing or malformed preview loses its own picture and nothing else", () => {
  registerMessageDesign(
    design({
      preview: () => {
        throw new Error("kaboom");
      },
    }),
  );
  assert.doesNotThrow(() => messageDesignRows()[1].preview?.());
  assert.match(String(messageDesignRows()[1].preview?.().sample), /budget/u, "the fallback still says");

  resetMessageDesignsForTests();
  registerMessageDesign(
    design({
      preview: () => ({ title: 1, sample: 2 }) as unknown as { title: string; sample: string },
    }),
  );
  assert.match(String(messageDesignRows()[1].preview?.().sample), /budget/u);
});

// ---------------------------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------------------------

test("S4: arming with no design contributes NO provider, so nothing pays per pass", () => {
  // With no design there is no provider at all: Pi credits one fewer registration, the menu runs
  // nothing extra, and `/bridge-status` keeps its historical output. The id is reserved, so no plugin
  // can hold it and hand it back — which is why lazy is safe.
  installMessageDesignRows();
  assert.deepEqual(
    snapshotProviders().filter((provider) => provider.id === MESSAGE_DESIGN_ROWS_PROVIDER_ID),
    [],
    "a session that never registered a design gains no provider at all",
  );
  assert.deepEqual(messageDesignRows(), [], "and therefore no row");
});

test("S4: the FIRST design installs the line, with no second arm", () => {
  installMessageDesignRows();
  registerMessageDesign(design());

  const providers = snapshotProviders().filter(
    (provider) => provider.id === MESSAGE_DESIGN_ROWS_PROVIDER_ID,
  );
  assert.equal(providers.length, 1, "a design appeared, so the line is there to show it");
  assert.equal(messageDesignRows().length, 2, "default plus the design");
});

test("S1: installing twice contributes the line once, and the disposer withdraws it", () => {
  registerMessageDesign(design());
  const dispose = installMessageDesignRows();
  installMessageDesignRows();

  const providers = snapshotProviders().filter(
    (provider) => provider.id === MESSAGE_DESIGN_ROWS_PROVIDER_ID,
  );
  assert.equal(providers.length, 1, "one provider, however many times the bridge armed");

  dispose();
  assert.equal(
    snapshotProviders().filter((provider) => provider.id === MESSAGE_DESIGN_ROWS_PROVIDER_ID).length,
    0,
    "and the disposer withdraws it",
  );
});
