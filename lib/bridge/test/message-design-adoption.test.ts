/**
 * T3 — the adoption pass: the message Pi already mounted, reached where Pi keeps it.
 *
 * A `CustomMessageComponent` holds the renderer Pi resolved for that message in `customRenderer` and
 * calls it again on every `rebuild()`. Nothing else reaches it: `registerMessageRenderer` writes into
 * the registering extension's own map and the runner answers the first one in load order, so the
 * component is the only capture point there is.
 *
 * This file drives the pass with a component that rebuilds the way Pi's does, so the observable
 * contract is pinned: an unclaimed type is never touched (S4), a host-rendered type keeps its frame
 * and only its rows change (S3), and the switch back to `default` restores the host's own output.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerCardStyle, resetBusForTests } from "../src/bus.ts";
import { setCardStyleSelection } from "../src/card-styles.ts";
import {
  adoptCustomMessages,
  resetMessageDesignAdoptionForTests,
} from "../src/message-design-adoption.ts";
import {
  getMessageDesignFailures,
  getMessageDesignSelectionReads,
  registerMessageDesign,
  resetMessageDesignSelectionReads,
  resetMessageDesignsForTests,
  setMessageDesignSelection,
} from "../src/message-designs.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { MessageDesignRegistration } from "../src/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-message-adoption-"));
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
  resetMessageDesignAdoptionForTests();
  resetBusForTests();
  resetStoreStateForTests();
});

const TYPE = "gentle-pi.exploration-budget";
const REMINDER = "gentle-pi.verifier-settle-reminder";

/**
 * The smallest faithful stand-in for Pi's `CustomMessageComponent`: it keeps the renderer it was
 * built with, calls it again on `rebuild()`, and falls back to its own box when the renderer answers
 * `undefined`. `rendererCalls` and `invalidations` are the observable effects of an adoption pass.
 */
interface FakeMessage {
  message: { customType: string; content: string };
  customRenderer: unknown;
  /** What `rebuild()` stored: Pi renders THIS on every frame, it does not re-call the renderer. */
  component: unknown;
  expanded: boolean;
  /** Pi's own default box, present on a real component from construction. */
  box?: { padding?: number; render(width: number): readonly string[]; setPaddingX?(padding: number): void };
  outputPad?: number;
  rendererCalls: number;
  invalidations: number;
  rebuilds: number;
  rebuild(): void;
  invalidate(): void;
  setExpanded(expanded: boolean): void;
  render(width: number): readonly string[];
}

function fakeCustomMessage(
  customType: string,
  hostRows?: (message: unknown, options: unknown) => readonly string[],
): FakeMessage {
  const child: FakeMessage = {
    message: { customType, content: "hello" },
    customRenderer:
      hostRows === undefined
        ? undefined
        : (message: unknown, options: unknown) => ({
            render: (width: number): readonly string[] =>
              hostRows(message, options).map((row) => `${row}@${width}`),
          }),
    component: undefined,
    expanded: false,
    rendererCalls: 0,
    invalidations: 0,
    rebuilds: 0,
    // Exactly Pi: the renderer is invoked as a MEMBER, once per rebuild.
    rebuild(): void {
      child.rebuilds += 1;
      child.rendererCalls += 1;
      child.component =
        typeof child.customRenderer === "function"
          ? (child.customRenderer as (m: unknown, o: unknown, t: unknown) => unknown).call(
              child,
              child.message,
              { expanded: child.expanded, outputPad: 1 },
              {},
            )
          : undefined;
    },
    invalidate(): void {
      child.invalidations += 1;
      child.rebuild();
    },
    setExpanded(expanded: boolean): void {
      if (child.expanded === expanded) return;
      child.expanded = expanded;
      child.rebuild();
    },
    render(width: number): readonly string[] {
      const component = child.component;
      if (component !== undefined) {
        return (component as { render(width: number): readonly string[] }).render(width);
      }
      return [`[${customType}] pi's own box@${width}`];
    },
  };
  child.rebuild();
  return child;
}

const container = (children: unknown[]): { children: unknown[] } => ({ children });

