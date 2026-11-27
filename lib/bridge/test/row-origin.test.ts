/**
 * Row origin (T1–T3 of `odd/tasks/bash-card-identity.md`): WHICH host child drew each drawn row.
 *
 * The host heads a bash card with the inferred activity (`quiet-tools.ts:672`), never with the
 * literal `bash` the example scans for, so identity has to come from the component that produced
 * the row — the way `pi-cinlodev-cute` reads `child.toolName === "bash"`
 * (`src/transcript/transcript-dispatcher.ts:30-40`).
 *
 * What is real here and what is modelled: pi-tui is not a dependency of this package, so
 * `FakeContainer` copies `Container.render` (`pi-tui/dist/tui.js:136-149`) — render each child,
 * record `{ component, height }`, publish `mouseLayout`, concatenate the rows. Everything else is
 * the bridge's own code: `src/row-origin.ts` reads that published layout, `./card-style-wiring.ts`
 * builds the map after the host's render, and `./transform-pipeline.ts` hands it to the transform.
 * The rows are asserted through the public surfaces (the transform's `ctx`, the drawn frame), never
 * through an internal field.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { registerTransform, resetBusForTests } from "../src/bus.ts";
import { resetCardStyleTransformForTests } from "../src/card-style-transform.ts";
import {
  disableCardStyleTransform,
  installCardStyleTransform,
  installRailCardStyleTransform,
  resetCardStyleWiringForTests,
} from "../src/card-style-wiring.ts";
import { setCardStyleSelection } from "../src/card-styles.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { rowOrigins } from "../src/row-origin.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { RowOrigin } from "../src/types.ts";
import { createRailTui } from "./fake-sidebar.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-row-origin-"));
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
  resetCardStyleTransformForTests();
  resetCardStyleWiringForTests();
  resetNoticesForTests();
  resetStoreStateForTests();
  disableCardStyleTransform();
  setCardStyleSelection("native");
});

// ---------------------------------------------------------------------------------------------
// The fixture: the shapes the host's own render pass leaves behind
// ---------------------------------------------------------------------------------------------

const WIDTH = 40;

/** A component, in Pi's sense: `render(width)` returns one row per line. */
interface FakeComponent {
  render(width: number): string[];
}

/** A bash tool row: the `toolName` the host's own component carries (`pi-cinlodev-cute` reads it). */
class BashRow {
  readonly toolName = "bash";
  private readonly height: number;

  constructor(height: number) {
    this.height = height;
  }

  render(): string[] {
    return Array.from({ length: this.height }, (_, row) => `$ npm run check ${String(row)}`);
  }
}

/** A read tool row: a different tool on the same host shape. */
class ReadRow {
  readonly toolName = "read";
  private readonly height: number;

  constructor(height: number) {
    this.height = height;
  }

  render(): string[] {
    return Array.from({ length: this.height }, (_, row) => `≡ config.ts ${String(row)}`);
  }
}

/** A drawn block that is not a tool at all: prose, a banner, a spacer. It carries no `toolName`. */
class ProseBlock {
  private readonly rows: readonly string[];

  constructor(rows: readonly string[]) {
    this.rows = rows;
  }

  render(): string[] {
    return [...this.rows];
  }
}

/** A `toolName` that is not a string is not a tool name: only a string is one (S1). */
class OddRow {
  readonly toolName = 42;

  render(): string[] {
    return ["odd row"];
  }
}

interface MouseChild {
  component: FakeComponent;
  height: number;
}

interface MouseLayout {
  width: number;
  children: MouseChild[];
}

/**
 * `pi-tui`'s `Container`: the host's conversation component is one, so its `render(width)` publishes
 * `mouseLayout` — `{ width, children: [{ component, height }] }` — on every pass
 * (`pi-tui/dist/tui.js:136-149`). Copied rather than imported: `pi-tui` is not a dependency.
 */
class FakeContainer {
  readonly children: FakeComponent[] = [];
  mouseLayout?: MouseLayout;

