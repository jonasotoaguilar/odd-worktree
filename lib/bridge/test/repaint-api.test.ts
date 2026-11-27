/**
 * The plugin-facing repaint (T4, retuned by T23 and T36 of `odd/tasks/bash-card-identity.md`): a frame
 * for the cards already on screen, not only the next one.
 *
 * ONE path now, for both kinds of value (`./repaint.ts` explains why): the host's sidebar revision is
 * bumped and one DIFFERENTIAL `requestRender()` is asked for.
 *
 * - `requestRepaint()` — a PLUGIN's value. Its wrapper reads the value on every render pass, so the
 *   drawn card changes without any cache being dropped; measuring the old invalidate + force on a
 *   real transcript is why: 753 ms vs 21 ms at 600 children (S13/T23).
 * - `requestSurfaceRepaint()` — a BRIDGE-owned row (the restored example `plain`, a section toggle).
 *   T4 also dropped every mounted component's frame cache (`tui.invalidate()`) and forced the frame
 *   (`requestRender(true)`); S19/T35 measured that on real pi components at 50/200/600 children and
 *   proved the rows are byte-identical without either, on the conversation, on a rail host panel and
 *   on a bridge section hidden/collapsed/expanded. 600 children: 697/306/99 ms with them, 420/16/3
 *   ms without. `test/surface-repaint-cost.test.ts` bounds the work.
 *
 * Everything asserted here is the order and the arguments the host actually observes, plus the
 * `/bridge-status` record: no timers, no internal fields.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { bridgeApi } from "../src/api.ts";
import {
  HOST_SIDEBAR_CACHE,
  getRepaintDiagnostics,
  requestRepaint,
  requestSurfaceRepaint,
  resetRepaintForTests,
  setRepaintHost,
} from "../src/repaint.ts";

interface HostCall {
  readonly name: "invalidate" | "requestRender";
  readonly args: readonly unknown[];
}

/**
 * The `tui` a host hands the widget factory, as far as a repaint reads it: `invalidate()` and
 * `requestRender(force?)`, recorded in the order the bridge calls them.
 */
function recordingTui(options: { invalidate?: "present" | "absent" | "throws" } = {}): {
  calls: HostCall[];
  requestRenderCalls: () => number;
  host: Record<string, unknown>;
} {
  const calls: HostCall[] = [];
  const mode = options.invalidate ?? "present";
  const host: Record<string, unknown> = {
    terminal: {},
    requestRender(force?: boolean): void {
      calls.push({ name: "requestRender", args: force === undefined ? [] : [force] });
    },
  };
  if (mode === "present") {
    host.invalidate = (): void => {
      calls.push({ name: "invalidate", args: [] });
    };
  }
  if (mode === "throws") {
    host.invalidate = (): void => {
      calls.push({ name: "invalidate", args: [] });
      throw new Error("this component refused to drop its frame");
    };
  }
  return {
    calls,
    requestRenderCalls: () => calls.filter((call) => call.name === "requestRender").length,
    host,
  };
}

test.beforeEach(() => {
  resetRepaintForTests();
});

test("T23: requestRepaint asks for ONE differential frame and drops no cache", () => {
  const tui = recordingTui();
  setRepaintHost(tui.host);

  const trigger = requestRepaint();

  assert.deepEqual(
    tui.calls.map((call) => call.name),
    ["requestRender"],
    "no tui.invalidate(): the plugin's wrapper reads its value on every pass",
  );
  assert.deepEqual(
    tui.calls[0]?.args,
    [],
    "a differential frame, not a forced full redraw of the whole buffer",
  );
  assert.deepEqual(trigger, {
    cause: "a plugin asked for a repaint",
    surfaces: ["conversation", "rail"],
    outcome: "repainted",
  });
  assert.deepEqual(getRepaintDiagnostics().lastTrigger, trigger);

  // The host's own part-owner step still runs: the rail repaints from its revision counter.
  const terminal = tui.host.terminal as Record<symbol, { revision: number } | undefined>;
  assert.equal(terminal[HOST_SIDEBAR_CACHE]?.revision, 1, "invalidateSidebar(tui)'s one step");
});

