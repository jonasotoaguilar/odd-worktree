/**
 * Rail interception (S4, S9), proven against the fake host.
 *
 * The host registers the `footer` part itself (`extensions/gentle-shell.ts:2827`), so our arming
 * may run before OR after it. This suite covers both orders, the pass-through of every field the
 * host's readers use (`digest` for the layout memo, `spend` for the Stats section), the mouse
 * delegation, idempotency across two installs / a rebind / a second package copy, the disable and
 * restore path, and the extension point T4 will use to contribute card groups.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SIDEBAR_RAIL_KEY,
  disableSidebarBackend,
  getSidebarDiagnostics,
  installSidebarBackend,
  resetSidebarStateForTests,
  setRailContributor,
} from "../src/sidebar.ts";
import {
  SIDEBAR_STATE_KEY,
  cardBody,
  cardTitles,
  fakeState,
  fakeTerminal,
  fakeTui,
  registerNativeFooter,
  registerNativeRail,
  renderSidebar,
  resetSidebar,
  type Rail,
} from "./fake-sidebar.ts";

interface NativeOptions {
  title?: string;
  body?: string[];
  render?: (width: number) => string[];
  cardGroups?: Rail["cardGroups"];
  handleMouse?: (event: unknown) => unknown;
}

interface NativeRail {
  rail: Rail;
  calls: {
    render: number;
    cardGroups: number;
    digest: number;
    spend: number;
    handleMouse: number;
    open: number;
  };
}

/** The host's own footer part: a real rail shape with every field a reader in the host touches. */
function nativeRail(options: NativeOptions = {}): NativeRail {
  const title = options.title ?? "FOOTER";
  const body = options.body ?? ["native row 1", "native row 2"];
  const calls = {
    render: 0,
    cardGroups: 0,
    digest: 0,
    spend: 0,
    handleMouse: 0,
    open: 0,
  };

  const rail: Rail = {
    render: (width) => {
      calls.render += 1;
      return options.render === undefined ? [`▾ ${title}`, ...body] : options.render(width);
    },
    cardGroups: (width) => {
      calls.cardGroups += 1;
      return options.cardGroups === undefined
        ? { groups: [{ start: 0, end: body.length + 1 }] }
        : options.cardGroups(width);
    },
    digest: () => {
      calls.digest += 1;
      return "footer:stable";
    },
    surface: "panel",
    summary: () => ({ row: "native summary" }),
    open: () => {
      calls.open += 1;
    },
    alert: () => ["needs you"],
    spend: () => {
      calls.spend += 1;
      return { runs: 2, tokens: 3, cost: 4 };
    },
    invalidate: () => {},
  };
  if (options.handleMouse !== undefined) {
    const handler = options.handleMouse;
    rail.handleMouse = (event) => {
      calls.handleMouse += 1;
      return handler(event);
    };
  }
  return { rail, calls };
}

const install = () => installSidebarBackend(() => fakeTui());
const footer = () => fakeState().parts.get(SIDEBAR_RAIL_KEY);

test.beforeEach(() => {
  resetSidebar();
  resetSidebarStateForTests();
  setRailContributor(undefined);
});

test("a footer the host registers after the bridge armed is captured", () => {
  fakeState(); // the host created its rail state at startup, with no footer part yet
  const result = install();

  assert.deepEqual(
    { installed: result.installed, outcome: result.outcome, rail: result.rail },
    { installed: true, outcome: "intercepted", rail: "pending" },
    "the map is intercepted even before the part exists",
  );
  assert.equal(footer(), undefined);

  const native = registerNativeFooter(nativeRail().rail);
  const wrapped = footer();

  assert.notEqual(wrapped, native, "the map hands out the wrapper, not the host's raw rail");
  assert.equal(wrapped, footer(), "one wrapper: a read never re-wraps");
  assert.deepEqual(wrapped?.render(40), native.render(40), "render delegates to the host's rail");
  assert.deepEqual(cardTitles(), ["FOOTER"]);
});

test("an already-registered footer is wrapped on install", () => {
  const { rail } = nativeRail();
  registerNativeFooter(rail);

  const result = install();

  assert.equal(result.outcome, "intercepted");
  assert.equal(result.rail, "wrapped");
  assert.notEqual(footer(), rail);
  assert.deepEqual(cardTitles(), ["FOOTER"]);
  assert.deepEqual(cardBody("FOOTER"), ["native row 1", "native row 2"]);
});

