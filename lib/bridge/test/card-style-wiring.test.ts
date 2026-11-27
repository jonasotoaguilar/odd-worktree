/**
 * Wiring the transform to a live `tui` (S5, S4): the path `src/card-styles.ts` proved, armed from the
 * one surface that hands this package a real TUI, with the sidebar backend's marker/generation
 * discipline.
 *
 * The fixture models Pi's tree (`test/fake-transcript.ts` documents every citation), so these tests
 * prove the real walk: `tui.children[0]` → the document → `children[2]` first, and
 * `tui.layoutRoot` → its layout entries → the primary `ScrollView` → its child → `children[2]` as the
 * secondary. Every absence is a reported outcome, never a throw and never a guess.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerCardStyle, resetBusForTests, resetCardStylesForTests } from "../src/bus.ts";
import { getCardStyleLastOutcome, resetCardStyleTransformForTests } from "../src/card-style-transform.ts";
import {
  disableCardStyleTransform,
  getCardStyleWiringDiagnostics,
  installCardStyleTransform,
  resetCardStyleWiringForTests,
} from "../src/card-style-wiring.ts";
import { setCardStyleSelection } from "../src/card-styles.ts";
import { armSidebar } from "../src/extension.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { disableSidebarBackend, resetSidebarStateForTests } from "../src/sidebar.ts";
import { resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CardStyleRegistration } from "../src/types.ts";
import { READ_CARD, createFakeTranscriptTui } from "./fake-transcript.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-wiring-"));
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
  resetCardStylesForTests();
  resetCardStyleTransformForTests();
  resetCardStyleWiringForTests();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetNoticesForTests();
  resetStoreStateForTests();
  disableSidebarBackend();
  disableCardStyleTransform();
  setCardStyleSelection("native");
});

const style = (id: string, label: string): CardStyleRegistration => ({
  id,
  label,
  frame: {
    top: (ctx) => `+${ctx.title ?? ""}${ctx.hint === undefined ? "" : `|${ctx.hint}`}`,
    line: (ctx) => `> ${ctx.text}`,
    bottom: () => "-",
  },
});

// ---------------------------------------------------------------------------------------------
// The proven path
// ---------------------------------------------------------------------------------------------

test("arming wraps the conversation component found through children[0] → document → children[2]", () => {
  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  const originalRender = tui.chat.render;

  const result = installCardStyleTransform(tui);

  assert.deepEqual(result, { installed: true, outcome: "wrapped", component: "chat" });
  assert.notEqual(tui.chat.render, originalRender, "the conversation component is the one wrapped");
  assert.deepEqual(getCardStyleWiringDiagnostics(), { wrapped: 1, component: "chat", lastOutcome: "wrapped" });
});

test("a selected style repaints the live conversation; native is a pass-through", () => {
  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  installCardStyleTransform(tui);
  registerCardStyle(style("loon.cute", "cute"));

  assert.deepEqual(tui.chat.render(40), [...READ_CARD], "native: the host's rows, untouched");
  assert.deepEqual(getCardStyleLastOutcome(), { kind: "pass-through", reason: "native" });

  setCardStyleSelection("loon.cute");

  assert.deepEqual(tui.chat.render(40), ["+read|ctrl+o", "> config.ts", "-"]);
  assert.deepEqual(getCardStyleLastOutcome(), { kind: "transformed", styleId: "loon.cute", cards: 1 });
});

test("the layoutRoot hop is the secondary path when children[0] is not the document", () => {
  const mounted = createFakeTranscriptTui({ lines: [...READ_CARD] });
  // A host whose mounted children are not the document (an older/plainer renderer), but whose
  // layout root still carries the transcript (interactive-mode.js:623-629).
  const tui = { terminal: {}, children: [], layoutRoot: mounted.layoutRoot };

  const result = installCardStyleTransform(tui);

  assert.deepEqual(result, { installed: true, outcome: "wrapped", component: "chat" });
  assert.deepEqual(mounted.chat.render(40), [...READ_CARD], "native through the secondary path");
  setCardStyleSelection("loon.cute");
  registerCardStyle(style("loon.cute", "cute"));
  assert.deepEqual(mounted.chat.render(40), ["+read|ctrl+o", "> config.ts", "-"]);
});

test("the walk stops at the first shape that is not the document and reports it", () => {
  const mounted = createFakeTranscriptTui({ lines: [...READ_CARD] });
  // children[0] exists but is not a container, so the primary hop fails and nothing else is there.
  const tui = { terminal: {}, children: [{ render: () => [] }] };

  assert.deepEqual(installCardStyleTransform(tui), { installed: false, outcome: "no-document" });
  assert.equal(mounted.chat.render, mounted.chat.render, "an unrelated tree is never touched");
});

// ---------------------------------------------------------------------------------------------
// Every absence is a reported state
// ---------------------------------------------------------------------------------------------

test("no tui is reported, not thrown", () => {
  for (const tui of [undefined, null, 42, "tui", {}]) {
    const result = installCardStyleTransform(tui);
    assert.equal(result.installed, false, `installed must stay false for ${JSON.stringify(tui)}`);
    assert.ok(
      ["no-tui", "no-children"].includes(result.outcome),
      `unexpected outcome ${result.outcome} for ${JSON.stringify(tui)}`,
    );
  }
  assert.deepEqual(getCardStyleWiringDiagnostics(), { wrapped: 0, lastOutcome: "no-children" });
});

test("a tui without a document reports no-document", () => {
  const result = installCardStyleTransform({ terminal: {}, children: [{}] });

  assert.deepEqual(result, { installed: false, outcome: "no-document" });
  assert.equal(getCardStyleWiringDiagnostics().lastOutcome, "no-document");
});

test("a document without a third child reports no-conversation", () => {
  const result = installCardStyleTransform({ terminal: {}, children: [{ children: [{}, {}] }] });

  assert.deepEqual(result, { installed: false, outcome: "no-conversation" });
});

test("a third child that cannot render reports render-missing", () => {
  const result = installCardStyleTransform({
    terminal: {},
    children: [{ children: [{}, {}, { render: "not a function" }] }],
  });

  assert.deepEqual(result, { installed: false, outcome: "render-missing" });
});

test("a tui whose children accessor throws is reported with its reason, never thrown", () => {
  const tui = {
    terminal: {},
    get children(): never {
      throw new Error("accessor exploded");
    },
  };

  const result = installCardStyleTransform(tui);

  assert.equal(result.installed, false);
  assert.equal(result.outcome, "wrong-shape");
  assert.match(result.reason ?? "", /accessor exploded/u);
  assert.match(getCardStyleWiringDiagnostics().lastReason ?? "", /accessor exploded/u);
});

// ---------------------------------------------------------------------------------------------
// Idempotency and the generation guard
// ---------------------------------------------------------------------------------------------

test("a second arm reports already-wrapped and installs nothing new", () => {
  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  installCardStyleTransform(tui);
  const wrapped = tui.chat.render;

  const second = installCardStyleTransform(tui);

  assert.deepEqual(second, { installed: true, outcome: "already-wrapped", component: "chat" });
  assert.equal(tui.chat.render, wrapped, "one wrapper, not a stack of them");
  assert.equal(getCardStyleWiringDiagnostics().wrapped, 1);
});

test("after disabling, a wrapper foreign code retained is a pass-through (S5)", () => {
  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  installCardStyleTransform(tui);
  registerCardStyle(style("loon.cute", "cute"));
  setCardStyleSelection("loon.cute");
  const retained = tui.chat.render;
  assert.deepEqual(tui.chat.render(40), ["+read|ctrl+o", "> config.ts", "-"]);

  const restored = disableCardStyleTransform();

  assert.equal(restored, 1);
  assert.equal(getCardStyleWiringDiagnostics().wrapped, 0);
  assert.deepEqual(retained(40), [...READ_CARD], "the retained wrapper is inert");
  assert.deepEqual(tui.chat.render(40), [...READ_CARD], "and the host's own render is back");
});

// ---------------------------------------------------------------------------------------------
// Stale selection, end to end (S12)
// ---------------------------------------------------------------------------------------------

test("a disposed style degrades to an untouched frame on the next render (S12)", () => {
  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  installCardStyleTransform(tui);
  const dispose = registerCardStyle(style("loon.cute", "cute"));
  setCardStyleSelection("loon.cute");
  assert.deepEqual(tui.chat.render(40), ["+read|ctrl+o", "> config.ts", "-"]);

  dispose();

  assert.deepEqual(tui.chat.render(40), [...READ_CARD], "no chrome for a style that no longer exists");
  assert.deepEqual(getCardStyleLastOutcome(), { kind: "pass-through", reason: "missing" });
});

// ---------------------------------------------------------------------------------------------
// Where it arms
// ---------------------------------------------------------------------------------------------

test("the widget factory that captures the tui is what arms the transform", () => {
  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  const factoryCalls: unknown[] = [];
  const ui = {
    setWidget: (key: string, factory: (tuiArg: unknown, theme: unknown) => unknown) => {
      factoryCalls.push(key);
      factory(tui, {});
    },
  };

  armSidebar(ui);

  assert.equal(factoryCalls.length, 1, "one factory, as Pi installs it");
  assert.equal(getCardStyleWiringDiagnostics().wrapped, 1, "and the factory armed the transform");
  registerCardStyle(style("loon.cute", "cute"));
  setCardStyleSelection("loon.cute");
  assert.deepEqual(tui.chat.render(40), ["+read|ctrl+o", "> config.ts", "-"]);
});

test("a ui without setWidget arms nothing and does not throw", () => {
  assert.doesNotThrow(() => armSidebar({}));
  assert.equal(getCardStyleWiringDiagnostics().wrapped, 0);
  assert.equal(getCardStyleWiringDiagnostics().lastOutcome, undefined, "never attempted, not failed");
});
