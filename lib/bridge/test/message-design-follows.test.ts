/**
 * S1 — a message design that FOLLOWS a tool design's switch (0.12.0).
 *
 * The consumer's case in one sentence: the user already picked `activity` on the `Card tags` line, and
 * that same value must turn the two alert designs on — no second switch, no seed, no writing the other
 * store. So a design may declare `follows: { line, id }`, its activation is answered LIVE from that
 * tool line, and nothing about it costs anything while the follow answers something else.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { adoptCustomMessages } from "../src/message-design-adoption.ts";
import { resetBusForTests } from "../src/bus.ts";
import {
  getMessageDesignSelectionReads,
  registerMessageDesign,
  resetMessageDesignSelectionReads,
  resetMessageDesignsForTests,
  resolveMessageDesignFollow,
  resolveMessageDesignSelection,
  setMessageDesignSelection,
} from "../src/message-designs.ts";
import {
  installMessageDesignRows,
  messageDesignLineNames,
  messageDesignRows,
  resetMessageDesignRowStateForTests,
} from "../src/message-design-rows.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetPluginLinesForTests } from "../src/plugin-lines.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import {
  registerToolDesign,
  resetToolDesignsForTests,
  setToolDesignLineSelection,
} from "../src/tool-designs.ts";
import type { CustomizeRow, MessageDesignRegistration } from "../src/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-message-follows-"));
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
  resetToolDesignsForTests();
  resetStoreStateForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
  resetRowBuildStateForTests();
  resetBusForTests();
});

const BUDGET = "gentle-pi.exploration-budget";
const REMINDER = "gentle-pi.verifier-settle-reminder";

/** The consumer's own tool line, and the value its user has to pick. */
const TOOL_LINE = "tags";
const TOOL_DESIGN_ID = "activity";

const toolLine = (): (() => void) =>
  registerToolDesign({
    line: TOOL_LINE,
    tools: ["bash", "read"],
    id: TOOL_DESIGN_ID,
    label: "activity",
    apply: (lines: readonly string[]) => [...lines],
  });

const follows = (
  extra: Partial<MessageDesignRegistration> = {},
): MessageDesignRegistration => ({
  customType: BUDGET,
  id: "loon.budget",
  label: "budget",
  follows: { line: TOOL_LINE, id: TOOL_DESIGN_ID },
  apply: (lines: readonly string[]) => [...lines],
  ...extra,
});

const toolStorePath = (): string =>
  join(configHome, "gentle-shell-bridge", "bridge-tool-designs.json");

// ---------------------------------------------------------------------------------------------
// The capability
// ---------------------------------------------------------------------------------------------

test("S1: while the followed switch answers that design, the message design is the one selected", () => {
  toolLine();
  registerMessageDesign(follows());
  setToolDesignLineSelection("line", TOOL_LINE, TOOL_DESIGN_ID);

  assert.deepEqual(
    resolveMessageDesignSelection(BUDGET).kind,
    "design",
    "the value the user already picked turns it on",
  );
});

test("S1: while it answers something else, the message stays the host's own — no second switch", () => {
  toolLine();
  registerMessageDesign(follows());

  // Nothing picked on the tool line: `native` (the host's own output), not a second choice to make.
  assert.deepEqual(resolveMessageDesignSelection(BUDGET), { kind: "native" });

  setToolDesignLineSelection("line", TOOL_LINE, "native");
  assert.deepEqual(resolveMessageDesignSelection(BUDGET), { kind: "native" });
});

test("S1: the follow is answered LIVE, so flipping the switch flips the message with no re-registration", () => {
  toolLine();
  registerMessageDesign(follows());

  setToolDesignLineSelection("line", TOOL_LINE, TOOL_DESIGN_ID);
  assert.equal(resolveMessageDesignSelection(BUDGET).kind, "design");
  setToolDesignLineSelection("line", TOOL_LINE, "native");
  assert.equal(resolveMessageDesignSelection(BUDGET).kind, "native");
  setToolDesignLineSelection("line", TOOL_LINE, TOOL_DESIGN_ID);
  assert.equal(resolveMessageDesignSelection(BUDGET).kind, "design");
});

test("S1: a follow naming no live tool line answers nothing, and says so", () => {
  registerMessageDesign(follows({ follows: { line: "nobody-registered-this", id: TOOL_DESIGN_ID } }));

  assert.deepEqual(resolveMessageDesignSelection(BUDGET), { kind: "native" });
  assert.deepEqual(resolveMessageDesignFollow({ line: "nobody-registered-this", id: TOOL_DESIGN_ID }), {
    line: "nobody-registered-this",
    found: false,
    answered: "none",
    active: false,
  });
});

