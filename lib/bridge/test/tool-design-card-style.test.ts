/**
 * S22/T43 — a design can read the ACTIVE card style.
 *
 * `bash` is drawn by gentle-shell's own host renderers, so `float`/`neon` reaches it there
 * (`lib/card-style-policy.ts` → `cardStyle()`). A tool registered by another extension —
 * `bash_background`, `monitor`, `job_stop`, `job_list` — has no host card at all, so it never follows
 * the style: the only way to decorate it from here is a tool DESIGN, and a design that wants to
 * honour the user's selection has to be able to SEE it.
 *
 * `ctx` therefore carries the resolved selection, under the same three answers the bridge itself
 * degrades from: `native` (nobody chose a style), `style` (the live registration), `missing` (a style
 * that was disposed while it was selected — a `/reload`, an unloaded plugin). The field is additive
 * and resolved ON ACCESS, at most once per pass: a design that never reads it draws exactly the rows
 * it drew before the field existed, and pays nothing for it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerCardStyle, resetBusForTests, resetCardStylesForTests } from "../src/bus.ts";
import { setCardStyleSelection } from "../src/card-styles.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import { resetCardStyleTransformForTests } from "../src/card-style-transform.ts";
import {
  disableCardStyleTransform,
  resetCardStyleWiringForTests,
} from "../src/card-style-wiring.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resolveCardStyleSelection, type CardStyleSelection } from "../src/index.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetPluginLinesForTests } from "../src/plugin-lines.ts";
import { resetRepaintForTests } from "../src/repaint.ts";
import { isRecord, resetRowBuildStateForTests } from "../src/rows.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import {
  adoptToolCards,
  resetToolDesignAdoptionForTests,
} from "../src/tool-design-adoption.ts";
import {
  registerToolDesign,
  resetToolDesignsForTests,
  setToolDesignSelection,
} from "../src/tool-designs.ts";
import { resetToolDesignWiringForTests } from "../src/tool-design-wiring.ts";
import type { CardStyleRegistration, ToolDesignContext } from "../src/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-tool-design-card-style-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  // The selection is a real file: every test starts from nothing on disk.
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetBusForTests();
  resetCardStylesForTests();
  resetToolDesignsForTests();
  resetToolDesignWiringForTests();
  resetToolDesignAdoptionForTests();
  resetRepaintForTests();
  resetStoreStateForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
  resetRowBuildStateForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetCardStyleTransformForTests();
  resetCardStyleWiringForTests();
  disableCardStyleTransform();
  disableCaptureBackend();
});

test.afterEach(disableCaptureBackend);

const THEME = { name: "fake-theme" };

/** The four rows the host's quiet bash card draws, ANSI and padding included. */
const BASH_CARD = [
  "╭─ ✿ bash card ───────────── ctrl+o ╮",
  "│ \u001b[36m$ ls -la\u001b[0m                ",
  "│ total 4                           ",
  "╰───────────────────────────────────╯",
];

const DESIGN_ID = "loon.card-style-probe";

const frame = () => ({
  top: (ctx: { width: number }) => "─".repeat(ctx.width),
  line: (ctx: { text: string }) => ctx.text,
  bottom: (ctx: { width: number }) => "─".repeat(ctx.width),
});

const style = (id: string): CardStyleRegistration => ({ id, label: id, frame: frame() });

/** The renderers the host builds for bash: a toolDefinition-shaped object, one component each. */
function bashRenderers(): { renderShell: string; renderCall: unknown; renderResult: unknown } {
  return {
    renderShell: "default",
    renderCall: () => ({ render: (_width: number) => [...BASH_CARD] }),
    renderResult: () => ({ render: (_width: number) => ["╭─ ✿ bash ─╮", "│ done", "╰──────────╯"] }),
  };
}

interface FakeCard {
  toolName?: unknown;
  toolDefinition?: unknown;
  component?: { render(width: number): string[] };
  updateDisplay(): void;
  invalidate(): void;
  render(width: number): string[];
}

/** A `ToolExecutionComponent`-shaped card: `render()` draws what `renderCall` last built. */
function mountCard(toolDefinition: unknown): FakeCard {
  const card: FakeCard = {
    toolName: "bash",
    toolDefinition,
    updateDisplay(): void {
      const renderCall = isRecord(card.toolDefinition) ? card.toolDefinition.renderCall : undefined;
      // SAFETY: the host's `renderCall` is `(args, theme, ctx) => Component`; the test needs the
      // component it answers.
      card.component =
        typeof renderCall === "function"
          ? (renderCall as (...args: unknown[]) => { render(width: number): string[] })(
              { command: "ls -la" },
              THEME,
              { args: {} },
            )
          : undefined;
    },
    invalidate(): void {
      card.updateDisplay();
    },
    render(width: number): string[] {
      return card.component === undefined ? [] : card.component.render(width);
    },
  };
  card.updateDisplay();
  return card;
}

/** Register a design that records the `cardStyle` of every pass, and select it for `bash`. */
const adoptWithProbe = (): { card: FakeCard; seen: Array<CardStyleSelection | undefined> } => {
  const seen: Array<CardStyleSelection | undefined> = [];
  registerToolDesign({
    tool: "bash",
    id: DESIGN_ID,
    label: "card style probe",
    apply(lines: readonly string[], ctx: ToolDesignContext): string[] {
      seen.push(ctx.cardStyle);
      return [...lines];
    },
  });
  setToolDesignSelection("bash", DESIGN_ID);
  const card = mountCard(bashRenderers());
  assert.equal(adoptToolCards({ children: [card] }).adopted, 1, "the host's card is wrapped");
  return { card, seen };
};

