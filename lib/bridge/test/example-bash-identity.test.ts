/**
 * T10: the worked example's DESIGN for `bash`, driven through the real bus (S1, S5, S6, S8).
 *
 * The host heads a minimal bash card with the bare command and supplies the `$` prompt as the card's
 * glyph (`quiet-tools.ts:521-525`). The design in `examples/bash-card.ts` heads that card `bash`
 * instead, and changes nothing else: the frame, the ANSI, the padding, the right-aligned hint and
 * every body row are the host's own bytes.
 *
 * This file loads the real example, arms the real bridge (which installs the one resolver and the
 * `Cards` rows), and renders the components Pi keeps — the call component and the result component —
 * so the claim is made about the rows a user sees, not about a helper. `float` here; the `neon`
 * outline is `test/example-neon-transform.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishBridgeApi, resetBridgeApiForTests } from "../src/api.ts";
import {
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
} from "../src/bus.ts";
import { resetCardStyleTransformForTests } from "../src/card-style-transform.ts";
import { disableCardStyleTransform, resetCardStyleWiringForTests } from "../src/card-style-wiring.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import gentleShellBridge, { type BridgeExtensionApi } from "../src/extension.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetPluginLinesForTests } from "../src/plugin-lines.ts";
import { resetRepaintForTests } from "../src/repaint.ts";
import { buildRows, resetRowBuildStateForTests } from "../src/rows.ts";
import { disableSidebarBackend, resetSidebarStateForTests } from "../src/sidebar.ts";
import { resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import { resetToolDesignsForTests, setToolDesignSelection } from "../src/tool-designs.ts";
import { resetToolDesignRowStateForTests } from "../src/tool-design-rows.ts";
import { resetToolDesignWiringForTests } from "../src/tool-design-wiring.ts";
import type { CustomizeRow, InlineHelpers } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";
import {
  BASH_MINIMAL_FLOAT_CALL,
  BASH_MINIMAL_FLOAT_RESULT,
  stripAnsi,
} from "./fake-transcript.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-example-identity-"));
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
  resetBridgeApiForTests();
  resetBusForTests();
  resetSectionsForTests();
  resetCardStylesForTests();
  resetCardStyleTransformForTests();
  resetCardStyleWiringForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetSidebarStateForTests();
  resetSectionFailuresForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
  resetRepaintForTests();
  resetStoreStateForTests();
  resetToolDesignsForTests();
  resetToolDesignRowStateForTests();
  resetToolDesignWiringForTests();
  disableCaptureBackend();
  disableSidebarBackend();
  disableCardStyleTransform();
});

type SessionHandler = (event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void;

interface FakePi {
  on?: (event: string, handler: SessionHandler) => void;
  registerCommand?: () => void;
  registerToolRenderer?: (resolver: unknown) => void;
  /** Present because the bridge checks the REQUIRED host package at runtime (S9/T12). */
  getCommands?: () => Array<{ name: string }>;
}

type ExampleInit = (pi: FakePi) => () => void;

const loadExample = async (tag: string): Promise<ExampleInit> => {
  const specifier = new URL(`../examples/bash-card.ts?${tag}`, import.meta.url).href;
  return ((await import(specifier)) as { default: ExampleInit }).default;
};

const inlineHelpers: InlineHelpers = {
  input: async () => undefined,
  confirm: async () => true,
  capture: async () => undefined,
};

/** Pi's own component contract, as far as a card uses it. */
interface FakeComponent {
  render(width: number): string[];
}

interface FakeRenderers {
  renderShell?: unknown;
  renderCall?: unknown;
  renderResult?: unknown;
  [member: string]: unknown;
}

/** A component that returns ONE array instance, so "the host's own rows" is observable by identity. */
function fakeComponent(lines: readonly string[]): FakeComponent {
  const rows = [...lines];
  return { render: (): string[] => rows };
}

/** The renderers a tool advertises: a call component and a result component, like the host's. */
function fakeRenderers(call: readonly string[], result: readonly string[]): FakeRenderers {
  // One component instance per renderer, like Pi: the renderer is called once and the SAME object
  // is re-rendered on every frame, which is what makes "the host's own array instance" observable.
  const callComponent = fakeComponent(call);
  const resultComponent = fakeComponent(result);
  return {
    renderShell: "default",
    renderCall: () => callComponent,
    renderResult: () => resultComponent,
  };
}

const THEME = { name: "fake-theme" };