const design = (
  extra: Partial<MessageDesignRegistration> = {},
): MessageDesignRegistration => ({
  customType: TYPE,
  id: "loon.budget",
  label: "budget",
  apply: (lines: readonly string[]) => [...lines, "design row"],
  ...extra,
});

// ---------------------------------------------------------------------------------------------
// S4 — nobody claimed it: the pass is invisible
// ---------------------------------------------------------------------------------------------

test("S4: a message of a type nobody claimed is left exactly as it was", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  const before = child.customRenderer;

  const result = adoptCustomMessages(container([child]));

  assert.equal(result.scanned, 0, "no claim anywhere: not one child is looked at");
  assert.equal(result.adopted, 0);
  assert.equal(child.customRenderer, before, "the host's renderer, untouched");
  assert.equal(child.invalidations, 0, "and nothing rebuilt: no work, no bytes changed");
});

test("S4: a child that is not a custom message is not ours to touch", () => {
  // Something IS claimed, so the pass really walks the children; the strangers stay strangers.
  registerMessageDesign(design());
  const stranger = { render: () => ["rows"], toolName: "bash" };
  const result = adoptCustomMessages(container([stranger, 42, null]));

  assert.equal(result.scanned, 3);
  assert.equal(result.ignored, 3);
  assert.equal(result.adopted, 0);
});

test("S4: a container that is not a container is answered, never thrown at", () => {
  for (const notAContainer of [undefined, null, 42, {}, { children: "nope" }]) {
    assert.doesNotThrow(() => adoptCustomMessages(notAContainer));
    assert.equal(adoptCustomMessages(notAContainer).scanned, 0);
  }
});

// ---------------------------------------------------------------------------------------------
// S3 — a host-rendered type: the frame stays, the rows change
// ---------------------------------------------------------------------------------------------

test("S3: the first pass installs the design renderer and rebuilds the message ONCE", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());

  const result = adoptCustomMessages(container([child]));

  assert.equal(result.adopted, 1);
  assert.equal(child.invalidations, 1, "one rebuild, so the stored renderer is re-resolved");
  assert.notEqual(child.customRenderer, undefined, "the design renderer is in place");
});

test("S3: the second pass adopts nothing and rebuilds nothing", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());

  adoptCustomMessages(container([child]));
  const afterFirst = child.customRenderer;
  const result = adoptCustomMessages(container([child]));

  assert.equal(result.already, 1);
  assert.equal(result.adopted, 0);
  assert.equal(child.customRenderer, afterFirst, "the same renderer, not a second wrapper");
  assert.equal(child.invalidations, 1, "and no second rebuild");
});

test("S3: with `default` selected the host's own frame is drawn, byte for byte", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());
  adoptCustomMessages(container([child]));

  assert.deepEqual(child.render(40), ["host frame@40"], "exactly what Pi drew before the bridge");
});

test("S3: a selected design receives the host's rows at the message's width and returns the rest", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());
  setMessageDesignSelection(TYPE, "loon.budget");
  adoptCustomMessages(container([child]));

  assert.deepEqual(child.render(40), ["host frame@40", "design row"]);
  assert.deepEqual(child.render(72), ["host frame@72", "design row"], "the width is read per pass");
});

test("S3: choosing a design AFTER the message was drawn reaches it on the next pass", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());
  adoptCustomMessages(container([child]));
  assert.deepEqual(child.render(40), ["host frame@40"]);

  // The user picks the design: the action repaints, the pass sees the new selection, and the message
  // is rebuilt onto the design renderer. The reused raw host component could never draw it.
  setMessageDesignSelection(TYPE, "loon.budget");
  adoptCustomMessages(container([child]));
  assert.deepEqual(child.render(40), ["host frame@40", "design row"]);
});

test("S3: going back to `default` restores Pi's own output on the next rebuild", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());
  setMessageDesignSelection(TYPE, "loon.budget");
  adoptCustomMessages(container([child]));
  assert.deepEqual(child.render(40), ["host frame@40", "design row"]);

  // `default` with a host renderer needs no rebuild: the component reads the live selection.
  setMessageDesignSelection(TYPE, "native");
  adoptCustomMessages(container([child]));
  assert.deepEqual(child.render(40), ["host frame@40"]);
});