// ---------------------------------------------------------------------------------------------
// The three answers
// ---------------------------------------------------------------------------------------------

test("S22/T43: the design context carries the ACTIVE card style", () => {
  registerCardStyle(style("loon.neon-ish"));
  setCardStyleSelection("loon.neon-ish");
  const { card, seen } = adoptWithProbe();

  card.render(80);

  assert.equal(seen.length, 1, "the design ran once, on one pass");
  const answer = seen[0];
  assert.ok(answer !== undefined, "the context carries `cardStyle` at all");
  assert.equal(answer.kind, "style");
  if (answer.kind !== "style") return;
  assert.equal(answer.style.id, "loon.neon-ish", "the style the user selected");
});

test("S22/T43: with nothing selected the answer is `native`", () => {
  const { card, seen } = adoptWithProbe();

  card.render(80);

  assert.deepEqual(seen[0], { kind: "native" }, "no style chosen is a first-class answer");
});

test("S22/T43: a style disposed while it was selected answers `missing`", () => {
  const dispose = registerCardStyle(style("loon.doomed"));
  setCardStyleSelection("loon.doomed");
  dispose();
  const { card, seen } = adoptWithProbe();

  card.render(80);

  assert.deepEqual(
    seen[0],
    { kind: "missing", id: "loon.doomed" },
    "the bridge degrades to native and SAYS which id went missing, instead of throwing",
  );
});

// ---------------------------------------------------------------------------------------------
// Additive: the rows cannot change for a design that ignores the field
// ---------------------------------------------------------------------------------------------

test("S22/T43: a design that never reads `cardStyle` draws the same bytes with a style selected", () => {
  registerCardStyle(style("loon.neon-ish"));
  setCardStyleSelection("loon.neon-ish");
  registerToolDesign({
    tool: "bash",
    id: "loon.bash-heading",
    label: "bash heading",
    // The design of §14, unchanged: it rewrites the heading mark and nothing else.
    apply: (lines: readonly string[]): string[] =>
      lines.map((line) => (line.includes("$ ") ? line.replace("$ ", "bash ") : line)),
  });
  setToolDesignSelection("bash", "loon.bash-heading");

  const card = mountCard(bashRenderers());
  adoptToolCards({ children: [card] });

  assert.deepEqual(
    card.render(80),
    [
      BASH_CARD[0],
      BASH_CARD[1].replace("$ ", "bash "),
      BASH_CARD[2],
      BASH_CARD[3],
    ],
    "byte for byte what the design drew before the field existed",
  );
});

// ---------------------------------------------------------------------------------------------
// Live, and ONE answer per pass
// ---------------------------------------------------------------------------------------------

test("S22/T43: the style is read on every pass, so a switch reaches a card already on screen", () => {
  registerCardStyle(style("loon.first"));
  registerCardStyle(style("loon.second"));
  setCardStyleSelection("loon.first");
  const { card, seen } = adoptWithProbe();

  card.render(80);
  setCardStyleSelection("loon.second");
  card.render(80);

  const ids = seen.map((answer) => (answer?.kind === "style" ? answer.style.id : answer?.kind));
  assert.deepEqual(ids, ["loon.first", "loon.second"], "no capture at resolution: the pass reads live");
});

test("S22/T43: one pass answers ONE style, even if the selection changes mid-pass", () => {
  registerCardStyle(style("loon.first"));
  registerCardStyle(style("loon.second"));
  setCardStyleSelection("loon.first");
  const answers: Array<CardStyleSelection | undefined> = [];
  registerToolDesign({
    tool: "bash",
    id: DESIGN_ID,
    label: "card style probe",
    apply(lines: readonly string[], ctx: ToolDesignContext): string[] {
      const first = ctx.cardStyle;
      // A switch landing BETWEEN two reads of the same pass (a row action, a keypress) must not
      // produce a card that is half of each: the bridge resolves the pass's answer once.
      setCardStyleSelection("loon.second");
      answers.push(first, ctx.cardStyle);
      return [...lines];
    },
  });
  setToolDesignSelection("bash", DESIGN_ID);
  const card = mountCard(bashRenderers());
  adoptToolCards({ children: [card] });

  card.render(80);

  const ids = answers.map((answer) => (answer?.kind === "style" ? answer.style.id : answer?.kind));
  assert.deepEqual(ids, ["loon.first", "loon.first"], "both reads answered from one resolution");
});

// ---------------------------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------------------------

test("S22/T43: a plugin reads the same answer outside the context, from the package entry", () => {
  registerCardStyle(style("loon.neon-ish"));
  setCardStyleSelection("loon.neon-ish");

  const answer = resolveCardStyleSelection();

  assert.equal(typeof resolveCardStyleSelection, "function", "the entry exports the resolver");
  assert.equal(answer.kind, "style");
  if (answer.kind !== "style") return;
  assert.equal(answer.style.id, "loon.neon-ish");
  assert.deepEqual(answer, resolveCardStyleSelection(), "and it is the same answer, read twice");
});