test("S1: the follow is READ, never written: the tool document is byte-identical afterwards", () => {
  toolLine();
  setToolDesignLineSelection("line", TOOL_LINE, TOOL_DESIGN_ID);
  registerMessageDesign(follows());
  const before = readFileSync(toolStorePath(), "utf8");

  resetMessageDesignSelectionReads();
  resolveMessageDesignSelection(BUDGET);
  resolveMessageDesignFollow({ line: TOOL_LINE, id: TOOL_DESIGN_ID });

  assert.equal(readFileSync(toolStorePath(), "utf8"), before, "reading a switch never rewrites it");
  assert.equal(
    getMessageDesignSelectionReads(),
    0,
    "and the message document is never opened: the follow decides, so there is nothing to look up",
  );
});

test("S1: the reader says which line answered what, for `/bridge-status`", () => {
  toolLine();
  setToolDesignLineSelection("line", TOOL_LINE, "native");
  assert.deepEqual(resolveMessageDesignFollow({ line: TOOL_LINE, id: TOOL_DESIGN_ID }), {
    line: TOOL_LINE,
    found: true,
    answered: "native",
    active: false,
  });

  setToolDesignLineSelection("line", TOOL_LINE, TOOL_DESIGN_ID);
  assert.deepEqual(resolveMessageDesignFollow({ line: TOOL_LINE, id: TOOL_DESIGN_ID }), {
    line: TOOL_LINE,
    found: true,
    answered: TOOL_DESIGN_ID,
    active: true,
  });
});

// ---------------------------------------------------------------------------------------------
// No second switch, and nothing paid when the follow answers nothing
// ---------------------------------------------------------------------------------------------

test("S1: a following design offers NO value on the customize line", () => {
  toolLine();
  registerMessageDesign(follows());
  installMessageDesignRows();

  assert.deepEqual(messageDesignRows(), [], "no row: the tool switch is the only switch");
  assert.deepEqual(messageDesignLineNames(), []);
});

test("S1: a line of only following designs contributes no row, and a line with a real design keeps its own", () => {
  toolLine();
  registerMessageDesign([
    follows(),
    follows({ customType: REMINDER, id: "loon.reminder", follows: { line: TOOL_LINE, id: TOOL_DESIGN_ID } }),
  ]);
  assert.deepEqual(messageDesignRows(), [], "two follows, still no switch of their own");

  registerMessageDesign({
    customType: "loon.some-other-message",
    id: "loon.plain",
    label: "plain",
    apply: (lines: readonly string[]) => [...lines],
  });
  const values = messageDesignRows().map((row: CustomizeRow) => row.choice?.value);
  assert.deepEqual(values, ["default", "plain"], "a design with its own switch keeps it");
});

// ---------------------------------------------------------------------------------------------
// Backwards compatibility
// ---------------------------------------------------------------------------------------------

test("S1: a 0.11.0 registration without `follows` behaves exactly as it did", () => {
  registerMessageDesign({
    customType: BUDGET,
    id: "loon.budget",
    label: "budget",
    apply: (lines: readonly string[]) => [...lines],
  });
  setMessageDesignSelection(BUDGET, "loon.budget");

  assert.equal(resolveMessageDesignSelection(BUDGET).kind, "design");
  assert.deepEqual(
    messageDesignRows().map((row: CustomizeRow) => row.choice?.value),
    ["default", "budget"],
    "its own switch, unchanged",
  );
});

test("S1: a malformed follow is refused whole, and stores nothing", () => {
  for (const bad of [
    { line: "", id: TOOL_DESIGN_ID },
    { line: TOOL_LINE, id: "" },
    { line: TOOL_LINE },
    { id: TOOL_DESIGN_ID },
  ]) {
    assert.throws(
      () => registerMessageDesign(follows({ follows: bad as never })),
      /invalid message design/u,
      JSON.stringify(bad),
    );
  }
  assert.deepEqual(messageDesignRows(), []);
  assert.deepEqual(resolveMessageDesignSelection(BUDGET), { kind: "native" });
});

// ---------------------------------------------------------------------------------------------
// The flip reaches a message already on screen
// ---------------------------------------------------------------------------------------------

