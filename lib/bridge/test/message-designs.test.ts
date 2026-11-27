/**
 * S1/S4 — the message-design registry and its selection, with no host in sight.
 *
 * A message design paints a Pi CUSTOM MESSAGE (`pi.registerMessageRenderer`'s `customType`), the way a
 * tool design paints a tool's card. This file pins the half that is pure registry — what a registration
 * accepts and refuses, what a selection resolves to, and that a resolve is ONE store read — so the
 * wiring that touches Pi's own renderer API can be tested separately against a fake host.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MESSAGE_DESIGN_DEFAULT_LABEL,
  MESSAGE_DESIGN_LINE_STORE_KEY,
  MESSAGE_DESIGN_NATIVE,
  MESSAGE_DESIGN_STORE_ID,
  MESSAGE_DESIGN_STORE_KEY,
  getMessageDesignConflicts,
  getMessageDesignFailures,
  getMessageDesignLineSelection,
  getMessageDesignSelection,
  getMessageDesignSelectionReads,
  messageDesignLines,
  registerMessageDesign,
  resetMessageDesignSelectionReads,
  resetMessageDesignsForTests,
  resolveMessageDesignSelection,
  setMessageDesignLineSelection,
  setMessageDesignSelection,
} from "../src/message-designs.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetPluginLinesForTests } from "../src/plugin-lines.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { createStore, resetStoreStateForTests } from "../src/store.ts";
import type { MessageDesignContext, MessageDesignRegistration } from "../src/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-message-designs-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

const resetAll = (): void => {
  resetMessageDesignsForTests();
  resetStoreStateForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
  resetRowBuildStateForTests();
  // The selections are a real file: every test starts from nothing on disk.
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
};

test.beforeEach(resetAll);

const BUDGET_TYPE = "gentle-pi.exploration-budget";
const REMINDER_TYPE = "gentle-pi.verifier-settle-reminder";

const design = (extra: Partial<MessageDesignRegistration> = {}): MessageDesignRegistration => ({
  customType: BUDGET_TYPE,
  id: "loon.budget",
  label: "budget",
  apply: (lines: readonly string[]) => [...lines],
  ...extra,
});

/** The stored document, read back the way the bridge itself writes it. */
const storedDocument = (): Record<string, unknown> =>
  createStore(MESSAGE_DESIGN_STORE_ID).get<Record<string, unknown>>(MESSAGE_DESIGN_STORE_KEY, {});

// ---------------------------------------------------------------------------------------------
// What a registration accepts and refuses
// ---------------------------------------------------------------------------------------------

test("S1: an ungrouped design names ONE customType and appears on the type's own line", () => {
  registerMessageDesign(design());

  assert.deepEqual(
    messageDesignLines().map((line) => ({ scope: line.scope, line: line.line, types: line.types })),
    [{ scope: "type", line: BUDGET_TYPE, types: [BUDGET_TYPE] }],
    "one implicit line, named after the type",
  );
});

test("S1: a grouped design names a line and its types, and several join ONE line", () => {
  registerMessageDesign({
    line: "reminders",
    types: [BUDGET_TYPE, REMINDER_TYPE],
    id: "loon.reminders",
    label: "reminders",
    apply: (lines: readonly string[]) => [...lines],
  });
  registerMessageDesign({
    line: "reminders",
    types: [REMINDER_TYPE],
    id: "loon.reminders-loud",
    label: "loud",
    apply: (lines: readonly string[]) => [...lines],
  });

  const lines = messageDesignLines();
  assert.equal(lines.length, 1, "one line, not one per registration");
  assert.equal(lines[0].scope, "line");
  assert.equal(lines[0].line, "reminders");
  assert.deepEqual([...lines[0].types].sort(), [BUDGET_TYPE, REMINDER_TYPE]);
  assert.deepEqual(
    lines[0].designs.map((entry: MessageDesignRegistration) => entry.id),
    ["loon.reminders", "loon.reminders-loud"],
    "values in registration order",
  );
});