test("digest, spend, surface, summary, open, alert and invalidate reach their readers", () => {
  const { rail, calls } = nativeRail();
  registerNativeFooter(rail);
  install();

  const wrapped = footer();
  assert.ok(wrapped !== undefined);
  // The digest's VALUE is the host's own while nothing contributes rows (N14): the layout memo
  // compares values (`existing.digest === digest`), never function identity, so the wrapper may keep
  // forwarding the host's answer from its own function.
  const hostDigest = rail.digest?.();
  assert.equal(wrapped.digest?.(), hostDigest, "the host's digest value reaches its reader");
  assert.equal(calls.digest, 2, "each read calls the host's own function, once");
  assert.equal(wrapped.spend, rail.spend, "spend keeps its identity");
  assert.deepEqual(wrapped.spend?.(), { runs: 2, tokens: 3, cost: 4 });
  assert.equal(wrapped.surface, "panel");
  assert.equal(wrapped.summary, rail.summary);
  assert.deepEqual(wrapped.summary?.(), { row: "native summary" });
  assert.equal(wrapped.open, rail.open);
  wrapped.open?.();
  assert.equal(calls.open, 1);
  assert.equal(wrapped.alert, rail.alert);
  assert.deepEqual(wrapped.alert?.(40), ["needs you"]);

  // The host reads spend exactly like this (`gentle-shell.ts:2798`).
  assert.deepEqual(fakeState().parts.get("agents")?.spend?.(), undefined);
  registerNativeRail("agents", { ...rail });
  install();
  assert.deepEqual(fakeState().parts.get(SIDEBAR_RAIL_KEY)?.spend?.(), { runs: 2, tokens: 3, cost: 4 });
});

test("a throwing host render is rethrown and recorded, never swallowed", () => {
  registerNativeFooter(
    nativeRail({
      render: () => {
        throw new Error("host render exploded");
      },
    }).rail,
  );
  install();

  assert.throws(() => footer()?.render(40), /host render exploded/);

  const failures = getSidebarDiagnostics().lastFailures;
  assert.equal(failures.length, 1);
  assert.equal(failures[0].key, SIDEBAR_RAIL_KEY);
  assert.equal(failures[0].phase, "render");
  assert.equal(failures[0].message, "host render exploded");
});

test("a throwing host cardGroups is rethrown and recorded, never swallowed", () => {
  registerNativeFooter(
    nativeRail({
      cardGroups: () => {
        throw new Error("host groups exploded");
      },
    }).rail,
  );
  install();

  assert.throws(() => footer()?.cardGroups?.(40), /host groups exploded/);
  const failure = getSidebarDiagnostics().lastFailures.at(-1);
  assert.equal(failure?.phase, "cardGroups");
  assert.equal(failure?.message, "host groups exploded");
});

test("a second install on the same tui does not stack a wrapper or duplicate groups", () => {
  const { rail, calls } = nativeRail();
  registerNativeFooter(rail);
  assert.equal(install().outcome, "intercepted");
  const first = footer();

  const second = install();

  assert.equal(second.outcome, "already-intercepted");
  assert.equal(footer(), first, "the same wrapper object, not a wrapper of a wrapper");

  calls.render = 0;
  calls.cardGroups = 0;
  const rows = renderSidebar(40);
  assert.equal(calls.render, 1, "one frame renders the host's rail exactly once");
  assert.equal(calls.cardGroups, 1, "and reads its card groups exactly once");
  assert.deepEqual(
    rows.filter((row) => row.startsWith("╭")).length,
    1,
    "one card, not the same card twice",
  );
});

test("a rebind onto a fresh ui object for the same terminal does not re-wrap", () => {
  const { rail } = nativeRail();
  registerNativeFooter(rail);
  install();
  const first = footer();

  const rebound = installSidebarBackend(() => ({ terminal: fakeTerminal() }));

  assert.equal(rebound.outcome, "already-intercepted");
  assert.equal(footer(), first);
});

test("a second copy of the package sees the interception and does not stack", async () => {
  const { rail } = nativeRail();
  registerNativeFooter(rail);
  install();
  const first = footer();

  const secondCopySpecifier = "../src/sidebar.ts?copy=2";
  const copyTwo: typeof import("../src/sidebar.ts") = await import(secondCopySpecifier);
  assert.notEqual(copyTwo, await import("../src/sidebar.ts"));

  const result = copyTwo.installSidebarBackend(() => fakeTui());

  assert.equal(result.outcome, "already-intercepted");
  assert.equal(footer(), first, "the marker on the map is process-global, like the slot");
});