test("S1: flipping the Card tags switch repaints a message already on screen", () => {
  toolLine();
  registerMessageDesign(follows({ apply: () => ["design row"] }));

  // The smallest faithful Pi message: the renderer is resolved at rebuild, the frame renders it.
  const child = {
    message: { customType: BUDGET, content: "body" },
    customRenderer: ((): unknown => ({ render: () => ["host frame"] })) as unknown,
    component: undefined as unknown,
    rebuild(this: { component: unknown; message: unknown; customRenderer: unknown }): void {
      this.component =
        typeof this.customRenderer === "function"
          ? (this.customRenderer as (m: unknown, o: unknown, t: unknown) => unknown)(
              this.message,
              {},
              {},
            )
          : undefined;
    },
    invalidate(): void {
      this.rebuild();
    },
    render(width: number): readonly string[] {
      const component = this.component as { render(w: number): readonly string[] } | undefined;
      return component === undefined ? ["pi box"] : component.render(width);
    },
  };
  child.rebuild();
  const chat = { children: [child] };

  adoptCustomMessages(chat);
  assert.deepEqual(child.render(40), ["host frame"], "nothing picked: the host's own frame");

  setToolDesignLineSelection("line", TOOL_LINE, TOOL_DESIGN_ID);
  adoptCustomMessages(chat);
  assert.deepEqual(child.render(40), ["design row"], "the value the user already picked turns it on");

  setToolDesignLineSelection("line", TOOL_LINE, "native");
  adoptCustomMessages(chat);
  assert.deepEqual(child.render(40), ["host frame"], "and off again, with the host's own frame");
});

// ---------------------------------------------------------------------------------------------
// The report answers "why is my design not painting?"
// ---------------------------------------------------------------------------------------------

test("S1: `/bridge-status` names the line and the id a design follows, and what it answers", () => {
  toolLine();
  registerMessageDesign(follows());
  setToolDesignLineSelection("line", TOOL_LINE, TOOL_DESIGN_ID);

  const [line] = collectStatus().messageDesigns?.lines ?? [];
  const value = line?.values.find((candidate) => candidate.id === "loon.budget");
  assert.deepEqual(value?.follow, {
    line: TOOL_LINE,
    id: TOOL_DESIGN_ID,
    answered: TOOL_DESIGN_ID,
    active: true,
  });

  const printed = formatStatus(collectStatus()).join("\n");
  assert.match(printed, /follows tags\/activity: answers activity \(on\)/u);

  setToolDesignLineSelection("line", TOOL_LINE, "native");
  assert.match(
    formatStatus(collectStatus()).join("\n"),
    /follows tags\/activity: answers native \(off\)/u,
    "the report says the switch is off, not that the design is broken",
  );
});

// ---------------------------------------------------------------------------------------------
// 0.12.1 — a stale message-side value cannot veto an active follow (the case 0.12.0 was built for)
// ---------------------------------------------------------------------------------------------

test("S1: a stale stored id in the message document cannot veto an active follow", () => {
  toolLine();
  registerMessageDesign(follows());
  // What a disposed 0.11.0 design leaves behind: its id is still stored for this custom type.
  setMessageDesignSelection(BUDGET, "stale.previous-design");
  setToolDesignLineSelection("line", TOOL_LINE, TOOL_DESIGN_ID);

  const resolved = resolveMessageDesignSelection(BUDGET);
  assert.equal(resolved.kind, "design", "the follow decides, whatever the message document holds");
  assert.equal(resolved.kind === "design" ? resolved.design.id : "", "loon.budget");
});

test("S1: an active follow wins over a stale id even when the followed line has other designs", () => {
  toolLine();
  registerToolDesign({
    line: TOOL_LINE,
    tools: ["read"],
    id: "plain",
    label: "plain",
    apply: (lines: readonly string[]) => [...lines],
  });
  registerMessageDesign(follows());
  setMessageDesignSelection(BUDGET, "loon.removed-long-ago");
  setToolDesignLineSelection("line", TOOL_LINE, TOOL_DESIGN_ID);

  assert.equal(resolveMessageDesignSelection(BUDGET).kind, "design");
});

test("S4: a claimed alert whose follow answers nothing reads NO store at all", () => {
  toolLine();
  registerMessageDesign(follows()); // claimed, and the tool line answers something else
  resetMessageDesignSelectionReads();

  assert.deepEqual(resolveMessageDesignSelection(BUDGET), { kind: "native" });
  assert.equal(
    getMessageDesignSelectionReads(),
    0,
    "no message-document read: the follow is the only thing that could select it",
  );
});

test("S4: and it still reads nothing on the second pass", () => {
  toolLine();
  registerMessageDesign(follows());
  resetMessageDesignSelectionReads();
  resolveMessageDesignSelection(BUDGET);
  const after = getMessageDesignSelectionReads();
  resolveMessageDesignSelection(BUDGET);
  assert.equal(getMessageDesignSelectionReads() - after, 0);
});