test("S1: mixing the two shapes, or naming neither, is refused before anything is stored", () => {
  assert.throws(
    () => registerMessageDesign(design({ line: "reminders", types: [REMINDER_TYPE] })),
    /invalid message design/u,
    "customType with line+types",
  );
  assert.throws(
    () => registerMessageDesign({ id: "loon.empty", label: "empty", apply: (lines) => [...lines] }),
    /invalid message design/u,
    "neither shape",
  );
  assert.throws(
    () =>
      registerMessageDesign({
        line: "reminders",
        types: [],
        id: "loon.empty",
        label: "empty",
        apply: (lines: readonly string[]) => [...lines],
      }),
    /invalid message design/u,
    "an empty types list claims nothing",
  );
  assert.deepEqual(messageDesignLines(), [], "and a refusal stores nothing");
});

test("S1: an id, a label and an apply are validated the way every other surface validates them", () => {
  assert.throws(() => registerMessageDesign(design({ id: "" })), /invalid message design id/u);
  assert.throws(() => registerMessageDesign(design({ label: "" })), /invalid message design/u);
  assert.throws(
    () => registerMessageDesign(design({ label: MESSAGE_DESIGN_DEFAULT_LABEL })),
    /reserved/u,
    "`default` is the bridge's own value",
  );
  assert.throws(
    () => registerMessageDesign(design({ label: MESSAGE_DESIGN_NATIVE })),
    /reserved/u,
    "and so is `native`",
  );
  assert.throws(
    () =>
      registerMessageDesign({
        customType: BUDGET_TYPE,
        id: "loon.no-apply",
        label: "no apply",
      } as unknown as MessageDesignRegistration),
    /apply/u,
    "a design with nothing to run is a plugin bug",
  );
});

test("S1: the same id on one line replaces in place and is reported, keeping its position", () => {
  registerMessageDesign(design({ label: "first" }));
  registerMessageDesign(design({ label: "second" }));

  const lines = messageDesignLines();
  assert.equal(lines[0].designs.length, 1, "one value, not two");
  assert.equal(lines[0].designs[0].label, "second");
  assert.equal(getMessageDesignConflicts().length, 1, "the replacement is reported");
  assert.equal(getMessageDesignConflicts()[0].kind, "replaced");
});

test("S1: an array registration is all-or-nothing", () => {
  assert.throws(
    () =>
      registerMessageDesign([
        design({ id: "loon.kept" }),
        design({ id: "" }),
      ]),
    /invalid message design id/u,
  );

  assert.deepEqual(messageDesignLines(), [], "the accepted entry of the batch is withdrawn too");
});

test("S1: a disposer withdraws its own value and nothing else", () => {
  const dispose = registerMessageDesign(design({ id: "loon.gone" }));
  registerMessageDesign(design({ id: "loon.kept", label: "kept" }));

  dispose();

  assert.deepEqual(
    messageDesignLines()[0].designs.map((entry: MessageDesignRegistration) => entry.id),
    ["loon.kept"],
  );
  dispose();
  assert.equal(messageDesignLines()[0].designs.length, 1, "disposal is idempotent");
});

// ---------------------------------------------------------------------------------------------
// Selection and resolution
// ---------------------------------------------------------------------------------------------

test("S4: no selection answers `native`, and a stored design answers `design`", () => {
  registerMessageDesign(design());

  assert.deepEqual(
    resolveMessageDesignSelection(BUDGET_TYPE),
    { kind: "native" },
    "nothing chosen: the host's own output, untouched",
  );

  setMessageDesignSelection(BUDGET_TYPE, "loon.budget");
  const selection = resolveMessageDesignSelection(BUDGET_TYPE);
  assert.equal(selection.kind, "design");
  if (selection.kind !== "design") return;
  assert.equal(selection.design.id, "loon.budget");
});

test("S4: a selection whose design was disposed answers `missing`, never `native`", () => {
  const dispose = registerMessageDesign(design());
  setMessageDesignSelection(BUDGET_TYPE, "loon.budget");
  dispose();

  assert.deepEqual(resolveMessageDesignSelection(BUDGET_TYPE), {
    kind: "missing",
    id: "loon.budget",
  });
});