// ---------------------------------------------------------------------------------------------
// A child the pass cannot adopt is reported, never thrown at
// ---------------------------------------------------------------------------------------------

test("S3: a message whose renderer cannot be replaced is reported and left alone", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());
  Object.defineProperty(child, "customRenderer", {
    get: () => undefined,
    set: () => {
      // A host that refuses the assignment without throwing.
    },
    configurable: true,
  });

  const result = adoptCustomMessages(container([child]));

  assert.equal(result.failed, 1);
  assert.equal(
    getMessageDesignFailures().some((failure) => failure.customType === TYPE),
    true,
    "reported through the design bus's one failure channel",
  );
});

test("S3: `render` on an adopted message answers rows for a host renderer that returns nothing", () => {
  const child = fakeCustomMessage(TYPE);
  registerMessageDesign(design({ apply: () => ["own box"] }));
  setMessageDesignSelection(TYPE, "loon.budget");
  adoptCustomMessages(container([child]));

  assert.deepEqual(child.render(30), ["own box"], "a design without host rows still draws");
});

test("S2: the two motivating types are adopted only when a design claims them", () => {
  const budget = fakeCustomMessage(TYPE);
  const reminder = fakeCustomMessage(REMINDER);
  registerMessageDesign({
    line: "gentle pi",
    types: [TYPE, REMINDER],
    id: "loon.panel",
    label: "panel",
    apply: () => ["panel"],
  });

  const result = adoptCustomMessages(container([budget, reminder]));

  assert.equal(result.adopted, 2, "one line, two messages, one pass");
});

// ---------------------------------------------------------------------------------------------
// S2 — a type with NO host renderer: the design owns the box
// ---------------------------------------------------------------------------------------------

test("S2: the design draws the whole box, and `default` gives Pi's own box back after ONE rebuild", () => {
  // A customType written by an extension that renders nothing: `customRenderer` is undefined, so
  // without a design Pi draws its default `[type]` box. This is the motivating case (S2).
  const child = fakeCustomMessage(REMINDER);
  registerMessageDesign({
    customType: REMINDER,
    id: "loon.reminder",
    label: "reminder",
    apply: () => ["╭─ reminder ─╮", "│ settle    │", "╰───────────╯"],
  });
  setMessageDesignSelection(REMINDER, "loon.reminder");

  adoptCustomMessages(container([child]));
  assert.equal(child.invalidations, 1, "the first adoption rebuilds the message");
  assert.deepEqual(child.render(40), ["╭─ reminder ─╮", "│ settle    │", "╰───────────╯"], "the design owns the box");

  // The user goes back to `default`: the renderer must answer `undefined` again so Pi draws its box,
  // which is a different ANSWER from the same renderer, so exactly one rebuild happens.
  setMessageDesignSelection(REMINDER, "native");
  const pass = adoptCustomMessages(container([child]));
  assert.equal(pass.already, 1);
  assert.equal(child.invalidations, 2, "one more rebuild, never two");
  assert.deepEqual(child.render(40), [`[${REMINDER}] pi's own box@40`], "Pi's box, byte for byte");

  // And back again, still one rebuild per switch.
  setMessageDesignSelection(REMINDER, "loon.reminder");
  adoptCustomMessages(container([child]));
  assert.equal(child.invalidations, 3);
  assert.deepEqual(child.render(40)[0], "╭─ reminder ─╮");
});

test("S2: the design reads `ctx.cardStyle`, so the consumer's painter knows which frame to draw", () => {
  registerCardStyle({
    id: "loon.lunar",
    label: "lunar",
    frame: {
      top: () => "top",
      line: (line) => line.text,
      bottom: () => "bottom",
    },
  });
  setCardStyleSelection("loon.lunar");

  let seen: unknown;
  const child = fakeCustomMessage(REMINDER);
  registerMessageDesign({
    customType: REMINDER,
    id: "loon.reminder",
    label: "reminder",
    apply: (lines: readonly string[], ctx) => {
      seen = ctx.cardStyle;
      return [`painted ${lines.length}`];
    },
  });
  setMessageDesignSelection(REMINDER, "loon.reminder");

  adoptCustomMessages(container([child]));
  assert.deepEqual(
    child.render(40),
    ["painted 3"],
    "the message body's own rows: label, spacer, content",
  );
  const style = seen as { kind: string; style?: { id: string } };
  assert.equal(style.kind, "style", "the bridge's own Card style selection, the one a tool design reads");
  assert.equal(style.style?.id, "loon.lunar", "and the exact style the user chose");
});

