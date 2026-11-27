/**
 * S10/T14 — the chain test that was missing: the host's resolver runs FIRST and answers bash
 * WITHOUT calling `next()`, so the bridge's resolver is never consulted.
 *
 * Pi composes resolvers in extension load order (`runner.js:550-553`) and offers no way to reorder
 * them (`loader.js:298-302` only pushes). In the user's install gentle-pi is package 0 and this
 * bridge is package 11, and gentle-pi's bash resolver answers `bash` without calling `next()`
 * (`extensions/quiet-tools.ts:910-914`). Every earlier test passed a fake `next()` that always
 * answered, so none of them could observe this.
 *
 * RED (observed before `src/tool-design-adoption.ts` existed): with the design selected, the card
 * still rendered the host's own rows —
 *
 *   [
 *     "╭─ ✿ bash card ───────────── ctrl+o ╮",
 *     "│ \u001b[36m$ ls -la\u001b[0m                ",
 *     "│ total 4                           ",
 *     "╰───────────────────────────────────╯",
 *   ]
 *
 * instead of the designed heading. That is the user's live report (L3): a selected design, a row
 * that says so, and every card still reading `$ …`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import { resetCardStyleTransformForTests } from "../src/card-style-transform.ts";
import {
  disableCardStyleTransform,
  installCardStyleTransform,
  resetCardStyleWiringForTests,
} from "../src/card-style-wiring.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetPluginLinesForTests } from "../src/plugin-lines.ts";
import { resetRepaintForTests } from "../src/repaint.ts";
import { isRecord, resetRowBuildStateForTests } from "../src/rows.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import {
  adoptToolCards,
  getToolDesignAdoptionDiagnostics,
  resetToolDesignAdoptionForTests,
} from "../src/tool-design-adoption.ts";
import {
  TOOL_DESIGN_NATIVE,
  getToolDesignFailures,
  registerToolDesign,
  resetToolDesignsForTests,
  setToolDesignLineSelection,
  setToolDesignSelection,
} from "../src/tool-designs.ts";
import {
  getToolDesignWiringDiagnostics,
  resetToolDesignWiringForTests,
  toolDesignResolver,
} from "../src/tool-design-wiring.ts";
import type { ToolDesignContext, ToolDesignRegistration } from "../src/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-tool-design-chain-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

const resetAll = (): void => {
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
};

test.beforeEach(resetAll);
test.afterEach(disableCaptureBackend);

const THEME = { name: "fake-theme", fg: (role: string, text: string) => `${role}:${text}` };

/** The four rows the host's quiet bash card draws, ANSI and padding included. */
const BASH_CARD = [
  "╭─ ✿ bash card ───────────── ctrl+o ╮",
  "│ \u001b[36m$ ls -la\u001b[0m                ",
  "│ total 4                           ",
  "╰───────────────────────────────────╯",
];

/** `BASH_CARD` with only the heading mark rewritten, i.e. what the design draws. */
const DESIGNED_BASH_CARD = [
  BASH_CARD[0],
  BASH_CARD[1].replace("$ ", "bash "),
  BASH_CARD[2],
  BASH_CARD[3],
];

const BASH_HEADING = "bash heading";

/** How many frames the design's `apply` actually saw: two wrappers would double this. */
let applied = 0;

const bashHeadingDesign: ToolDesignRegistration = {
  tool: "bash",
  id: "loon.bash-heading",
  label: BASH_HEADING,
  apply(lines: readonly string[], ctx: ToolDesignContext): string[] {
    applied += 1;
    assert.equal(ctx.tool, "bash");
    return lines.map((line) => (line.includes("$ ") ? line.replace("$ ", "bash ") : line));
  },
};

/** The renderers the host builds for bash: a toolDefinition-shaped object, one component each. */
function bashRenderers(): { renderShell: string; renderCall: unknown; renderResult: unknown } {
  return {
    renderShell: "default",
    renderCall: () => ({ render: (_width: number) => [...BASH_CARD] }),
    renderResult: () => ({ render: (_width: number) => ["╭─ ✿ bash ─╮", "│ done", "╰──────────╯"] }),
  };
}

/** Pi's resolver chain, exactly as `runner.js:550-553` builds it. */
type Resolver = (toolName: string, next: () => unknown) => unknown;

function resolveChain(resolvers: readonly Resolver[], toolName: string, base: () => unknown): unknown {
  const resolve = (index: number): unknown =>
    index < resolvers.length ? resolvers[index](toolName, () => resolve(index + 1)) : base();
  return resolve(0);
}

/** The host's quiet bash resolver: it answers bash itself and never calls `next()`. */
const hostQuietResolver: Resolver = (toolName, next) =>
  toolName === "bash" ? bashRenderers() : next();

