import assert from "node:assert/strict";
import test from "node:test";

import { observedHostCategories, registerRows, resetBusForTests } from "../src/bus.ts";
import {
  getCaptureDiagnostics,
  installCaptureBackend,
  resetCaptureStateForTests,
} from "../src/capture.ts";
import { getConfigHome } from "../src/config.ts";
import type { CustomizeRow, RowContext, RowProvider } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";

test.beforeEach(() => {
  resetBusForTests();
  resetCaptureStateForTests();
});

/** A provider whose rows are plain labelled actions in one category. */
const labelsProvider = (id: string, category: string, labels: string[]): RowProvider => ({
  id,
  category,
  rows: () => labels.map((label) => ({ label, action: () => {} })),
});

test("installs on the instance and injects provider rows after the host's own rows", () => {
  const host = createFakeHost();
  registerRows(labelsProvider("p1", "Cards", ["Provider one", "Provider two"]));

  const result = installCaptureBackend(host.ui);

  assert.equal(result.armed, true);
  assert.equal(result.target, "instance");
  assert.equal(result.outcome, "armed");

  const component = host.buildMenu();

  assert.deepEqual(host.rendered(), [
    "Card bash: builtin",
    "Card output: builtin",
    "Banner: builtin",
    "Layout: builtin",
    "Provider one",
    "Provider two",
  ]);
  assert.equal(host.invalidateCount(), 1, "invalidate is called once after injecting");
  assert.ok(component !== undefined, "the adapter is returned unchanged");
  assert.equal(
    "rows" in (component as object),
    false,
    "the adapter hides the rows — duck-typing options.rows never matches",
  );
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, {
    kind: "injected",
    injectedRows: 2,
  });
});

test("installs on the prototype when the instance has no own custom", () => {
  const host = createFakeHost({ customShape: "prototype" });
  registerRows(labelsProvider("p1", "Cards", ["Proto one"]));

  const result = installCaptureBackend(host.ui);

  assert.equal(result.armed, true);
  assert.equal(result.target, "prototype");
  assert.equal(
    Object.prototype.hasOwnProperty.call(host.ui, "custom"),
    false,
    "wrapping the prototype must not create an own property on the instance",
  );

  host.buildMenu();

  assert.deepEqual(host.rendered().slice(-1), ["Proto one"]);
});

test("two providers coexist in one menu, in subscription order", () => {
  const host = createFakeHost();
  registerRows(labelsProvider("first", "Cards", ["First a"]));
  registerRows(labelsProvider("second", "Banner", ["Second b"]));
  installCaptureBackend(host.ui);

  host.buildMenu();
  const rows = host.liveRows();

  assert.deepEqual(
    rows.slice(4).map((row) => [row.category, row.label]),
    [
      ["Cards", "First a"],
      ["Banner", "Second b"],
    ],
  );
});

test("a throwing provider loses only its own rows and is recorded", () => {
  const host = createFakeHost();
  registerRows(labelsProvider("before", "Cards", ["Before ok"]));
  registerRows({
    id: "boom",
    category: "Banner",
    rows: () => {
      throw new Error("provider exploded");
    },
  });
  registerRows(labelsProvider("after", "Layout", ["After ok"]));
  installCaptureBackend(host.ui);

  host.buildMenu();

  assert.deepEqual(host.rendered().slice(4), ["Before ok", "After ok"]);
  assert.deepEqual(getCaptureDiagnostics().lastFailures, [
    { providerId: "boom", message: "provider exploded", rowsDropped: true },
  ]);
});

test("rows from a provider that throws part-way are all dropped, not half-applied", () => {
  const host = createFakeHost();
  registerRows({
    id: "partial",
    category: "Cards",
    rows: () => {
      const rows: CustomizeRow[] = [{ label: "kept?", action: () => {} }];
      // Building the second row throws: the first must not leak into the menu.
      const explode = (): CustomizeRow => {
        throw new Error("second row exploded");
      };
      rows.push(explode());
      return rows;
    },
  });
  installCaptureBackend(host.ui);

  host.buildMenu();

  assert.deepEqual(host.rendered().slice(4), []);
  assert.deepEqual(getCaptureDiagnostics().lastFailures, [
    { providerId: "partial", message: "second row exploded", rowsDropped: true },
  ]);
});

