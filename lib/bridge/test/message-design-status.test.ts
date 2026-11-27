/**
 * T5/S4 — the `/bridge-status` block for message designs.
 *
 * The block has to answer the plugin author's question — "why is my message still Pi's own box?" —
 * with the line, the design the user selected, whether the adoption pass has reached the messages
 * already on screen, and every conflict and failure the registry recorded. And it has to say NOTHING
 * when nothing was registered: a session that never claimed a custom type keeps the report it had
 * before this surface existed, byte for byte (S4).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerRows, resetBusForTests, snapshotProviders } from "../src/bus.ts";
import { adoptCustomMessages, resetMessageDesignAdoptionForTests } from "../src/message-design-adoption.ts";
import {
  MESSAGE_DESIGN_ROWS_PROVIDER_ID,
  installMessageDesignRows,
  resetMessageDesignRowStateForTests,
} from "../src/message-design-rows.ts";
import {
  applyMessageDesign,
  registerMessageDesign,
  resetMessageDesignsForTests,
  setMessageDesignLineSelection,
} from "../src/message-designs.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetPluginLinesForTests } from "../src/plugin-lines.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { collectStatus, formatStatus, type StatusSnapshot } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { MessageDesignContext, MessageDesignRegistration } from "../src/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-message-status-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  // The selections are a real file: every test starts from nothing on disk.
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetMessageDesignsForTests();
  resetMessageDesignAdoptionForTests();
  resetMessageDesignRowStateForTests();
  resetBusForTests();
  resetStoreStateForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
  resetRowBuildStateForTests();
});

const TYPE = "gentle-pi.exploration-budget";
const REMINDER = "gentle-pi.verifier-settle-reminder";

const design = (
  extra: Partial<MessageDesignRegistration> = {},
): MessageDesignRegistration => ({
  customType: TYPE,
  id: "loon.budget",
  label: "budget",
  apply: (lines: readonly string[]) => [...lines],
  ...extra,
});

const context = (customType = TYPE): MessageDesignContext => ({
  width: 80,
  customType,
  render: { expanded: false, outputPad: 1, message: {} },
});

/** The report from the `message design` header onward: nothing else in this session writes there. */
const blockLines = (snapshot: StatusSnapshot): string[] => {
  const all = formatStatus(snapshot);
  const at = all.findIndex((line) => line.startsWith("message design"));
  return at === -1 ? [] : all.slice(at);
};

// ---------------------------------------------------------------------------------------------
// S4: no design, no block
// ---------------------------------------------------------------------------------------------

test("S4: a session with no message design keeps the report it had, with no block at all", () => {
  const snapshot = collectStatus();

  assert.equal(snapshot.messageDesigns, undefined, "nothing was claimed, so there is nothing to say");
  assert.deepEqual(formatStatus(snapshot), [
    "gentle-shell-bridge status",
    "providers: none",
    "backend: none",
    "last capture: none",
    "last failures: none",
    "store problems: none",
    "duplicate settings: no build yet",
  ]);
  assert.doesNotMatch(formatStatus(snapshot).join("\n"), /message design/u);
});

test("S4: the bridge's own Message line is plumbing, never a provider in the report", () => {
  installMessageDesignRows();
  registerMessageDesign(design());

  assert.equal(
    snapshotProviders().filter((provider) => provider.id === MESSAGE_DESIGN_ROWS_PROVIDER_ID).length,
    1,
    "the design installed the customize line",
  );
  assert.deepEqual(
    collectStatus().providers,
    [],
    "the bridge's own line is reported by the message-design block, not as a plugin provider",
  );
});

// ---------------------------------------------------------------------------------------------
// One design: the line, its values and the selection in force
// ---------------------------------------------------------------------------------------------

