/**
 * T2 — the renderer policy for a claimed custom message, asserted without a host (S3, S4).
 *
 * `./message-design-wiring.ts` is the whole rule: the host's renderer runs first, and only its ROWS
 * ever reach a design. This file drives it with a fake host renderer, so the three cases are pinned
 * by themselves: a type with a host renderer (rows in, rows out), a type with none (the design owns
 * the box), and a type nobody claimed (the host's answer, byte for byte, including `undefined`).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveCardStyleSelection } from "../src/card-styles.ts";
import {
  getMessageDesignFailures,
  registerMessageDesign,
  resetMessageDesignsForTests,
  setMessageDesignSelection,
} from "../src/message-designs.ts";
import { messageDesignRenderer } from "../src/message-design-wiring.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { MessageDesignContext, MessageDesignRegistration } from "../src/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-message-wiring-"));
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
  resetStoreStateForTests();
});

const TYPE = "gentle-pi.exploration-budget";
const REMINDER = "gentle-pi.verifier-settle-reminder";

/** A host component: it answers the rows it was built with, tagged with the width it was asked for. */
const hostComponent = (rows: readonly string[]) => ({
  render: (width: number): readonly string[] => rows.map((row) => `${row}@${width}`),
});

const hostRendererFor = (rows: readonly string[]) => {
  const component = hostComponent(rows);
  return {
    component,
    renderer: (message: unknown, options: unknown, theme?: unknown): unknown => {
      void message;
      void options;
      void theme;
      return component;
    },
  };
};

const design = (
  extra: Partial<MessageDesignRegistration> = {},
): MessageDesignRegistration => ({
  customType: TYPE,
  id: "loon.budget",
  label: "budget",
  apply: (lines: readonly string[]) => [...lines],
  ...extra,
});

const options = { expanded: false, outputPad: 1 };

// ---------------------------------------------------------------------------------------------
// S4 — nobody claimed the type
// ---------------------------------------------------------------------------------------------

test("S4: a type with no design hands the host's own component back by identity", () => {
  const host = hostRendererFor(["host frame"]);
  const renderer = messageDesignRenderer(TYPE, host.renderer);

  const built = renderer({ customType: TYPE }, options, {});

  assert.equal(built, host.component, "the host's component, not a copy and not a wrapper");
  assert.deepEqual(
    (built as { render(width: number): readonly string[] }).render(40),
    ["host frame@40"],
    "and it draws exactly what it drew before the bridge existed",
  );
});

test("S4: a type with no design AND no host renderer answers `undefined` — Pi's own box", () => {
  const renderer = messageDesignRenderer(TYPE, undefined);
  assert.equal(renderer({ customType: TYPE }, options, {}), undefined, "the host's default box");
});

test("S4: resolving no design costs ONE store read per build", () => {
  const renderer = messageDesignRenderer(TYPE, undefined);
  const before = getMessageDesignFailures().length;
  renderer({ customType: TYPE }, options, {});
  assert.equal(getMessageDesignFailures().length, before, "no failure is invented for a quiet type");
});

// ---------------------------------------------------------------------------------------------
// S3 — a type WITH a host renderer: rows in, rows out, the frame stays the host's
// ---------------------------------------------------------------------------------------------

test("S3: the design receives the host's rows AT the host's width, and returns the rows to draw", () => {
  registerMessageDesign(
    design({
      apply: (lines: readonly string[], ctx: MessageDesignContext) => [
        ...lines,
        `design ${ctx.customType} ${ctx.width}`,
      ],
    }),
  );
  setMessageDesignSelection(TYPE, "loon.budget");

  const host = hostRendererFor(["host frame"]);
  const renderer = messageDesignRenderer(TYPE, host.renderer);
  const component = renderer({ customType: TYPE }, options, {}) as {
    render(width: number): readonly string[];
  };

  assert.deepEqual(component.render(40), ["host frame@40", "design gentle-pi.exploration-budget 40"]);
});

test("S3: the design gets a COPY of the host's rows, so a mutation cannot corrupt the frame", () => {
  registerMessageDesign(
    design({
      apply: (lines: string[]) => {
        lines.push("mutated");
        return lines;
      },
    }),
  );
  setMessageDesignSelection(TYPE, "loon.budget");

  const host = hostRendererFor(["host frame"]);
  const component = messageDesignRenderer(TYPE, host.renderer)(
    { customType: TYPE },
    options,
    {},
  ) as { render(width: number): readonly string[] };

  assert.deepEqual(component.render(10), ["host frame@10", "mutated"]);
  assert.deepEqual(
    hostComponent(["host frame"]).render(10),
    ["host frame@10"],
    "the host's own component still answers its own rows",
  );
});

test("S3: a design that throws leaves the host's rows on screen and is reported", () => {
  registerMessageDesign(
    design({
      apply: () => {
        throw new Error("kaboom");
      },
    }),
  );
  setMessageDesignSelection(TYPE, "loon.budget");

  const host = hostRendererFor(["host frame"]);
  const component = messageDesignRenderer(TYPE, host.renderer)(
    { customType: TYPE },
    options,
    {},
  ) as { render(width: number): readonly string[] };

  assert.deepEqual(component.render(20), ["host frame@20"], "the host's frame, untouched");
  assert.deepEqual(
    getMessageDesignFailures().map((failure) => failure.message),
    ["kaboom"],
    "and one failure recorded",
  );
});

test("S3: a design that returns something other than rows loses its own output only", () => {
  registerMessageDesign(
    design({ apply: (() => "not rows") as unknown as MessageDesignRegistration["apply"] }),
  );
  setMessageDesignSelection(TYPE, "loon.budget");

  const host = hostRendererFor(["host frame"]);
  const component = messageDesignRenderer(TYPE, host.renderer)(
    { customType: TYPE },
    options,
    {},
  ) as { render(width: number): readonly string[] };

  assert.deepEqual(component.render(20), ["host frame@20"]);
  assert.equal(getMessageDesignFailures().length, 1, "reported, not swallowed");
});