/** The part of pi's `ToolExecutionComponent` this test models. */
interface FakeCard {
  toolName?: unknown;
  toolDefinition?: unknown;
  component?: { render(width: number): string[] };
  renders: number;
  invalidations: number;
  updateDisplay(): void;
  invalidate(): void;
  render(width: number): string[];
}

interface MountOptions {
  toolName?: unknown;
  toolDefinition?: unknown;
  invalidateThrows?: boolean;
}

/**
 * Mount a component shaped like pi's `ToolExecutionComponent`: it stores `toolDefinition`, its
 * `updateDisplay()` re-invokes the stored `renderCall`, `invalidate()` calls `updateDisplay()`, and
 * `render()` draws the component the last `updateDisplay()` built.
 */
function mountCard(options: MountOptions): FakeCard {
  const card: FakeCard = {
    toolName: options.toolName,
    toolDefinition: options.toolDefinition,
    renders: 0,
    invalidations: 0,
    updateDisplay(): void {
      const renderCall = isRecord(card.toolDefinition) ? card.toolDefinition.renderCall : undefined;
      // SAFETY: the host's `renderCall` is `(args, theme, ctx) => Component`; the test only needs
      // the component it answers.
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
      card.invalidations += 1;
      if (options.invalidateThrows === true) throw new Error("invalidate exploded");
      card.updateDisplay();
    },
    render(width: number): string[] {
      card.renders += 1;
      return card.component === undefined ? [] : card.component.render(width);
    },
  };
  card.updateDisplay();
  return card;
}

// ---------------------------------------------------------------------------------------------
// T14/T15 — the host resolves bash first; adoption is the path that still reaches the card
// ---------------------------------------------------------------------------------------------

test("S10/T14: a design reaches a card when a resolver ahead of the bridge answers bash", () => {
  registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", "loon.bash-heading");
  applied = 0;

  const bridgeCalls: string[] = [];
  const bridgeResolver: Resolver = (toolName, next) => {
    bridgeCalls.push(toolName);
    return toolDesignResolver(toolName, next as () => never);
  };

  const toolDefinition = resolveChain([hostQuietResolver, bridgeResolver], "bash", () => undefined);
  const card = mountCard({ toolName: "bash", toolDefinition });

  assert.deepEqual(bridgeCalls, [], "the bridge's resolver is never consulted — the defect");
  assert.deepEqual(card.render(80), BASH_CARD, "the host's own rows, before adoption");
  assert.equal(applied, 0, "no design has been applied yet");

  const result = adoptToolCards({ children: [card] });
  assert.deepEqual(
    result,
    { scanned: 1, adopted: 1, already: 0, ignored: 0, failed: 0 },
    "the card after construction is the one adopted",
  );

  // The SAME already-constructed component, not a fresh one: that is what "already drawn" means.
  assert.deepEqual(card.render(80), DESIGNED_BASH_CARD, "the selected design now reaches the card");
  assert.equal(applied, 1, "the design applied exactly once");

  // Selecting `native` restores the host's own bytes on the same component (S2).
  setToolDesignSelection("bash", TOOL_DESIGN_NATIVE);
  assert.deepEqual(card.render(80), BASH_CARD, "native restores the host's exact rows");
  assert.equal(applied, 1, "native applies no design at all");
});

test("S10/T15: the two paths cooperate — the resolver wraps once, adoption adds nothing", () => {
  registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", "loon.bash-heading");
  applied = 0;

  // The bridge is FIRST in the chain here, so its resolver wraps the host's renderers.
  const bridgeResolver: Resolver = (toolName, next) => toolDesignResolver(toolName, next as () => never);
  const toolDefinition = resolveChain([bridgeResolver, hostQuietResolver], "bash", () => undefined);
  const card = mountCard({ toolName: "bash", toolDefinition });

  // Marker on the renderers: the resolver path already wrapped, so adoption must not stack.
  const firstPass = adoptToolCards({ children: [card] });
  assert.deepEqual(
    firstPass,
    { scanned: 1, adopted: 0, already: 1, ignored: 0, failed: 0 },
    "an already-wrapped card is recognised, not wrapped again",
  );

  assert.deepEqual(card.render(80), DESIGNED_BASH_CARD, "the design reaches the card exactly once");
  assert.equal(applied, 1, "two wrappers would have applied the design twice");

  // A second adoption pass (a later frame) is still a no-op for that card.
  const secondPass = adoptToolCards({ children: [card] });
  assert.equal(secondPass.adopted, 0);
  assert.equal(secondPass.already, 1);
  card.render(80);
  assert.equal(applied, 2, "one apply per rendered frame, never two");
});