test("provider.category fills a row's missing category, and the provider's row is not mutated", () => {
  const host = createFakeHost();
  const ownCategoryRow: CustomizeRow = { category: "Banner", label: "Own category", action: () => {} };
  const inheritedCategoryRow: CustomizeRow = { label: "Inherited category", action: () => {} };
  registerRows({
    id: "categories",
    category: "Layout",
    rows: () => [ownCategoryRow, inheritedCategoryRow],
  });
  installCaptureBackend(host.ui);

  host.buildMenu();
  const injected = host.liveRows().slice(4);

  assert.deepEqual(
    injected.map((row) => row.category),
    ["Banner", "Layout"],
  );
  assert.equal(
    inheritedCategoryRow.category,
    undefined,
    "the row the provider returned is not mutated",
  );
  assert.notEqual(injected[1], inheritedCategoryRow, "the filled row is a shallow clone");
});

test("providers receive the active theme and the resolved config home", () => {
  const theme = { name: "theme-under-test" };
  const host = createFakeHost({ theme });
  let received: RowContext | undefined;
  registerRows({
    id: "ctx",
    category: "Cards",
    rows: (ctx) => {
      received = ctx;
      return [];
    },
  });
  installCaptureBackend(host.ui);

  host.buildMenu();

  assert.equal(received?.theme, theme, "the factory's second argument is the theme");
  assert.equal(received?.configHome, getConfigHome());
});

test("Array.prototype.map identity is restored on success", () => {
  const host = createFakeHost();
  registerRows(labelsProvider("p1", "Cards", ["Row"]));
  installCaptureBackend(host.ui);
  const before = Array.prototype.map;

  host.buildMenu();

  assert.equal(Array.prototype.map, before);
});

test("Array.prototype.map identity is restored when the factory throws", () => {
  const host = createFakeHost({ throwInsideFactory: true });
  registerRows(labelsProvider("p1", "Cards", ["Row"]));
  installCaptureBackend(host.ui);
  const before = Array.prototype.map;

  assert.throws(() => host.buildMenu(), /factory exploded/);

  assert.equal(Array.prototype.map, before);
});

test("Array.prototype.map identity is restored when the captured array is not a row array", () => {
  const host = createFakeHost({ mapOnlyNonRows: true });
  registerRows(labelsProvider("p1", "Cards", ["Must not appear"]));
  installCaptureBackend(host.ui);
  const before = Array.prototype.map;

  host.buildMenu();

  assert.equal(Array.prototype.map, before);
  assert.deepEqual(
    host.rendered().filter((label) => label === "Must not appear"),
    [],
    "a plain array of numbers is never injected into",
  );
  assert.equal(host.invalidateCount(), 0, "nothing was injected, so nothing was invalidated");
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, {
    kind: "uncaptured",
    injectedRows: 0,
    reason: "no-capture",
  });
});

test("an async factory is returned unchanged and recorded as uncaptured", async () => {
  const host = createFakeHost({ factoryResult: "promise" });
  registerRows(labelsProvider("p1", "Cards", ["Late row"]));
  installCaptureBackend(host.ui);
  const before = Array.prototype.map;

  const result = host.buildMenu();

  assert.ok(result instanceof Promise, "the promise is returned unchanged");
  await result;
  assert.equal(Array.prototype.map, before);
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, {
    kind: "uncaptured",
    injectedRows: 0,
    reason: "async-factory",
  });
});

test("a second install on the same ui does not double-wrap", () => {
  const host = createFakeHost();
  registerRows(labelsProvider("p1", "Cards", ["Once"]));

  assert.equal(installCaptureBackend(host.ui).outcome, "armed");
  const second = installCaptureBackend(host.ui);
  assert.equal(second.armed, false);
  assert.equal(second.outcome, "already-armed");

  host.buildMenu();

  assert.deepEqual(
    host.rendered().filter((label) => label === "Once"),
    ["Once"],
    "rows injected exactly once",
  );
  assert.equal(host.invalidateCount(), 1);
  assert.equal(getCaptureDiagnostics().armedTargets, 1);
});

test("the same menu built twice injects once", () => {
  const host = createFakeHost();
  registerRows(labelsProvider("p1", "Cards", ["Once"]));
  installCaptureBackend(host.ui);

  host.buildMenu();
  host.buildMenu();

  assert.deepEqual(host.rendered().filter((label) => label === "Once"), ["Once"]);
  assert.equal(host.invalidateCount(), 1, "the second build marks the array and skips injection");
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, {
    kind: "already-injected",
    injectedRows: 0,
  });
});

