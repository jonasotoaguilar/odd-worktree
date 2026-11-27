/**
 * T10: the worked example's bash DESIGN inside the host's `neon` outline (S1, S5).
 *
 * The user's live frame: the host's own `Card style` line is on `neon`, and the bash card must come
 * back with `bash` where it printed `$` — inside the SAME outline. A design never draws chrome: the
 * host's frame is already there when it is handed the rows, so `neon` (and `float`) survive by
 * construction, and the design only changes the mark and re-balances the rule's fill to keep the row
 * exactly as wide as the host made it.
 *
 * The frames are host-derived fixtures (`test/fake-transcript.ts`: `HOST_BASH_NEON_*`, built from
 * `lib/shell-card.ts` — `cardTop`/`cardLine`/`cardBottom` at width 60), split the way Pi builds a
 * card: the top rule is the call component, the body and closing rule the result component.
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
import { resetToolDesignsForTests } from "../src/tool-designs.ts";
import { resetToolDesignRowStateForTests } from "../src/tool-design-rows.ts";
import { resetToolDesignWiringForTests } from "../src/tool-design-wiring.ts";
import type { CustomizeRow, InlineHelpers } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";
import {
  BASH_MINIMAL_NEON_CALL,
  BASH_MINIMAL_NEON_RESULT,
  stripAnsi,
} from "./fake-transcript.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-example-neon-"));
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

interface FakeComponent {
  render(width: number): string[];
}

interface FakeRenderers {
  renderShell?: unknown;
  renderCall?: unknown;
  renderResult?: unknown;
  [member: string]: unknown;
}

function fakeComponent(lines: readonly string[]): FakeComponent {
  const rows = [...lines];
  return { render: (): string[] => rows };
}

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

function mount(renderers: FakeRenderers, member: "renderCall" | "renderResult"): FakeComponent {
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
  readonly resolver: (tool: string, next: () => FakeRenderers) => FakeRenderers | undefined;
  rows(): CustomizeRow[];
  pick(value: string): Promise<void>;
  dispose(): void;
}

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

  assert.equal(resolvers.length, 1, "one resolver, the bridge's");
  const resolver = resolvers[0] as World["resolver"];
  const rows = (): CustomizeRow[] => buildRows({ theme: undefined, configHome }).rows;
  return {
    resolver,
    rows,
    pick: async (value) => {
      const row = rows().find(
        (candidate) =>
          (candidate.choice?.setting === "bash" || candidate.choice?.setting === "Card bash") &&
          candidate.choice?.value === value,
      );
      assert.ok(row?.action !== undefined, `the Cards line carries the value ${value}`);
      await row.action(inlineHelpers);
    },
    dispose,
  };
}

/**
 * The host's neon top rule with `bash` in place of `$`, three rule columns fewer: the host's bytes are
 * `test/fake-transcript.ts`'s `BASH_MINIMAL_NEON_CALL[0]`, and the rule's own `─` fill is what gives
 * the word its three extra columns back.
 */
const DESIGNED_NEON_TOP =
  "\u001b[95m╭\u001b[39m\u001b[95m─ \u001b[39m\u001b[95mbash \u001b[95m\u001b[1mnpm test\u001b[22m\u001b[39m" +
  "\u001b[37m (timeout 30s)\u001b[39m\u001b[39m\u001b[95m ──────────\u001b[39m \u001b[2mctrl+o to expand\u001b[39m" +
  " \u001b[95m╮\u001b[39m";

test("T10: the neon outline stays neon, and only the mark changes", async () => {
  const world = await startWorld("neon-design");
  const renderers = fakeRenderers(BASH_MINIMAL_NEON_CALL, BASH_MINIMAL_NEON_RESULT);
  const resolved = world.resolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  const call = mount(resolved, "renderCall");
  const result = mount(resolved, "renderResult");

  assert.deepEqual(call.render(60), [...BASH_MINIMAL_NEON_CALL], "the host's neon rule, unchanged");

  await world.pick("bash heading");
  const output = call.render(60);

  assert.equal(output.length, 1, "the call component is still one rule");
  assert.equal(output[0], DESIGNED_NEON_TOP, "`bash` where the host printed `$`");
  assert.equal(
    stripAnsi(output[0]).length,
    stripAnsi(BASH_MINIMAL_NEON_CALL[0]).length,
    "the rule is exactly as wide as the host made it",
  );
  assert.ok(stripAnsi(output[0]).startsWith("╭─ bash npm test"), "the outline is still the outline");
  assert.ok(stripAnsi(output[0]).endsWith(" ctrl+o to expand ╮"), "and the hint is still the hint");

  const body = result.render(60);
  assert.deepEqual(body, [...BASH_MINIMAL_NEON_RESULT], "every body row is byte-identical");
  assert.equal(
    body[body.length - 1],
    BASH_MINIMAL_NEON_RESULT[BASH_MINIMAL_NEON_RESULT.length - 1],
    "the closing rule is the host's own",
  );

  world.dispose();
});

test("T10: the design leaves a body row that carries `$` inside text alone", async () => {
  const world = await startWorld("neon-content-dollar");
  const result = [
    "\u001b[95m│\u001b[39m \u001b[37mexport PATH=$HOME/bin\u001b[39m                              \u001b[95m│\u001b[39m",
    BASH_MINIMAL_NEON_RESULT[1],
    BASH_MINIMAL_NEON_RESULT[2],
  ];
  const renderers = fakeRenderers(BASH_MINIMAL_NEON_CALL, result);
  const resolved = world.resolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  const mounted = mount(resolved, "renderResult");

  await world.pick("bash heading");

  assert.deepEqual(mounted.render(60), result, "output is never rewritten as if it were the mark");
  world.dispose();
});

test("T10: the host's own card restores the neon rule byte for byte", async () => {
  const world = await startWorld("neon-native");
  const renderers = fakeRenderers(BASH_MINIMAL_NEON_CALL, BASH_MINIMAL_NEON_RESULT);
  const resolved = world.resolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  const call = mount(resolved, "renderCall");

  await world.pick("bash heading");
  assert.equal(call.render(60)[0], DESIGNED_NEON_TOP);

  await world.pick("default");
  assert.deepEqual(call.render(60), [...BASH_MINIMAL_NEON_CALL]);

  world.dispose();
});
