/**
 * `/bridge-status` for the card-styles surface (S7, S12): the line mode, the registered styles in
 * order, the live selection (including a stale one), what the last frame did, the per-style failures,
 * and the one warning the bridge owes the user — a later post-processor can override this frame.
 *
 * The guard that matters most: a session with no card style registered and no card state prints the
 * pre-feature report byte for byte, because every block below is emitted only when it has something
 * to say.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { armBridge } from "../src/arm.ts";
import { registerCardStyle, resetBusForTests, resetCardStylesForTests } from "../src/bus.ts";
import { installCardStyleRows, resetCardStyleRowStateForTests } from "../src/card-style-rows.ts";
import { getCardStyleTransformFailures } from "../src/card-style-transform.ts";
import {
  disableCardStyleTransform,
  installCardStyleTransform,
  resetCardStyleWiringForTests,
} from "../src/card-style-wiring.ts";
import { resetCardStyleTransformForTests } from "../src/card-style-transform.ts";
import { setCardStyleSelection } from "../src/card-styles.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { disableSidebarBackend, resetSidebarStateForTests } from "../src/sidebar.ts";
import { resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { resetSectionsForTests } from "../src/bus.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CardStyleRegistration } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";
import { READ_CARD, createFakeTranscriptTui } from "./fake-transcript.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-status-cards-"));
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
  resetSectionsForTests();
  resetCardStylesForTests();
  resetCardStyleRowStateForTests();
  resetCardStyleTransformForTests();
  resetCardStyleWiringForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetNoticesForTests();
  resetStoreStateForTests();
  disableCaptureBackend();
  disableSidebarBackend();
  disableCardStyleTransform();
});

const style = (id: string, label: string, order?: number): CardStyleRegistration => ({
  id,
  label,
  ...(order === undefined ? {} : { order }),
  frame: { top: () => "+", line: (ctx) => `> ${ctx.text}`, bottom: () => "-" },
});

const statusLines = (): string[] => formatStatus(collectStatus());

const cardBlock = (lines: readonly string[]): string[] => {
  const start = lines.findIndex((line) => line.startsWith("card styles: "));
  if (start === -1) return [];
  const rest = lines.slice(start);
  const end = rest.findIndex((line) => line.startsWith("card style note: "));
  return end === -1 ? rest : rest.slice(0, end + 1);
};

test("a session with no style and no card state keeps the historical output byte for byte", () => {
  assert.deepEqual(statusLines(), [
    "gentle-shell-bridge status",
    "providers: none",
    "backend: none",
    "last capture: none",
    "last failures: none",
    "store problems: none",
    "duplicate settings: no build yet",
  ]);
  assert.equal(collectStatus().cardStyles, undefined);
});

test("the block reports mode, styles in order, selection, last frame and the downstream warning", () => {
  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  installCardStyleTransform(tui);
  registerCardStyle(style("loon.cute", "cute", 10));
  registerCardStyle(style("pix.mono", "mono"));
  registerCardStyle({
    id: "loon.broken",
    label: "broken",
    frame: {
      top: () => {
        throw new Error("top exploded");
      },
      line: (ctx) => ctx.text,
      bottom: () => "-",
    },
  });

  setCardStyleSelection("loon.broken");
  tui.chat.render(40);
  setCardStyleSelection("loon.cute");
  tui.chat.render(40);

  assert.deepEqual(
    getCardStyleTransformFailures(),
    [{ styleId: "loon.broken", message: "top exploded" }],
    "the failing style is remembered",
  );
  assert.deepEqual(cardBlock(statusLines()), [
    "card styles: separate, 3 registered",
    '  - loon.cute "cute" (order 10)',
    '  - pix.mono "mono" (registration order)',
    '  - loon.broken "broken" (registration order)',
    'card style selection: loon.cute "cute"',
    "card style frame: transformed 1 card",
    "card style surface conversation: reached (chat wrapped), last frame transformed 1 card",
    "card style surface rail: not reached (not attempted), last frame none",
    "card style wiring: chat wrapped",
    "card style failures: 1",
    "  - loon.broken: top exploded",
    "card style note: a downstream post-processor can strip or override this frame; " +
      "the bridge cannot prevent it.",
  ]);
});

test("a stale selection is reported as missing, never rendered (S12)", () => {
  const tui = createFakeTranscriptTui({ lines: [...READ_CARD] });
  installCardStyleTransform(tui);
  const dispose = registerCardStyle(style("loon.cute", "cute"));
  setCardStyleSelection("loon.cute");
  tui.chat.render(40);
  dispose();

  tui.chat.render(40);

  assert.deepEqual(cardBlock(statusLines()), [
    "card styles: separate, 0 registered",
    "card style selection: loon.cute (missing: not registered)",
    "card style frame: pass-through (missing: a disposed style)",
    "card style surface conversation: reached (chat wrapped), last frame pass-through (missing: a disposed style)",
    "card style surface rail: not reached (not attempted), last frame none",
    "card style wiring: chat wrapped",
    "card style note: a downstream post-processor can strip or override this frame; " +
      "the bridge cannot prevent it.",
  ]);
});

test("an unarmed transform reports why, so a missing repaint has an answer", () => {
  registerCardStyle(style("loon.cute", "cute"));
  installCardStyleTransform({ terminal: {}, children: [] });

  const lines = statusLines();

  assert.ok(lines.includes("card style wiring: not wrapped (no-children)"));
  assert.ok(lines.includes("card style frame: none"));
});

test("the extended mode is reported once the host's own line was found", () => {
  const host = createFakeHost({
    rows: [
      { category: "Cards", label: "Card bash: builtin", action: () => {} },
      {
        category: "Cards",
        label: () => "Card style: float",
        action: () => {},
        choice: { setting: "Card style", value: "float", current: () => true },
      },
      { category: "Layout", label: "Layout: builtin", action: () => {} },
    ],
  });
  armBridge(host.ui);
  installCardStyleRows();
  registerCardStyle(style("loon.cute", "cute"));
  host.buildMenu();

  assert.ok(statusLines().includes("card styles: extended, 1 registered"));
});