test("S10/T15: a card built after adoption is adopted on the next pass", () => {
  registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", "loon.bash-heading");

  const container = { children: [] as FakeCard[] };
  assert.deepEqual(adoptToolCards(container), {
    scanned: 0,
    adopted: 0,
    already: 0,
    ignored: 0,
    failed: 0,
  });

  // Pi builds a new card for a new tool call (the same renderers shape, a new component).
  const card = mountCard({ toolName: "bash", toolDefinition: bashRenderers() });
  container.children.push(card);
  assert.equal(adoptToolCards(container).adopted, 1);
  assert.deepEqual(card.render(80), DESIGNED_BASH_CARD, "the new child is adopted on its first pass");
});

test("S10/T15: the conversation render pass adopts BEFORE the host renders its children", () => {
  registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", "loon.bash-heading");

  // The host's conference component: a container whose children are tool cards, rendered in order.
  const chat = {
    children: [mountCard({ toolName: "bash", toolDefinition: bashRenderers() })],
    render(width: number): string[] {
      return this.children.flatMap((child) => child.render(width));
    },
  };
  const document = { children: [{ render: () => [] }, { render: () => [] }, chat] };

  assert.deepEqual(installCardStyleTransform({ children: [document] }), {
    installed: true,
    outcome: "wrapped",
    component: "chat",
  });

  // One host render: the wrapper adopts the card, then the host draws it in the selected design.
  assert.deepEqual(chat.render(80), DESIGNED_BASH_CARD);
  assert.deepEqual(getToolDesignAdoptionDiagnostics().adoptedCards, [{ tool: "bash", cards: 1 }]);
});

// ---------------------------------------------------------------------------------------------
// T15 — every absence is reported, none is a throw
// ---------------------------------------------------------------------------------------------

test("S10/T15: adoption ignores what is not a card of a tool with designs", () => {
  registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", "loon.bash-heading");

  const notACard = { children: "nope" };
  assert.deepEqual(adoptToolCards(notACard), {
    scanned: 0,
    adopted: 0,
    already: 0,
    ignored: 0,
    failed: 0,
  });
  assert.deepEqual(adoptToolCards(undefined).ignored, 0, "no container is not a failure");

  const result = adoptToolCards({
    children: [
      null,
      "row",
      { toolName: 42, toolDefinition: bashRenderers() },
      { toolName: "", toolDefinition: bashRenderers() },
      // A real tool with no registered design: never ours to touch.
      { toolName: "write", toolDefinition: bashRenderers() },
    ],
  });
  assert.deepEqual(result, { scanned: 5, adopted: 0, already: 0, ignored: 5, failed: 0 });
  assert.deepEqual(getToolDesignFailures(), [], "ignoring something is not a failure");
});

test("S10/T15: a missing or non-writable toolDefinition is reported, never thrown", () => {
  registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", "loon.bash-heading");

  const missing = mountCard({ toolName: "bash" });
  const missingResult = adoptToolCards({ children: [missing] });
  assert.equal(missingResult.failed, 1);
  assert.deepEqual(missing.render(80), [], "the host's own (empty) card is what the user sees");

  const locked = mountCard({ toolName: "bash", toolDefinition: bashRenderers() });
  Object.defineProperty(locked, "toolDefinition", {
    value: locked.toolDefinition,
    writable: false,
    configurable: true,
    enumerable: true,
  });
  const lockedResult = adoptToolCards({ children: [locked] });
  assert.equal(lockedResult.failed, 1, "a refused assignment is reported, not thrown");

  const failures = getToolDesignFailures();
  assert.equal(failures.length, 2, "one fact per distinct failure message");
  assert.ok(failures.every((failure) => failure.designId === "(adoption)"));
  assert.ok(failures.every((failure) => failure.tool === "bash"));
  assert.match(failures[0].message, /no toolDefinition/u);
  assert.match(failures[1].message, /toolDefinition/u);
});

test("S10/T15: a throwing invalidate is reported, and the wrapped card still draws the design", () => {
  registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", "loon.bash-heading");
  applied = 0;

  const card = mountCard({
    toolName: "bash",
    toolDefinition: bashRenderers(),
    invalidateThrows: true,
  });
  const result = adoptToolCards({ children: [card] });
  assert.equal(result.adopted, 1, "the definition was wrapped before the host's invalidate threw");
  assert.equal(result.failed, 0);

  const failures = getToolDesignFailures();
  assert.equal(failures.length, 1, "the host's own invalidate failure is reported once");
  assert.match(failures[0].message, /invalidate exploded/u);

  // The next pass reads the wrapped definition, so the design still reaches the card.
  card.component = undefined;
  card.updateDisplay();
  assert.deepEqual(card.render(80), DESIGNED_BASH_CARD);
  assert.equal(applied, 1);
});