test("disableSidebarBackend restores the host rail and the map's own methods", () => {
  const { rail } = nativeRail();
  registerNativeFooter(rail);
  install();

  const parts = fakeState().parts;
  const wrapped = footer();
  assert.ok(Object.hasOwn(parts, "set"), "the map is intercepted through an own property");
  assert.ok(Object.hasOwn(parts, "get"));
  assert.notEqual(footer(), rail);

  assert.equal(disableSidebarBackend(), 1);

  assert.equal(Object.hasOwn(parts, "set"), false, "the prototype's own set/get are in force again");
  assert.equal(Object.hasOwn(parts, "get"), false);
  assert.equal(fakeState().parts.get(SIDEBAR_RAIL_KEY), rail, "the host's rail is back in the map");

  // A wrapper retained by foreign code must be a plain pass-through now.
  assert.deepEqual(wrapped?.render(40), ["▾ FOOTER", "native row 1", "native row 2"]);
});

test("a foreign wrapper already on the rail is wrapped around, never clobbered", () => {
  const { rail } = nativeRail();
  let foreignCalls = 0;
  const foreign: Rail = {
    ...rail,
    render: (width) => {
      foreignCalls += 1;
      return rail.render(width);
    },
  };
  registerNativeFooter(foreign);

  install();

  const wrapped = footer();
  assert.ok(wrapped !== undefined);
  assert.notEqual(wrapped, foreign, "we wrap the foreign wrapper instead of replacing it");
  wrapped.render(40);
  assert.equal(foreignCalls, 1, "the foreign wrapper still runs");
  assert.equal(wrapped.digest?.(), rail.digest?.(), "and its fields still flow through ours");
});

test("an unknown tui shape is reported, never thrown", () => {
  const noTui = installSidebarBackend(() => undefined);
  assert.deepEqual(
    { installed: noTui.installed, outcome: noTui.outcome },
    { installed: false, outcome: "no-sidebar-state" },
  );

  const noTerminal = installSidebarBackend(() => ({}));
  assert.equal(noTerminal.outcome, "no-sidebar-state");

  const noState = installSidebarBackend(() => ({ terminal: fakeTerminal(), parts: new Map() }));
  assert.equal(noState.outcome, "no-sidebar-state", "a parts map outside the host's slot is not the host's");

  const badState = installSidebarBackend(() => ({
    terminal: { [SIDEBAR_STATE_KEY]: { parts: "not a map" } },
  }));
  assert.equal(badState.outcome, "no-sidebar-state");

  const threw = installSidebarBackend(() => {
    throw new Error("no tui yet");
  });
  assert.equal(threw.installed, false);
  assert.equal(threw.outcome, "resolver-threw");
  assert.equal(threw.reason, "no tui yet");
});

test("a resolver that starts returning a tui lets a later install succeed", () => {
  let available: { terminal: Record<string | symbol, unknown> } | undefined;
  const resolve = () => available;

  assert.equal(installSidebarBackend(resolve).outcome, "no-sidebar-state");

  // The wiring resolved a real tui in between (a widget factory fired, say).
  fakeState();
  registerNativeFooter(nativeRail().rail);
  available = fakeTui();

  const result = installSidebarBackend(resolve);
  assert.equal(result.outcome, "intercepted");
  assert.notEqual(footer(), undefined);
});

test("the contributor appends its lines and card groups after the host's own", () => {
  registerNativeFooter(nativeRail().rail);
  install();
  setRailContributor({
    render: () => ({ after: { lines: ["▾ EXTRA", "extra row"], groups: [{ start: 0, end: 2 }] } }),
  });

  const wrapped = footer();
  assert.ok(wrapped !== undefined);
  assert.deepEqual(wrapped.render(40), [
    "▾ FOOTER",
    "native row 1",
    "native row 2",
    "▾ EXTRA",
    "extra row",
  ]);
  assert.deepEqual(wrapped.cardGroups?.(40), {
    groups: [
      { start: 0, end: 3 },
      { start: 3, end: 5 },
    ],
  });

  assert.deepEqual(cardTitles(), ["FOOTER", "EXTRA"], "the host frames our rows as its own card");
  assert.deepEqual(cardBody("EXTRA"), ["extra row"]);
});