test("a throwing nested custom call neither loses the outer patch nor double-installs it", () => {
  const host = createFakeHost();
  registerRows(labelsProvider("p1", "Cards", ["Outer row"]));
  installCaptureBackend(host.ui);
  const before = Array.prototype.map;

  // The outer factory triggers another wrapped `custom` call whose factory throws, then keeps
  // building its own menu. If the nested call had installed its own patch and restored `map` in
  // its own `finally`, the outer patch would be gone and the outer rows array would never be
  // captured.
  let outerInvalidations = 0;
  const outerRows: CustomizeRow[] = [
    { category: "Cards", label: "Outer: builtin one", action: () => {} },
    { category: "Cards", label: "Outer: builtin two", action: () => {} },
    { category: "Banner", label: "Outer: builtin three", action: () => {} },
  ];
  const component = host.ui.custom!((_ui, _theme) => {
    try {
      host.ui.custom!(() => {
        throw new Error("inner exploded");
      });
    } catch {
      // the host survives a nested failure
    }
    outerRows.map((row) => row.category ?? "Settings");
    return {
      render: () => outerRows.map((row) => String(row.label)),
      handleInput: () => {},
      invalidate: () => {
        outerInvalidations += 1;
      },
      dispose: () => {},
    };
  });

  assert.ok(component !== undefined);
  assert.deepEqual(
    outerRows.map((row) => row.label),
    ["Outer: builtin one", "Outer: builtin two", "Outer: builtin three", "Outer row"],
    "the provider's row landed in the outer rows array captured after the nested throw",
  );
  assert.equal(Array.prototype.map, before, "map identity restored after the outermost call");
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, {
    kind: "injected",
    injectedRows: 1,
  });
  assert.equal(outerInvalidations, 1, "the outer component is the one invalidated");
  assert.equal(getCaptureDiagnostics().nestingDepth, 0, "the nesting counter is back to zero");
  assert.equal(getCaptureDiagnostics().armedTargets, 1, "one wrapped target, no second patch");
});

test("providers registering during a build do not disturb the fan-out", () => {
  const host = createFakeHost();
  registerRows({
    id: "early",
    category: "Cards",
    rows: () => {
      registerRows(labelsProvider("late", "Banner", ["Late: registered during build"]));
      return [{ label: "Early ok", action: () => {} }];
    },
  });
  installCaptureBackend(host.ui);

  host.buildMenu();

  assert.deepEqual(host.rendered().slice(4), ["Early ok"]);
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, {
    kind: "injected",
    injectedRows: 1,
  });
});

// ---------------------------------------------------------------------------------------------
// Row placement (S4, S5, S6): the capture backend splices blocks into the host's own array
// ---------------------------------------------------------------------------------------------

/** Labels as the host would render them, including function labels. */
const rowLabels = (rows: readonly CustomizeRow[]): string[] =>
  rows.map((row) => (typeof row.label === "function" ? row.label() : (row.label ?? "")));

/** The host's own rows: Cards (two), Banner, Layout. */
const hostRows = (): CustomizeRow[] => [
  { category: "Cards", label: "Card bash: builtin", action: () => {} },
  { category: "Cards", label: "Card output: builtin", action: () => {} },
  { category: "Banner", label: "Banner: builtin", action: () => {} },
  { category: "Layout", label: "Layout: builtin", action: () => {} },
];

/**
 * A host that maps its rows to labels inside the factory but never derives categories there, so the
 * provisional early path cannot prove an array: the late path is the only one that injects.
 */
const lateOnlyHost = (rows: CustomizeRow[]) => {
  const ui = {
    custom: (factory: (ui: unknown, theme: unknown, ...rest: unknown[]) => unknown): unknown =>
      factory(ui, undefined),
  };
  return {
    rows,
    ui,
    build: (): unknown =>
      ui.custom(() => {
        rows.map((row) => row.label);
        return { invalidate: () => {} };
      }),
  };
};