// ---------------------------------------------------------------------------------------------
// T20/S12 — the part of the card, on the ADOPTION path
// ---------------------------------------------------------------------------------------------

test("S12/T20: the adoption path hands the design the part it is drawing, on both renderers", () => {
  const parts: string[] = [];
  registerToolDesign({
    ...bashHeadingDesign,
    id: "loon.part-probe",
    apply: (lines: readonly string[], ctx: ToolDesignContext): string[] => {
      parts.push(ctx.part);
      return [...lines];
    },
  });
  setToolDesignSelection("bash", "loon.part-probe");

  const card = mountCard({ toolName: "bash", toolDefinition: bashRenderers() });
  // Adoption wraps the stored definition; the design runs when the host RENDERS the component.
  assert.equal(adoptToolCards({ children: [card] }).adopted, 1);
  card.render(80);
  assert.deepEqual(parts, ["call"], "the adopted card's call renderer says `call`");

  card.render(80);
  assert.equal(parts.at(-1), "call", "every later call frame says `call` too");

  // The SAME adopted definition's result renderer says `result`: one wrapper, two parts.
  const renderResult = isRecord(card.toolDefinition) ? card.toolDefinition.renderResult : undefined;
  assert.equal(typeof renderResult, "function", "the result renderer is carried over");
  const component = (renderResult as (...args: unknown[]) => { render(width: number): string[] })(
    { content: [] },
    { expanded: false },
    THEME,
    { args: {} },
  );
  component.render(60);

  assert.equal(parts.at(-1), "result", "the result renderer says `result`, never `call`");
  assert.deepEqual([...new Set(parts)].sort(), ["call", "result"], "both parts reach the design");
});

// ---------------------------------------------------------------------------------------------
// T16 — the report says which path ran, per tool
// ---------------------------------------------------------------------------------------------

test("S10/T16: /bridge-status counts resolver-wrapped cards and adopted cards per tool", () => {
  registerToolDesign(bashHeadingDesign);
  setToolDesignSelection("bash", "loon.bash-heading");

  // Adoption path: a card resolved by the host ahead of the bridge.
  const adoptedCard = mountCard({ toolName: "bash", toolDefinition: bashRenderers() });
  adoptToolCards({ children: [adoptedCard] });
  // Resolver path: a card resolved through the bridge's own wrapper.
  mountCard({
    toolName: "bash",
    toolDefinition: toolDesignResolver("bash", bashRenderers) as unknown,
  });

  const snapshot = collectStatus();
  assert.ok(snapshot.toolDesigns !== undefined);
  const entry = snapshot.toolDesigns.tools[0];
  assert.equal(entry.wrapper, "mounted", "the resolver path mounted one card");
  assert.equal(entry.cards, 1);
  assert.equal(entry.adopted, 1, "the adoption path adopted the other");

  // The resolver's diagnostics and the adoption's are separate records of separate paths.
  assert.deepEqual(getToolDesignWiringDiagnostics().wrappedCards, [{ tool: "bash", cards: 1 }]);
  assert.deepEqual(getToolDesignAdoptionDiagnostics().adoptedCards, [{ tool: "bash", cards: 1 }]);

  const report = formatStatus(snapshot).join("\n");
  assert.match(report, /- bash: loon\.bash-heading, wrapper mounted on 1 card, adopted 1 card/u);
});

test("S10/T16: with no design registered the report is unchanged — no tool-design block at all", () => {
  assert.equal(collectStatus().toolDesigns, undefined);
  const report = formatStatus(collectStatus()).join("\n");
  assert.doesNotMatch(report, /tool design/u);
});

test("S10: a grouped design is adopted onto a card of any tool its line covers", () => {
  registerToolDesign({
    line: "tools",
    tools: ["bash"],
    id: "loon.tools-activity",
    label: "activity",
    apply: (lines: readonly string[], ctx: ToolDesignContext): string[] => {
      assert.equal(ctx.tool, "bash");
      return lines.map((line) => (line.includes("$ ") ? line.replace("$ ", "bash ") : line));
    },
  });
  setToolDesignLineSelection("line", "tools", "loon.tools-activity");

  const card = mountCard({ toolName: "bash", toolDefinition: bashRenderers() });
  assert.equal(
    adoptToolCards({ children: [card] }).adopted,
    1,
    "adoption reaches a tool that has a design through its line",
  );
  assert.deepEqual(card.render(80), DESIGNED_BASH_CARD);
});