test("S2: own-the-box works for ANY custom type, not just the two Pi ships today", () => {
  // Nothing in the bridge knows this type: no host renderer, no Pi component, no list. A design still
  // claims it and owns the box, which is the capability a consumer registers for its own messages.
  const TYPE = "loon.custom-note";
  const child = fakeCustomMessage(TYPE);
  registerMessageDesign({
    customType: TYPE,
    id: "loon.note",
    label: "note",
    apply: (_lines: readonly string[], ctx) => [
      `╭─ ${ctx.customType} @${ctx.width} ─╮`,
      `│ ${String((ctx.render.message as { content: string }).content)} │`,
      "╰─────────╯",
    ],
  });
  setMessageDesignSelection(TYPE, "loon.note");

  adoptCustomMessages(container([child]));

  assert.deepEqual(child.render(30), [
    "╭─ loon.custom-note @30 ─╮",
    "│ hello │",
    "╰─────────╯",
  ]);
});

// ---------------------------------------------------------------------------------------------
// The verifier's reproduced defects (T6). Each test below FAILED against the slice before the fix.
// ---------------------------------------------------------------------------------------------

test("S4: with no claim anywhere, a pass reads no child at all", () => {
  // S4 is a cost bound too, not only an output one: the pass must be able to answer before it
  // touches a single message. A session with no message design pays nothing per conversation frame.
  let reads = 0;
  const child = fakeCustomMessage(TYPE);
  Object.defineProperty(child, "message", {
    get: () => {
      reads += 1;
      return { customType: TYPE, content: "hello" };
    },
    configurable: true,
  });

  const result = adoptCustomMessages(container([child, fakeCustomMessage(REMINDER)]));

  assert.equal(reads, 0, "no claim, no read");
  assert.equal(result.adopted, 0);
});

test("S3: a host renderer that is a METHOD keeps its `this`, as Pi calls it", () => {
  const child = fakeCustomMessage(TYPE);
  let seenThis: unknown;
  child.customRenderer = function (this: unknown): unknown {
    seenThis = this;
    return { render: (): readonly string[] => ["host frame"] };
  };
  registerMessageDesign(design({ apply: (lines: readonly string[]) => [...lines] }));
  setMessageDesignSelection(TYPE, "loon.budget");

  adoptCustomMessages(container([child]));
  child.render(40);

  assert.equal(seenThis, child, "the component Pi would have passed as `this`");
});

test("S3: with a host renderer, switching to `default` rebuilds nothing", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());
  setMessageDesignSelection(TYPE, "loon.budget");
  adoptCustomMessages(container([child]));
  assert.equal(child.invalidations, 1, "the adoption itself");

  setMessageDesignSelection(TYPE, "native");
  const pass = adoptCustomMessages(container([child]));

  assert.equal(pass.already, 1);
  assert.equal(
    child.invalidations,
    1,
    "the renderer reads the live selection, so a host-backed switch needs no rebuild",
  );
  assert.deepEqual(child.render(40), ["host frame@40"]);
});

test("S3: a component that cannot be marked is never half-adopted, so passes cannot stack", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  const original = child.customRenderer;
  registerMessageDesign(design());
  // A real Pi component this pass may not add an own symbol to: sealing it must be discovered
  // BEFORE the renderer is replaced, or every pass wraps the same message again.
  Object.preventExtensions(child);

  const first = adoptCustomMessages(container([child]));
  const second = adoptCustomMessages(container([child]));

  assert.equal(first.failed, 1);
  assert.equal(second.failed, 1, "still refused, never silently adopted twice");
  assert.equal(child.customRenderer, original, "the host's renderer was never replaced");
});