test("one design reports its line, the design selected and every value", () => {
  registerMessageDesign(design());

  const before = collectStatus();
  assert.ok(before.messageDesigns !== undefined, "a registered design reports the block");
  assert.deepEqual(before.messageDesigns.lines, [
    {
      scope: "type",
      line: TYPE,
      rowName: "Message exploration budget",
      types: [TYPE],
      selection: "native",
      values: [
        { id: "native", label: "default", covers: [TYPE] },
        { id: "loon.budget", label: "budget", covers: [TYPE] },
      ],
    },
  ]);
  assert.deepEqual(blockLines(before), [
    "message designs: 1 line",
    `  - ${TYPE} "Message exploration budget": native`,
    `      native "default": covers ${TYPE}`,
    `      loon.budget "budget": covers ${TYPE}`,
    "message design adoption: none",
  ]);

  setMessageDesignLineSelection("type", TYPE, "loon.budget");
  assert.deepEqual(blockLines(collectStatus()), [
    "message designs: 1 line",
    `  - ${TYPE} "Message exploration budget": loon.budget`,
    `      native "default": covers ${TYPE}`,
    `      loon.budget "budget": covers ${TYPE}`,
    "message design adoption: none",
  ]);
});

test("a grouped line reports its ONE row name, its types and the values that cover them", () => {
  registerMessageDesign({
    line: "reminders",
    types: [TYPE, REMINDER],
    id: "loon.reminders",
    label: "reminders",
    apply: (lines: readonly string[]) => [...lines],
  });
  registerMessageDesign({
    line: "reminders",
    types: [REMINDER],
    id: "loon.loud",
    label: "loud",
    apply: (lines: readonly string[]) => [...lines],
  });
  setMessageDesignLineSelection("line", "reminders", "loon.loud");

  const snapshot = collectStatus();
  assert.ok(snapshot.messageDesigns !== undefined);
  assert.deepEqual(
    snapshot.messageDesigns.lines.map((line) => ({
      rowName: line.rowName,
      types: line.types,
      selection: line.selection,
      values: line.values,
    })),
    [
      {
        rowName: "Message reminders",
        types: [TYPE, REMINDER],
        selection: "loon.loud",
        values: [
          { id: "native", label: "default", covers: [TYPE, REMINDER] },
          { id: "loon.reminders", label: "reminders", covers: [TYPE, REMINDER] },
          { id: "loon.loud", label: "loud", covers: [REMINDER] },
        ],
      },
    ],
  );
});

test("a selection that names a disposed design reads missing instead of default", () => {
  const disposeReminders = registerMessageDesign({
    line: "reminders",
    types: [TYPE, REMINDER],
    id: "loon.reminders",
    label: "reminders",
    apply: (lines: readonly string[]) => [...lines],
  });
  const disposeLoud = registerMessageDesign({
    line: "reminders",
    types: [REMINDER],
    id: "loon.loud",
    label: "loud",
    apply: (lines: readonly string[]) => [...lines],
  });
  setMessageDesignLineSelection("line", "reminders", "loon.loud");
  // The selected design goes away while its line stays: the value must not read as the user's
  // `default`, and must not read as a design that is drawing either.
  disposeLoud();

  const snapshot = collectStatus();
  assert.ok(snapshot.messageDesigns !== undefined);
  assert.deepEqual(
    snapshot.messageDesigns.lines.map((line) => line.selection),
    ["loon.loud (missing: not registered)"],
  );
  assert.deepEqual(blockLines(snapshot).slice(0, 2), [
    "message designs: 1 line",
    '  - reminders "Message reminders": loon.loud (missing: not registered)',
  ]);

  // No live design at all: the block goes with it, even though a value is still stored (S4).
  disposeReminders();
  assert.equal(
    collectStatus().messageDesigns,
    undefined,
    "a stored value alone never adds a block for a surface nobody registered",
  );
});

// ---------------------------------------------------------------------------------------------
// What a refused registration and a throwing design report
// ---------------------------------------------------------------------------------------------