/** The component Pi keeps after resolving a renderer once, when the card is constructed. */
function mount(
  renderers: FakeRenderers,
  member: "renderCall" | "renderResult",
): FakeComponent {
  const renderer = renderers[member];
  assert.equal(typeof renderer, "function");
  return member === "renderCall"
    ? (renderer as (args: unknown, theme: unknown, ctx: unknown) => FakeComponent)(
        { command: "npm test" },
        THEME,
        {},
      )
    : (renderer as (result: unknown, options: unknown, theme: unknown, ctx: unknown) => FakeComponent)(
        { content: [] },
        { expanded: false },
        THEME,
        {},
      );
}

interface World {
  /** The one resolver the bridge registered on this Pi. */
  readonly resolver: (tool: string, next: () => FakeRenderers) => FakeRenderers | undefined;
  /** The rows the customize menu builds right now. */
  rows(): CustomizeRow[];
  /** Press the value with this label on the `bash` design line. */
  pick(value: string): Promise<void>;
  dispose(): void;
}

/**
 * A session as Pi runs it: the bridge arms itself (installing the one resolver and the design rows),
 * then the example registers its design from its own `session_start`.
 */
/** The tool-design line's setting, old bridge (`bash`) and current bridge (`Card bash`). */
const isBashDesignSetting = (setting: string | undefined): boolean =>
  setting === "bash" || setting === "Card bash";

async function startWorld(tag: string): Promise<World> {
  publishBridgeApi();
  const host = createFakeHost();
  const resolvers: unknown[] = [];
  const sessionHandlers: SessionHandler[] = [];
  const pi: FakePi = {
    // `gentle-pi` is present, so the bridge's `session_start` arms (S9/T12).
    getCommands: () => [{ name: "gentle:customize" }],
    on(_event, handler) {
      sessionHandlers.push(handler);
    },
    registerCommand() {},
    registerToolRenderer(resolver) {
      resolvers.push(resolver);
    },
  };

  gentleShellBridge(pi as BridgeExtensionApi);
  const dispose = (await loadExample(tag))(pi);
  for (const handler of sessionHandlers) handler({}, { hasUI: true, ui: host.ui });

  assert.equal(resolvers.length, 1, "the bridge registers exactly one resolver");
  const resolver = resolvers[0] as World["resolver"];
  assert.equal(typeof resolver, "function");

  const rows = (): CustomizeRow[] => buildRows({ theme: undefined, configHome }).rows;

  return {
    resolver,
    rows,
    pick: async (value) => {
      const row = rows().find(
        (candidate) =>
          isBashDesignSetting(candidate.choice?.setting) && candidate.choice?.value === value,
      );
      assert.ok(row !== undefined, `the Cards line for bash carries the value ${value}`);
      assert.ok(row.action !== undefined, `the ${value} value must have an action`);
      await row.action(inlineHelpers);
    },
    dispose,
  };
}

/**
 * The heading row with the host's `$` mark replaced by `bash`, and three fill columns fewer.
 * The host's bytes are `test/fake-transcript.ts`'s `BASH_MINIMAL_FLOAT_CALL[1]`: the mark sits inside
 * the title run the host painted, so the word replaces one character and the row's space fill — not
 * the hint, not the rail — gives the three extra columns back.
 */
const DESIGNED_FLOAT_HEADING =
  " \u001b[48;5;236m\u001b[95m▎\u001b[39m\u001b[95m \u001b[39m\u001b[95mbash \u001b[95m\u001b[1mnpm test\u001b[22m\u001b[39m" +
  "\u001b[37m (timeout 30s)\u001b[39m\u001b[39m\u001b[95m         \u001b[39m \u001b[2mctrl+o to expand\u001b[39m" +
  " \u001b[95m  \u001b[39m\u001b[49m ";

// ---------------------------------------------------------------------------------------------
// The default: the host's own card, no intervention
// ---------------------------------------------------------------------------------------------

test("T10/S8: the design appears on the `bash` Cards line beside the host's own card", async () => {
  const world = await startWorld("cards-line");

  const values = world
    .rows()
    .filter((row) => isBashDesignSetting(row.choice?.setting))
    .map((row) => row.choice?.value);
  assert.deepEqual(values, ["default", "bash heading"], "the host's card is the default value");

  const native = world
    .rows()
    .find((row) => isBashDesignSetting(row.choice?.setting) && row.choice?.value === "default");
  assert.equal(native?.choice?.current(), true, "nothing is selected on install");

  world.dispose();
});