test("a start provider's block is spliced before its category's host rows (late path)", () => {
  const rows = hostRows();
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.top",
    category: "Layout",
    placement: "start",
    rows: () => [{ label: "Top", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  assert.deepEqual(rowLabels(rows), [
    "Card bash: builtin",
    "Card output: builtin",
    "Banner: builtin",
    "Top",
    "Layout: builtin",
  ]);
  assert.deepEqual(
    observedHostCategories(),
    ["Cards", "Banner", "Layout"],
    "the categories the host really had are recorded for /bridge-status",
  );
});

test("an explicit end provider's block lands after its category's host rows (late path)", () => {
  const rows = hostRows();
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.after-banner",
    category: "Banner",
    placement: "end",
    rows: () => [{ label: "After banner", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  assert.deepEqual(rowLabels(rows), [
    "Card bash: builtin",
    "Card output: builtin",
    "Banner: builtin",
    "After banner",
    "Layout: builtin",
  ]);
});

test("an after block follows a provider that is itself at start (late path)", () => {
  const rows = hostRows();
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.top",
    category: "Layout",
    placement: "start",
    rows: () => [{ label: "Top", action: () => {} }],
  });
  registerRows({
    id: "loon.next",
    category: "Layout",
    placement: { after: "loon.top" },
    rows: () => [{ label: "Next", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  assert.deepEqual(rowLabels(rows), [
    "Card bash: builtin",
    "Card output: builtin",
    "Banner: builtin",
    "Top",
    "Next",
    "Layout: builtin",
  ]);
});

test("two providers in one category keep the S2 order whatever their registration order", () => {
  const build = (ids: readonly string[]): string[] => {
    resetBusForTests();
    const rows = hostRows();
    const host = lateOnlyHost(rows);
    for (const id of ids) {
      registerRows({
        id,
        category: "Layout",
        placement: "end",
        rows: () => [{ label: id === "loon.z" ? "Zed" : "Alpha", action: () => {} }],
      });
    }
    installCaptureBackend(host.ui);
    host.build();
    return rowLabels(rows);
  };

  const first = build(["loon.z", "loon.a"]);
  const second = build(["loon.a", "loon.z"]);

  assert.deepEqual(first, second, "the same registrations in either order draw the same rows");
  assert.deepEqual(first.slice(-2), ["Alpha", "Zed"], "ties are broken by id, not by load order");
});

test("a throwing provider loses only its own rows and does not disturb another placement", () => {
  const rows = hostRows();
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.top",
    category: "Layout",
    placement: "start",
    rows: () => [{ label: "Top", action: () => {} }],
  });
  registerRows({
    id: "boom",
    category: "Banner",
    placement: "end",
    rows: () => {
      throw new Error("provider exploded");
    },
  });
  registerRows({
    id: "loon.last",
    category: "Layout",
    placement: "end",
    rows: () => [{ label: "Last", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  assert.deepEqual(rowLabels(rows), [
    "Card bash: builtin",
    "Card output: builtin",
    "Banner: builtin",
    "Top",
    "Layout: builtin",
    "Last",
  ]);
  assert.deepEqual(getCaptureDiagnostics().lastFailures, [
    { providerId: "boom", message: "provider exploded", rowsDropped: true },
  ]);
});

test("no insertion splits a consumed choice.setting pair", () => {
  const rows: CustomizeRow[] = [
    {
      category: "Cards",
      label: "Pair on",
      action: () => {},
      choice: { setting: "Pair", value: "on", current: () => true },
    },
    {
      category: "Cards",
      label: "Pair off",
      action: () => {},
      choice: { setting: "Pair", value: "off", current: () => false },
    },
    { category: "Banner", label: "Banner: builtin", action: () => {} },
    { category: "Layout", label: "Layout: builtin", action: () => {} },
  ];
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.before",
    category: "Cards",
    placement: "start",
    rows: () => [{ label: "Before pair", action: () => {} }],
  });
  registerRows({
    id: "loon.after",
    category: "Cards",
    placement: "end",
    rows: () => [{ label: "After pair", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  const pairIndices = rows
    .map((row, index) => (row.choice?.setting === "Pair" ? index : -1))
    .filter((index) => index !== -1);
  assert.deepEqual(pairIndices, [1, 2], "the pair stays consecutive, after the start block");
  assert.deepEqual(rowLabels(rows), [
    "Before pair",
    "Pair on",
    "Pair off",
    "After pair",
    "Banner: builtin",
    "Layout: builtin",
  ]);
});