test("S4: disposing the last design restores the host's renderer and stops paying per pass", () => {
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  const original = child.customRenderer;
  const dispose = registerMessageDesign(design());
  setMessageDesignSelection(TYPE, "loon.budget");
  adoptCustomMessages(container([child]));
  assert.notEqual(child.customRenderer, original, "adopted");

  dispose();
  adoptCustomMessages(container([child]));

  assert.equal(child.customRenderer, original, "the host's renderer, back in place");
  assert.deepEqual(child.render(40), ["host frame@40"]);

  resetMessageDesignSelectionReads();
  child.render(40);
  assert.equal(
    getMessageDesignSelectionReads(),
    0,
    "no live claim: a render must not read the store any more",
  );
});

test("S3: a failing design on a HOST-rendered message keeps the host's own frame", () => {
  // The design was only ever allowed to rewrite the host's rows, so its failure must leave exactly
  // those rows — not Pi's box, which this message never drew.
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(
    design({
      apply: () => {
        throw new Error("boom");
      },
    }),
  );
  setMessageDesignSelection(TYPE, "loon.budget");
  adoptCustomMessages(container([child]));

  assert.deepEqual(child.render(40), ["host frame@40"], "the host's frame, untouched");
});

test("S3: an external rebuild at `default` does not strand the design", () => {
  // Pi rebuilds on its own (`setExpanded`, a session switch, a reload) and calls the renderer with
  // whatever is selected then. A record that still believed a design was mounted would leave the
  // message on the raw host component and no design could ever reach it again.
  const child = fakeCustomMessage(TYPE, () => ["host frame"]);
  registerMessageDesign(design());
  setMessageDesignSelection(TYPE, "loon.budget");
  adoptCustomMessages(container([child]));
  assert.deepEqual(child.render(40), ["host frame@40", "design row"]);

  setMessageDesignSelection(TYPE, "native");
  adoptCustomMessages(container([child]));
  child.setExpanded(true); // Pi's own rebuild, at `default`
  assert.deepEqual(child.render(40), ["host frame@40"]);

  setMessageDesignSelection(TYPE, "loon.budget");
  adoptCustomMessages(container([child]));
  assert.deepEqual(child.render(40), ["host frame@40", "design row"], "the design draws again");
});

test("S4: a message the host removed stops closing the fast path", () => {
  const child = fakeCustomMessage(TYPE);
  const frame = container([child]);
  const drop = registerMessageDesign(design());
  setMessageDesignSelection(TYPE, "loon.budget");
  adoptCustomMessages(frame);

  // The host drops the message before anybody disposes the design: the container the message was
  // adopted in is the only one that may conclude it is gone.
  frame.children.length = 0;
  adoptCustomMessages(frame);
  drop();

  let reads = 0;
  const other = fakeCustomMessage(REMINDER);
  Object.defineProperty(other, "message", {
    get: () => {
      reads += 1;
      return { customType: REMINDER, content: "hello" };
    },
    configurable: true,
  });
  adoptCustomMessages(container([other]));

  assert.equal(reads, 0, "nothing claimed and nothing mounted: no child is read again");
});

test("S2: the fallback box carries the message's CURRENT output padding", () => {
  // Pi applies padding to its default box only on its own default path, which a design bypasses. After
  // `setOutputPad(4)` the box still holds the padding it was born with, so a failing design that
  // rendered it as-is would answer a frame indented to a setting nobody has any more.
  const child = fakeCustomMessage(REMINDER);
  child.outputPad = 4;
  child.box = {
    padding: 2,
    setPaddingX(this: { padding: number }, padding: number): void {
      this.padding = padding;
    },
    render(this: { padding: number }): readonly string[] {
      return [`pad ${this.padding}`];
    },
  };
  registerMessageDesign({
    customType: REMINDER,
    id: "loon.reminder",
    label: "reminder",
    apply: () => {
      throw new Error("boom");
    },
  });
  setMessageDesignSelection(REMINDER, "loon.reminder");
  adoptCustomMessages(container([child]));

  assert.deepEqual(child.render(40), ["pad 4"], "the frame that failed shows the box at the padding NOW");
  // And then Pi draws its own box: the failed design is not retried while it is the selected one, which
  // is what lets Pi run the default path that POPULATES the box for the rest of the session.
  assert.deepEqual(child.render(40), [`[${REMINDER}] pi's own box@40`], "Pi's own next frame");
});