test("T36: the bridge-owned path is one differential frame plus the sidebar revision", () => {
  const tui = recordingTui();
  setRepaintHost(tui.host);

  const trigger = requestSurfaceRepaint({ cause: "card style → neon", surfaces: ["conversation"] });

  assert.deepEqual(
    tui.calls.map((call) => call.name),
    ["requestRender"],
    "no tui.invalidate(): the wrapper restyles the host's own rows on every pass, so dropping every " +
      "Markdown cache changed no row and cost 600 ms at 600 children (S19/T35)",
  );
  assert.deepEqual(
    tui.calls[0]?.args,
    [],
    "a differential frame, not a forced full redraw: the force rewrote 6.9 MB for the same rows",
  );
  const terminal = tui.host.terminal as Record<symbol, { revision: number } | undefined>;
  assert.equal(terminal[HOST_SIDEBAR_CACHE]?.revision, 1, "invalidateSidebar(tui)'s step is kept");
  assert.deepEqual(trigger, {
    cause: "card style → neon",
    surfaces: ["conversation"],
    outcome: "repainted",
  });
  assert.deepEqual(getRepaintDiagnostics().lastTrigger, trigger);
});

test("T4: with no host captured the request is reported, not thrown", () => {
  const trigger = requestRepaint();

  assert.deepEqual(trigger, {
    cause: "a plugin asked for a repaint",
    surfaces: ["conversation", "rail"],
    outcome: "unavailable",
    reason: "no tui has been captured, so no surface can be repainted",
  });
  assert.equal(getRepaintDiagnostics().hostCaptured, false);
  assert.deepEqual(getRepaintDiagnostics().lastTrigger, trigger);
});

test("T36: an absent or throwing tui.invalidate() cannot cost either path a frame", () => {
  const bare = recordingTui({ invalidate: "absent" });
  setRepaintHost(bare.host);
  assert.equal(requestSurfaceRepaint({ cause: "card style → neon", surfaces: ["rail"] }).outcome, "repainted");
  assert.deepEqual(bare.calls.map((call) => call.name), ["requestRender"], "nothing to invalidate");
  assert.deepEqual(bare.calls[0]?.args, []);

  resetRepaintForTests();
  const hostile = recordingTui({ invalidate: "throws" });
  setRepaintHost(hostile.host);
  assert.equal(
    requestSurfaceRepaint({ cause: "card style → neon", surfaces: ["rail"] }).outcome,
    "repainted",
    "a refused cache is not a failed frame",
  );
  assert.deepEqual(
    hostile.calls.map((call) => call.name),
    ["requestRender"],
    "and it is not reached at all: the tree is never walked",
  );
  assert.deepEqual(hostile.calls[0]?.args, []);

  resetRepaintForTests();
  const pluginHostile = recordingTui({ invalidate: "throws" });
  setRepaintHost(pluginHostile.host);
  assert.equal(requestRepaint().outcome, "repainted");
  assert.deepEqual(pluginHostile.calls.map((call) => call.name), ["requestRender"]);
  assert.deepEqual(pluginHostile.calls[0]?.args, []);
});

test("T4: a captured object with no requestRender() is reported as unavailable", () => {
  setRepaintHost({ terminal: {}, invalidate: () => {} });

  const trigger = requestRepaint();

  assert.equal(trigger.outcome, "unavailable");
  assert.equal(
    trigger.reason,
    "the captured tui has no requestRender(), so no frame can be asked for",
  );
});

test("T4: the published bridge API carries requestRepaint for a plugin that never imports this package", () => {
  const tui = recordingTui();
  setRepaintHost(tui.host);

  const api = bridgeApi();
  assert.equal(typeof api?.requestRepaint, "function", "the plugin-facing slot publishes it");
  api?.requestRepaint?.();

  assert.deepEqual(tui.calls.map((call) => call.name), ["requestRender"]);
  assert.deepEqual(tui.calls[0]?.args, []);
  assert.equal(getRepaintDiagnostics().lastTrigger?.outcome, "repainted");
});