  addChild(child: FakeComponent): void {
    this.children.push(child);
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const mouseChildren: MouseChild[] = [];
    for (const child of this.children) {
      const childLines = child.render(width);
      mouseChildren.push({ component: child, height: childLines.length });
      lines.push(...childLines);
    }
    this.mouseLayout = { width, children: mouseChildren };
    return lines;
  }
}

/** Prose(1) · bash(3) · read(2) · a non-string tool name(1) · prose(1) = 8 rows. */
function conversationFixture(): FakeContainer {
  const conversation = new FakeContainer();
  conversation.addChild(new ProseBlock(["I will check the config first."]));
  conversation.addChild(new BashRow(3));
  conversation.addChild(new ReadRow(2));
  conversation.addChild(new OddRow());
  conversation.addChild(new ProseBlock([""]));
  return conversation;
}

const ORIGINS = {
  toolName: [undefined, "bash", "bash", "bash", "read", "read", undefined, undefined],
  component: [
    "ProseBlock",
    "BashRow",
    "BashRow",
    "BashRow",
    "ReadRow",
    "ReadRow",
    "OddRow",
    "ProseBlock",
  ],
};

/** The `tui` path `./card-style-wiring.ts` walks: `children[0]` → document → `children[2]`. */
function tuiFor(conversation: FakeComponent): Record<string, unknown> {
  return {
    terminal: {},
    children: [
      {
        children: [
          { render: () => ["header"] },
          { render: () => ["resources"] },
          conversation,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// T1 — the map
// ---------------------------------------------------------------------------------------------

test("T1: every drawn row names the child that produced it, with its tool name and constructor", () => {
  const conversation = conversationFixture();
  const lines = conversation.render(WIDTH);

  const map = rowOrigins(conversation, WIDTH, lines.length);

  assert.equal(map.reason, undefined, "a layout consistent with the frame is a complete map");
  assert.equal(map.rows.length, lines.length, "one entry per drawn row");
  assert.deepEqual(
    map.rows.map((row) => row.index),
    lines.map((_, index) => index),
    "the entry says which row it is about",
  );
  assert.deepEqual(map.rows.map((row) => row.toolName), ORIGINS.toolName);
  assert.deepEqual(
    map.rows.map((row) => row.component),
    ORIGINS.component,
    "a row whose child carries no tool name still names its constructor",
  );
});

test("T1: the map is derived from the host's own render pass, with no second render", () => {
  const conversation = conversationFixture();
  let renders = 0;
  const counting = new Proxy(conversation, {
    get(target, key, receiver): unknown {
      if (key === "render") {
        return (width: number): string[] => {
          renders += 1;
          return target.render(width);
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });

  const lines = counting.render(WIDTH);
  assert.equal(renders, 1);

  const map = rowOrigins(counting, WIDTH, lines.length);

  assert.equal(renders, 1, "reading the layout never renders a child again");
  assert.equal(map.rows.length, lines.length);
});

// ---------------------------------------------------------------------------------------------
// T1 — every absence is an empty map with a reason, never a guess and never a throw
// ---------------------------------------------------------------------------------------------

test("T1: a component that published no layout yields an empty map and a reason", () => {
  const map = rowOrigins({ render: () => ["one row"] }, WIDTH, 1);

  assert.deepEqual(map.rows, []);
  assert.equal(map.reason, "no-layout");
});

test("T1: a layout measured at another width yields an empty map and a reason", () => {
  const conversation = conversationFixture();
  const lines = conversation.render(WIDTH);

  const map = rowOrigins(conversation, WIDTH + 20, lines.length);

  assert.deepEqual(map.rows, []);
  assert.equal(map.reason, "width-mismatch");
});

test("T1: a layout whose heights do not add up to the frame yields an empty map, never a partial one", () => {
  const conversation = conversationFixture();
  const lines = conversation.render(WIDTH);

  const map = rowOrigins(conversation, WIDTH, lines.length + 1);

  assert.deepEqual(map.rows, [], "a partial map would attribute rows to the wrong child");
  assert.equal(map.reason, "height-mismatch");
});

test("T1: a malformed layout entry yields an empty map and a reason", () => {
  const broken = {
    mouseLayout: { width: WIDTH, children: [{ component: {}, height: -2 }] },
  };

  const map = rowOrigins(broken, WIDTH, -2);

  assert.deepEqual(map.rows, []);
  assert.equal(map.reason, "bad-layout");
});

test("T1: nothing it can be handed makes it throw", () => {
  for (const value of [null, undefined, 42, "container", {}, { mouseLayout: "nope" }]) {
    const map = rowOrigins(value, WIDTH, 3);
    assert.deepEqual(map.rows, []);
    assert.notEqual(map.reason, undefined);
  }
});

// ---------------------------------------------------------------------------------------------
// T3 — the wrapper builds the map after the host render and hands it over
// ---------------------------------------------------------------------------------------------

test("T3: the transform receives one origin per row, built after the host's own render", () => {
  const conversation = conversationFixture();
  assert.deepEqual(installCardStyleTransform(tuiFor(conversation)), {
    installed: true,
    outcome: "wrapped",
    component: "chat",
  });
  const frames: Array<readonly RowOrigin[] | undefined> = [];
  registerTransform({
    id: "probe.rows",
    transform: (lines, ctx) => {
      frames.push(ctx.rows);
      return lines;
    },
  });

  const drawn = conversation.render(WIDTH);

  assert.equal(frames.length, 1, "the transform ran once per frame, inside the wrapper");
  const rows = frames[0] ?? [];
  assert.equal(rows.length, drawn.length, "one origin entry per drawn row");
  assert.deepEqual(rows.map((row) => row.toolName), ORIGINS.toolName);
  assert.deepEqual(rows.map((row) => row.component), ORIGINS.component);
});

test("T3: a host render that publishes no layout hands the transform an empty map, never an error", () => {
  const conversation: FakeComponent = { render: () => ["plain row", "second row"] };
  installCardStyleTransform(tuiFor(conversation));
  const frames: Array<readonly RowOrigin[] | undefined> = [];
  registerTransform({
    id: "probe.no-layout",
    transform: (lines, ctx) => {
      frames.push(ctx.rows);
      return lines;
    },
  });

  const drawn = conversation.render(WIDTH);

  assert.deepEqual(drawn, ["plain row", "second row"], "the frame is drawn untouched");
  assert.deepEqual(frames, [[]], "an unknown origin is an empty array, not a guess");
});

test("T3: the rail runs no transcript transform, so no origin map is ever needed there", () => {
  const railLines = ["rail row one", "rail row two"];
  const tui = createRailTui({ rail: { render: () => [...railLines] }, contentWidth: WIDTH });
  assert.deepEqual(installRailCardStyleTransform(tui), {
    installed: true,
    outcome: "wrapped",
    component: "rail",
  });
  let calls = 0;
  registerTransform({
    id: "probe.rail",
    transform: (lines) => {
      calls += 1;
      return lines;
    },
  });

  const drawn = tui.renderRail();

  assert.deepEqual(drawn, railLines, "the rail's own rows are drawn untouched");
  assert.equal(calls, 0, "a plugin's conversation transform never sees the rail");
});

// ---------------------------------------------------------------------------------------------
// T2 — additive: a transform that ignores `rows` is byte-identical
// ---------------------------------------------------------------------------------------------

test("T2: a transform that ignores ctx.rows leaves the frame byte-identical", () => {
  const conversation = conversationFixture();
  const hostFrame = conversation.render(WIDTH);
  installCardStyleTransform(tuiFor(conversation));
  const seen: Array<readonly RowOrigin[] | undefined> = [];
  registerTransform({
    id: "probe.identity",
    transform: (lines, ctx) => {
      seen.push(ctx.rows);
      return lines;
    },
  });

  const drawn = conversation.render(WIDTH);

  assert.equal(seen.length, 1);
  assert.ok((seen[0] ?? []).length > 0, "the new field was delivered, so identity is not vacuous");
  assert.deepEqual(drawn, hostFrame);
  assert.equal(drawn.join("\n"), hostFrame.join("\n"), "the same bytes, row for row");
});