test("a host rail without cardGroups gets one synthesized group covering native and contributed rows", () => {
  registerNativeFooter(nativeRail({ cardGroups: undefined, body: ["only row"] }).rail);
  const parts = fakeState().parts;
  const native = parts.get(SIDEBAR_RAIL_KEY);
  assert.ok(native !== undefined);
  delete (native as { cardGroups?: unknown }).cardGroups;
  install();
  setRailContributor({
    render: () => ({ after: { lines: ["▾ EXTRA", "extra row"], groups: [{ start: 0, end: 2 }] } }),
  });

  assert.deepEqual(footer()?.cardGroups?.(40), {
    groups: [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ],
  });
  assert.deepEqual(cardTitles(), ["FOOTER", "EXTRA"]);
});

test("no host frame means no contribution: an empty render stays empty", () => {
  registerNativeFooter(
    nativeRail({ render: () => [], cardGroups: () => ({ groups: [] }) }).rail,
  );
  install();
  setRailContributor({
    render: () => ({ after: { lines: ["▾ EXTRA", "extra row"], groups: [{ start: 0, end: 2 }] } }),
  });

  assert.deepEqual(footer()?.render(40), [], "the host painted nothing, so neither do we");
  assert.deepEqual(footer()?.cardGroups?.(40), { groups: [] });
  assert.deepEqual(renderSidebar(40), []);
});

test("mouse dispatch goes to the host rail first; our targets only after it declines", () => {
  const handled = { handled: true, render: true };
  registerNativeFooter(
    nativeRail({ handleMouse: (event) => (event === "hit" ? handled : undefined) }).rail,
  );
  install();
  const ours: unknown[] = [];
  setRailContributor({
    render: () => undefined,
    handleMouse: (event: unknown) => {
      ours.push(event);
      return { handled: true, render: true, ours: true };
    },
  });

  const wrapped = footer();
  assert.ok(wrapped?.handleMouse !== undefined);
  assert.deepEqual(wrapped.handleMouse("hit"), handled);
  assert.deepEqual(ours, [], "the host handled it, so our targets are not consulted");

  assert.deepEqual(wrapped.handleMouse("miss"), { handled: true, render: true, ours: true }, "our target answers");
  assert.deepEqual(ours, ["miss"]);
});

test("our mouse targets work even when the host rail has no mouse handler", () => {
  registerNativeFooter(nativeRail().rail); // no handleMouse on the host's rail
  install();
  setRailContributor({ render: () => undefined, handleMouse: () => ({ ours: true }) });

  assert.deepEqual(footer()?.handleMouse?.("event"), { ours: true });
});

test("a throwing contributor is recorded and leaves every host row rendering", () => {
  registerNativeFooter(nativeRail().rail);
  install();
  setRailContributor({
    render: () => {
      throw new Error("section renderer exploded");
    },
  });

  const wrapped = footer();
  assert.deepEqual(wrapped?.render(40), ["▾ FOOTER", "native row 1", "native row 2"]);
  assert.deepEqual(cardTitles(), ["FOOTER"], "the host's own card still draws");

  const failure = getSidebarDiagnostics().lastFailures.at(-1);
  assert.equal(failure?.message, "section renderer exploded");
  assert.equal(failure?.phase, "contribute");
});

test("the interception wraps every painted part, and no key the layout never paints", () => {
  fakeState();
  install();
  const todo = nativeRail({ title: "TODO" }).rail;
  registerNativeRail("todo", todo);
  registerNativeFooter(nativeRail().rail);
  // `header` and `statusbar` are parts the host registers but the rail never paints
  // (`lib/shell-sidebar-layout.ts:344`); wrapping them would put our rows nowhere.
  const header = nativeRail({ title: "HEADER" }).rail;
  registerNativeRail("header", header);

  assert.notEqual(fakeState().parts.get("todo"), todo, "a painted part is wrapped (a section may sit before it)");
  assert.deepEqual(fakeState().parts.get("todo")?.render(40), todo.render(40), "and still renders the host's rows");
  assert.equal(fakeState().parts.get("header"), header, "an unpainted key keeps its own identity");
  assert.notEqual(footer(), undefined);
  assert.deepEqual(cardTitles(), ["TODO", "FOOTER"]);
});