test("S1: a grouped line's value covers only the types its own design lists", () => {
  registerMessageDesign({
    line: "reminders",
    types: [BUDGET_TYPE],
    id: "loon.budget-only",
    label: "budget only",
    apply: (lines: readonly string[]) => [...lines],
  });
  // A second VALUE of the SAME line, covering both types: the line claims both, the selected value
  // does not, and that difference is exactly what `not-covered` reports (S1).
  registerMessageDesign({
    line: "reminders",
    types: [BUDGET_TYPE, REMINDER_TYPE],
    id: "loon.both",
    label: "both",
    apply: (lines: readonly string[]) => [...lines],
  });
  setMessageDesignLineSelection("line", "reminders", "loon.budget-only");

  const covered = resolveMessageDesignSelection(BUDGET_TYPE);
  assert.equal(covered.kind, "design", "the type the selected value lists is covered");

  assert.deepEqual(
    resolveMessageDesignSelection(REMINDER_TYPE),
    { kind: "not-covered", id: "loon.budget-only" },
    "a type the selected value does not list is not painted by it",
  );
});

test("S1: the selection persists in the bridge's own file, and an unused line map is never written", () => {
  setMessageDesignSelection(BUDGET_TYPE, "loon.budget");
  assert.deepEqual(storedDocument(), { [BUDGET_TYPE]: "loon.budget" });

  setMessageDesignLineSelection("line", "reminders", "loon.loud");
  assert.deepEqual(storedDocument(), {
    [BUDGET_TYPE]: "loon.budget",
    [MESSAGE_DESIGN_LINE_STORE_KEY]: { reminders: "loon.loud" },
  });
  assert.equal(getMessageDesignLineSelection("type", BUDGET_TYPE), "loon.budget");
  assert.equal(getMessageDesignLineSelection("line", "reminders"), "loon.loud");
  assert.equal(
    getMessageDesignLineSelection("line", "never-set"),
    MESSAGE_DESIGN_NATIVE,
    "an unset line reads as the host's own output",
  );
});

test("S4: one resolve is ONE store read, and it never throws", () => {
  registerMessageDesign(design());
  setMessageDesignSelection(BUDGET_TYPE, "loon.budget");

  resetMessageDesignSelectionReads();
  resolveMessageDesignSelection(BUDGET_TYPE);
  assert.equal(getMessageDesignSelectionReads(), 1, "one logical read, not one per candidate");

  // A stored value that is not a string is a hand edit, never a crash.
  createStore(MESSAGE_DESIGN_STORE_ID).set(MESSAGE_DESIGN_STORE_KEY, { [BUDGET_TYPE]: 42 });
  assert.deepEqual(resolveMessageDesignSelection(BUDGET_TYPE), { kind: "native" });
  assert.deepEqual(resolveMessageDesignSelection("never-seen"), { kind: "native" });
});

test("S4: a throwing design is isolated and reported, and the resolve still answers", () => {
  registerMessageDesign(
    design({
      apply: () => {
        throw new Error("kaboom");
      },
    }),
  );
  setMessageDesignSelection(BUDGET_TYPE, "loon.budget");

  const selection = resolveMessageDesignSelection(BUDGET_TYPE);
  assert.equal(selection.kind, "design", "resolving never runs the design");

  // Nothing above should have recorded a failure: `apply` runs per pass, in the wiring, not here.
  assert.deepEqual(getMessageDesignFailures(), []);
});

// ---------------------------------------------------------------------------------------------
// The types are the contract a design is written against
// ---------------------------------------------------------------------------------------------

test("S1: MessageDesignContext is the shape a design receives, and message is the host's own object", () => {
  const message = { customType: BUDGET_TYPE, content: [] };
  const ctx: MessageDesignContext = {
    width: 72,
    customType: BUDGET_TYPE,
    theme: { name: "fake" },
    cardStyle: { kind: "native" },
    render: { expanded: false, outputPad: 0, message },
  };

  assert.equal(ctx.render.message, message, "forwarded by reference, never cloned");
  assert.equal(ctx.width, 72);
});