test("T10: with the host's own card selected, the resolver draws the host's rows unchanged", async () => {
  const world = await startWorld("native-bytes");
  const renderers = fakeRenderers(BASH_MINIMAL_FLOAT_CALL, BASH_MINIMAL_FLOAT_RESULT);
  const resolved = world.resolver("bash", () => renderers);
  assert.ok(resolved !== undefined);

  const call = mount(resolved, "renderCall");
  const result = mount(resolved, "renderResult");

  const hostCall = mount(renderers, "renderCall").render(60);
  const hostResult = mount(renderers, "renderResult").render(60);

  assert.equal(call.render(60), hostCall, "the host's own ARRAY instance, not a copy");
  assert.equal(result.render(60), hostResult, "both renderers, byte for byte");
  assert.deepEqual(call.render(60), [...BASH_MINIMAL_FLOAT_CALL]);
  assert.deepEqual(result.render(60), [...BASH_MINIMAL_FLOAT_RESULT]);

  world.dispose();
});

// ---------------------------------------------------------------------------------------------
// The design: `bash` where the host prints `$`, and every other byte the host's
// ---------------------------------------------------------------------------------------------

test("T10: the `bash` design changes the heading mark and nothing else, byte for byte", async () => {
  const world = await startWorld("designed-bytes");
  const renderers = fakeRenderers(BASH_MINIMAL_FLOAT_CALL, BASH_MINIMAL_FLOAT_RESULT);
  const resolved = world.resolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  const call = mount(resolved, "renderCall");
  const result = mount(resolved, "renderResult");

  await world.pick("bash heading");

  const output = call.render(60);

  assert.equal(output.length, BASH_MINIMAL_FLOAT_CALL.length, "the frame keeps its row count");
  assert.equal(output[1], DESIGNED_FLOAT_HEADING, "the heading mark is `bash`");
  assert.equal(
    stripAnsi(output[1] ?? "").length,
    stripAnsi(BASH_MINIMAL_FLOAT_CALL[1] ?? "").length,
    "width preserved",
  );
  for (const index of [0]) {
    assert.equal(
      output[index],
      BASH_MINIMAL_FLOAT_CALL[index],
      `row ${index} is the host's byte for byte`,
    );
  }
  assert.notEqual(
    output,
    BASH_MINIMAL_FLOAT_CALL,
    "a new frame was produced, not the host's array mutated",
  );

  const resultOutput = result.render(60);
  assert.deepEqual(
    resultOutput,
    mount(renderers, "renderResult").render(60),
    "the body is the host's, row for row",
  );
  assert.deepEqual(resultOutput, [...BASH_MINIMAL_FLOAT_RESULT], "every result row is byte-identical");
  assert.ok(
    resultOutput.some((row) => row.includes("duration 1.2s")),
    "the host's body is what was drawn",
  );

  world.dispose();
});

test("T10: picking the host's own card again restores the host's rows", async () => {
  const world = await startWorld("back-to-native");
  const renderers = fakeRenderers(BASH_MINIMAL_FLOAT_CALL, BASH_MINIMAL_FLOAT_RESULT);
  const resolved = world.resolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  const call = mount(resolved, "renderCall");

  await world.pick("bash heading");
  assert.equal(call.render(60)[1], DESIGNED_FLOAT_HEADING);

  await world.pick("default");
  assert.deepEqual(call.render(60), [...BASH_MINIMAL_FLOAT_CALL], "the host's card, unchanged");

  world.dispose();
});

test("T10: the design is declared for the `bash` tool name, so another tool is untouched", async () => {
  const world = await startWorld("other-tool");
  const readRenderers = fakeRenderers(
    [" \u001b[90m▎\u001b[39m \u001b[2m≡ read src/api.ts\u001b[39m"],
    [" \u001b[90m▎\u001b[39m export function bridgeApi() {"],
  );

  const resolved = world.resolver("read", () => readRenderers);

  assert.equal(resolved, readRenderers, "a tool with no design keeps the host's own renderers");
  world.dispose();
});

test("T10: a design whose selection names nothing falls back to the host's card", async () => {
  const world = await startWorld("missing-selection");
  const renderers = fakeRenderers(BASH_MINIMAL_FLOAT_CALL, BASH_MINIMAL_FLOAT_RESULT);
  const resolved = world.resolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  const call = mount(resolved, "renderCall");

  setToolDesignSelection("bash", "bash-card.retired");

  assert.deepEqual(call.render(60), [...BASH_MINIMAL_FLOAT_CALL], "a design nobody owns draws the host's card");

  world.dispose();
});