test("a refused registration reports its conflict", () => {
  registerMessageDesign(design());

  assert.throws(
    () =>
      registerMessageDesign({
        line: "reminders",
        types: [TYPE],
        id: "loon.reminders",
        label: "reminders",
        apply: (lines: readonly string[]) => [...lines],
      }),
    /a custom type belongs to ONE line/u,
  );

  const snapshot = collectStatus();
  assert.ok(snapshot.messageDesigns !== undefined);
  assert.deepEqual(
    snapshot.messageDesigns.conflicts.map((conflict) => ({
      customType: conflict.customType,
      id: conflict.id,
      kind: conflict.kind,
    })),
    [{ customType: TYPE, id: "loon.reminders", kind: "type" }],
  );
  const block = blockLines(snapshot);
  assert.ok(block.includes("message design conflicts: 1"), block.join("\n"));
  assert.ok(
    block.some((line) => line.startsWith(`  - ${TYPE} / loon.reminders (type): message "${TYPE}" is`)),
    block.join("\n"),
  );
});

test("a throwing design reports ONE failure, however many passes threw", () => {
  const exploding = design({
    apply: (): string[] => {
      throw new Error("design exploded");
    },
  });
  registerMessageDesign(exploding);

  for (let pass = 0; pass < 3; pass += 1) {
    assert.equal(
      applyMessageDesign(exploding, [], context()),
      undefined,
      "a throwing design loses its own output and nothing else",
    );
  }

  const snapshot = collectStatus();
  assert.ok(snapshot.messageDesigns !== undefined);
  assert.deepEqual(
    snapshot.messageDesigns.failures.map((failure) => ({
      customType: failure.customType,
      designId: failure.designId,
      message: failure.message,
    })),
    [{ customType: TYPE, designId: "loon.budget", message: "design exploded" }],
  );
  const block = blockLines(snapshot);
  assert.ok(block.includes("message design failures: 1"), block.join("\n"));
  assert.ok(
    block.includes(`  - ${TYPE} / loon.budget: design exploded`),
    block.join("\n"),
  );
});

// ---------------------------------------------------------------------------------------------
// The adoption pass
// ---------------------------------------------------------------------------------------------

test("the messages the adoption pass replaced are reported per custom type", () => {
  registerMessageDesign(design());
  setMessageDesignLineSelection("type", TYPE, "loon.budget");

  const messages = [0, 1].map(() => ({
    message: { customType: TYPE, content: "hello" },
    customRenderer: undefined as unknown,
    invalidations: 0,
    invalidate(): void {
      this.invalidations += 1;
    },
    render(): readonly string[] {
      return [];
    },
  }));
  assert.equal(adoptCustomMessages({ children: messages }).adopted, 2);

  const snapshot = collectStatus();
  assert.ok(snapshot.messageDesigns !== undefined);
  assert.deepEqual(snapshot.messageDesigns.adoptedMessages, [{ customType: TYPE, messages: 2 }]);
  assert.deepEqual(blockLines(snapshot), [
    "message designs: 1 line",
    `  - ${TYPE} "Message exploration budget": loon.budget`,
    `      native "default": covers ${TYPE}`,
    `      loon.budget "budget": covers ${TYPE}`,
    "message design adoption: 1 type, 2 messages",
    `  - ${TYPE}: 2 messages`,
  ]);
});

test("S4: the bridge's own provider id is refused, and a plugin provider is still listed", () => {
  // The id belongs to the bridge's line. Reserving it is what keeps a plugin from taking the line off
  // the menu, or from being silently replaced by it — the two ways a collision cost the user a switch.
  assert.throws(
    () => registerRows({ id: MESSAGE_DESIGN_ROWS_PROVIDER_ID, category: "Cards", rows: () => [] }),
    /belongs to the bridge's own line/u,
  );
  assert.deepEqual(snapshotProviders(), [], "a refused provider is never stored");

  // Any other id is a plugin's, and the report lists it.
  registerRows({ id: "loon.rows", category: "Cards", rows: () => [] });
  assert.deepEqual(collectStatus().providers, [{ id: "loon.rows", category: "Cards" }]);
});