// ---------------------------------------------------------------------------------------------
// The live selection and the context
// ---------------------------------------------------------------------------------------------

test("S1: the selection is read on EVERY pass, so a switch reaches a component already mounted", () => {
  registerMessageDesign(design());
  const host = hostRendererFor(["host frame"]);
  setMessageDesignSelection(TYPE, "loon.budget");

  const component = messageDesignRenderer(TYPE, host.renderer)(
    { customType: TYPE },
    options,
    {},
  ) as { render(width: number): readonly string[] };
  assert.deepEqual(component.render(30), ["host frame@30"]);

  // The user picks `default` AFTER the component was built: the next pass is the host's own rows.
  setMessageDesignSelection(TYPE, "native");
  assert.deepEqual(component.render(30), ["host frame@30"]);

  // And a different design takes over on the very next pass.
  registerMessageDesign(design({ id: "loon.other", label: "other", apply: () => ["other"] }));
  setMessageDesignSelection(TYPE, "loon.other");
  assert.deepEqual(component.render(30), ["other"]);
});

test("S1: the context carries the width, the type, Pi's options and the message by reference", () => {
  let seen: MessageDesignContext | undefined;
  registerMessageDesign(
    design({
      apply: (lines: readonly string[], ctx: MessageDesignContext) => {
        seen = ctx;
        return [...lines];
      },
    }),
  );
  setMessageDesignSelection(TYPE, "loon.budget");

  const message = { customType: TYPE, content: "hello" };
  const theme = { name: "theme" };
  const component = messageDesignRenderer(TYPE, hostRendererFor(["frame"]).renderer)(
    message,
    { expanded: true, outputPad: 2 },
    theme,
  ) as { render(width: number): readonly string[] };
  component.render(72);

  assert.equal(seen?.width, 72);
  assert.equal(seen?.customType, TYPE);
  assert.equal(seen?.theme, theme, "the host's object, forwarded");
  assert.equal(seen?.render.message, message, "the message by reference, never a clone");
  assert.equal(seen?.render.expanded, true);
  assert.equal(seen?.render.outputPad, 2);
});

test("S1: `cardStyle` is resolved on access, at most once per pass", () => {
  setMessageDesignSelection(TYPE, "loon.budget");

  let first: unknown;
  let second: unknown;
  registerMessageDesign(
    design({
      apply: (lines: readonly string[], ctx: MessageDesignContext) => {
        first = ctx.cardStyle;
        second = ctx.cardStyle;
        return [...lines];
      },
    }),
  );

  const component = messageDesignRenderer(TYPE, hostRendererFor(["frame"]).renderer)(
    { customType: TYPE },
    options,
    {},
  ) as { render(width: number): readonly string[] };
  component.render(10);

  assert.equal(first, second, "one answer per pass");
  assert.deepEqual(first, resolveCardStyleSelection(), "the same selection a tool design reads");
});

// ---------------------------------------------------------------------------------------------
// The second motivating type
// ---------------------------------------------------------------------------------------------

test("S2: a claimed type with NO host renderer is drawn by the design, not by default", () => {
  registerMessageDesign(
    design({
      customType: REMINDER,
      id: "loon.reminder",
      label: "reminder",
      apply: () => ["╭─ reminder ─╮", "│ settle    │", "╰───────────╯"],
    }),
  );
  setMessageDesignSelection(REMINDER, "loon.reminder");

  const component = messageDesignRenderer(REMINDER, undefined)(
    { customType: REMINDER },
    options,
    {},
  ) as { render(width: number): readonly string[] };

  assert.deepEqual(component.render(40), ["╭─ reminder ─╮", "│ settle    │", "╰───────────╯"]);
});

test("S2: a host-less type hands the design the message's own body rows, plainly", () => {
  const seen: Array<readonly string[]> = [];
  registerMessageDesign(
    design({
      customType: REMINDER,
      id: "loon.reminder",
      label: "reminder",
      apply: (lines: readonly string[]) => {
        seen.push(lines);
        return ["own box"];
      },
    }),
  );
  setMessageDesignSelection(REMINDER, "loon.reminder");

  const component = messageDesignRenderer(REMINDER, undefined)(
    { customType: REMINDER, content: "settle\nthe reminder" },
    options,
    {},
  ) as { render(width: number): readonly string[] };
  component.render(40);

  assert.deepEqual(
    seen,
    [[`[${REMINDER}]`, "", "settle", "the reminder"]],
    "the body and its label, plainly: the design owns the frame around them",
  );
});

test("S2: a failing own-the-box design leaves the message body on screen", () => {
  // The whole point of these messages is that the agent READS them: a design that throws must not
  // take the body with it. The rows it was handed are the fallback.
  registerMessageDesign(
    design({
      customType: REMINDER,
      id: "loon.reminder",
      label: "reminder",
      apply: () => {
        throw new Error("boom");
      },
    }),
  );
  setMessageDesignSelection(REMINDER, "loon.reminder");

  const component = messageDesignRenderer(REMINDER, undefined)(
    { customType: REMINDER, content: "the body the agent must read" },
    options,
    {},
  ) as { render(width: number): readonly string[] };

  const rows = component.render(40);
  assert.ok(rows.some((row) => row.includes(REMINDER)), "the type is still on screen");
  assert.ok(rows.some((row) => row.includes("the body the agent must read")), "and the body");
  assert.deepEqual(getMessageDesignFailures().map((failure) => failure.message), ["boom"]);
});
