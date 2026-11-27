/**
 * T4 regression cases from independent verification (S4–S6).
 *
 * Each case below is a defect the verifier reproduced against the T1–T3 slices: a provider's
 * DECLARED category used as the block boundary, an unplaced provider moved because another one opted
 * in, rollback by identity deleting a host row, a partially applied splice over a read-only index,
 * and `/bridge-status` printing the plan instead of the landing a frozen array produced.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { registerRows, resetBusForTests } from "../src/bus.ts";
import { getCaptureDiagnostics, installCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetNoticesForTests, snapshotNotices } from "../src/notices.ts";
import type { CustomizeRow } from "../src/types.ts";
import { createFakeHost } from "./fake-host.ts";

const labelText = (row: CustomizeRow): string =>
  typeof row.label === "function" ? row.label() : (row.label ?? "");

const labels = (rows: readonly CustomizeRow[]): string[] => rows.map(labelText);

const page = (rows: readonly CustomizeRow[], category: string): string[] =>
  rows
    .filter((row) => (row.category ?? "Settings") === category)
    .map(labelText);

const hostRows = (): CustomizeRow[] => [
  { category: "Cards", label: "Card bash: builtin", action: () => {} },
  { category: "Cards", label: "Card output: builtin", action: () => {} },
  { category: "Banner", label: "Banner: builtin", action: () => {} },
  { category: "Layout", label: "Layout: builtin", action: () => {} },
];


/** A throwing early host: the build appends first, then `afterAppend` mutates, then it throws. */
const throwingHostAfter = (
  providerRows: CustomizeRow[],
  afterAppend: (rows: CustomizeRow[]) => void = () => {},
) => {
  const rows = hostRows();
  const originalError = new Error("factory exploded");
  const ui = {
    custom: (factory: (ui: unknown, theme: unknown, ...rest: unknown[]) => unknown): unknown =>
      factory(ui, undefined),
  };
  const host = {
    ui,
    build: (): unknown =>
      ui.custom(() => {
        rows.map((row) => row.category ?? "Settings");
        afterAppend(rows);
        throw originalError;
      }),
  };
  registerRows({ id: "loon.injected", category: "Layout", rows: () => providerRows });
  installCaptureBackend(host.ui);
  return { rows, host, originalError };
};
/** A host that maps its rows to labels but never derives categories: the late path injects. */
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

test.beforeEach(() => {
  resetBusForTests();
  resetCaptureStateForTests();
  resetNoticesForTests();
});

test("a row's own category is its block boundary, not the provider's declared category", () => {
  const pair = (label: string, value: string): CustomizeRow => ({
    category: "Cards",
    label,
    action: () => {},
    choice: { setting: "Pair", value, current: () => value === "first", applyOnMove: false },
  });
  // Cards rows are not contiguous in the host array: the renderer still shows one Cards page.
  const rows: CustomizeRow[] = [
    pair("First value", "first"),
    { category: "Banner", label: "Host banner", action: () => {} },
    pair("Second value", "second"),
    { category: "Layout", label: "Host layout", action: () => {} },
  ];
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.plain",
    // The provider declares Banner, but the row it contributes belongs to Cards.
    category: "Banner",
    placement: "start",
    rows: () => [{ category: "Cards", label: "Plain row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  const cards = page(rows, "Cards");
  assert.deepEqual(cards, ["Plain row", "First value", "Second value"]);
  const pairIndices = cards
    .map((label, index) => (label === "First value" || label === "Second value" ? index : -1))
    .filter((index) => index !== -1);
  assert.equal(pairIndices[1], (pairIndices[0] ?? 0) + 1, "the rendered Cards pair is never split");
});

test("a provider that opts into nothing keeps the pre-feature tail append", () => {
  const rows = hostRows();
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.top",
    category: "Cards",
    placement: "start",
    rows: () => [{ label: "Start row", action: () => {} }],
  });
  registerRows({
    id: "loon.plain",
    category: "Cards",
    rows: () => [{ label: "Plain row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  assert.deepEqual(labels(rows), [
    "Start row",
    "Card bash: builtin",
    "Card output: builtin",
    "Banner: builtin",
    "Layout: builtin",
    "Plain row",
  ]);
  assert.deepEqual(page(rows, "Cards"), ["Start row", "Card bash: builtin", "Card output: builtin", "Plain row"]);
});

test("unplaced pages keep their subscription order when another provider opts in", () => {
  const rows = hostRows();
  const host = createFakeHost({ rows });
  registerRows({
    id: "loon.top",
    category: "Cards",
    placement: "start",
    rows: () => [{ label: "Top row", action: () => {} }],
  });
  registerRows({
    id: "loon.zeta",
    category: "Zeta page",
    rows: () => [{ label: "Zeta row", action: () => {} }],
  });
  registerRows({
    id: "loon.alpha",
    category: "Alpha page",
    rows: () => [{ label: "Alpha row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.buildMenu();

  assert.deepEqual([...new Set(host.categories())], [
    "Cards",
    "Banner",
    "Layout",
    "Zeta page",
    "Alpha page",
  ]);
});

test("with no provider opting in, pages keep the pre-feature tail order", () => {
  const rows = hostRows();
  const host = createFakeHost({ rows });
  registerRows({
    id: "loon.zeta",
    category: "Zeta page",
    rows: () => [{ label: "Zeta row", action: () => {} }],
  });
  registerRows({
    id: "loon.alpha",
    category: "Alpha page",
    rows: () => [{ label: "Alpha row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.buildMenu();

  assert.deepEqual([...new Set(host.categories())], [
    "Cards",
    "Banner",
    "Layout",
    "Zeta page",
    "Alpha page",
  ]);
});

test("rollback restores a host row object that a provider handed back", async () => {
  const shared: CustomizeRow = {
    category: "Cards",
    label: "Shared row",
    action: () => {},
    choice: { setting: "Shared setting", value: "on", current: () => true, applyOnMove: false },
  };
  const rows: CustomizeRow[] = [
    shared,
    { category: "Cards", label: "Card tail", action: () => {} },
    { category: "Banner", label: "Banner: builtin", action: () => {} },
    { category: "Layout", label: "Layout: builtin", action: () => {} },
  ];
  const host = createFakeHost({ rows, factoryResult: "promise" });
  registerRows({
    id: "loon.shared",
    category: "Cards",
    rows: () => [shared],
  });
  installCaptureBackend(host.ui);
  const before = [...rows];

  await host.buildMenu();

  assert.equal(rows.length, before.length, "same length");
  assert.ok(
    rows.every((row, index) => row === before[index]),
    "the host's own row objects come back in the host's own order",
  );
});

test("a read-only index skips the move instead of half-applying it", () => {
  const rows = hostRows();
  Object.defineProperty(rows, "1", {
    value: rows[1],
    writable: false,
    enumerable: true,
    configurable: true,
  });
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.top",
    category: "Cards",
    placement: "start",
    rows: () => [{ label: "Placed row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  assert.doesNotThrow(() => host.build());

  assert.deepEqual(labels(rows), [
    "Card bash: builtin",
    "Card output: builtin",
    "Banner: builtin",
    "Layout: builtin",
    "Placed row",
  ]);
  assert.deepEqual(getCaptureDiagnostics().lastOutcome, { kind: "injected", injectedRows: 1 });

  const placement = collectStatus().providers[0]?.placement;
  assert.equal(placement?.requested, "start");
  assert.equal(placement?.landed, "end");
  assert.match(placement?.reason ?? "", /read-only|would not accept|planned write/);
});

test("a frozen array after the provisional injection reports the landing it really got", () => {
  const rows = hostRows();
  const ui = {
    custom: (factory: (ui: unknown, theme: unknown, ...rest: unknown[]) => unknown): unknown =>
      factory(ui, undefined),
  };
  const host = {
    ui,
    build: (): unknown =>
      ui.custom(() => {
        rows.map((row) => row.category ?? "Settings");
        Object.freeze(rows);
        return { invalidate: () => {} };
      }),
  };
  registerRows({
    id: "loon.top",
    category: "Layout",
    placement: "start",
    rows: () => [{ label: "Top row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  assert.deepEqual(labels(rows), [
    "Card bash: builtin",
    "Card output: builtin",
    "Banner: builtin",
    "Layout: builtin",
    "Top row",
  ]);
  const provider = collectStatus().providers[0];
  assert.equal(provider?.placement?.requested, "start");
  assert.equal(provider?.placement?.landed, "end");
  assert.match(provider?.placement?.reason ?? "", /frozen|read-only|would not accept|planned write/);
  assert.ok(
    formatStatus(collectStatus()).some((line) =>
      /^  - loon\.top \(Layout\), placement start → end \(.+\)$/u.test(line),
    ),
  );
});

test("a recorded landing keeps the resolver's exact fallback reason", () => {
  const rows = hostRows();
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.lost",
    category: "Layout",
    placement: { after: "loon.nope" },
    rows: () => [{ label: "Lost row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  const placement = collectStatus().providers[0]?.placement;
  assert.equal(placement?.requested, 'after "loon.nope"');
  assert.equal(placement?.landed, "end");
  assert.equal(
    placement?.reason,
    'after "loon.nope" is not a registered row provider id',
    "the verifier-pinned reason survives the landing report",
  );
});

test("an after anchor naming an unopted provider lands after that provider's tail block", () => {
  const rows = hostRows();
  const host = lateOnlyHost(rows);
  registerRows({
    id: "loon.anchor",
    // No placement and no order: this provider keeps the pre-feature tail append.
    category: "Layout",
    rows: () => [{ label: "Anchor row", action: () => {} }],
  });
  registerRows({
    id: "loon.after",
    category: "Layout",
    placement: { after: "loon.anchor" },
    rows: () => [{ label: "After row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  host.build();

  assert.deepEqual(page(rows, "Layout"), ["Layout: builtin", "Anchor row", "After row"]);
  const placement = collectStatus().providers.find((provider) => provider.id === "loon.after")
    ?.placement;
  assert.equal(placement?.requested, 'after "loon.anchor"');
  assert.equal(placement?.landed, 'after "loon.anchor"');
  assert.equal(placement?.reason, undefined);
  assert.ok(
    formatStatus(collectStatus()).some((line) =>
      line.includes(
        'loon.after (Layout), placement after "loon.anchor" → after "loon.anchor"',
      ),
    ),
    "the report agrees with the rendered tail order",
  );
});

test("a throwing rollback removes only its tail append and never writes a retained read-only index", () => {
  const rows = hostRows();
  Object.defineProperty(rows, "1", {
    value: rows[1],
    writable: false,
    enumerable: true,
    configurable: true,
  });
  const before = [...rows];
  const host = createFakeHost({ rows, throwInsideFactory: true });
  registerRows({
    id: "loon.injected",
    category: "Layout",
    rows: () => [{ label: "Injected row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  assert.throws(() => host.buildMenu(), /factory exploded/u);

  assert.equal(rows.length, before.length, "the baseline length comes back exactly");
  assert.ok(
    rows.every((row, index) => row === before[index]),
    "every retained host row keeps its exact element and index",
  );
  assert.equal(Object.hasOwn(rows, String(before.length)), false, "no phantom tail index");
  for (let index = 0; index < before.length; index += 1) {
    assert.equal(Object.hasOwn(rows, String(index)), true, `index ${index} is not a hole`);
  }
});


test("a pop'd appended row makes the rollback report what it found and could not remove", () => {
  const rows = hostRows();
  const originalError = new Error("factory exploded");
  const ui = {
    custom: (factory: (ui: unknown, theme: unknown, ...rest: unknown[]) => unknown): unknown =>
      factory(ui, undefined),
  };
  const host = {
    ui,
    build: (): unknown =>
      ui.custom(() => {
        rows.map((row) => row.category ?? "Settings");
        rows.pop(); // the host removes one row this build appended, before it throws
        throw originalError;
      }),
  };
  registerRows({
    id: "loon.injected",
    category: "Layout",
    rows: () => [{ label: "Injected row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  assert.throws(() => host.build(), (error) => error === originalError);

  assert.deepEqual(
    snapshotNotices().entries.map((entry) => entry.message),
    [
      "gentle-shell-bridge: could not fully roll back the provisional rows: appended 1 row; " +
        "1 already removed by the host; 0 removed by the bridge; 0 could not be removed. " +
        "The host menu was left as consistent as the array allowed.",
    ],
  );
});

test("a throwing length descriptor trap never replaces the factory's own error", () => {
  const rows = hostRows();
  const initialLength = rows.length;
  let lengthDescriptorReads = 0;
  const proxyRows = new Proxy(rows, {
    getOwnPropertyDescriptor(target, property) {
      if (property === "length" && target.length > initialLength) {
        // `push` consults the descriptor once while it grows the array; the rollback's next read
        // is the one that traps, exactly the "after the provisional append" shape.
        lengthDescriptorReads += 1;
        if (lengthDescriptorReads > 1) throw new Error("length descriptor exploded");
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  const originalError = new Error("factory exploded");
  const ui = {
    custom: (factory: (ui: unknown, theme: unknown, ...rest: unknown[]) => unknown): unknown =>
      factory(ui, undefined),
  };
  const host = {
    ui,
    build: (): unknown =>
      ui.custom(() => {
        proxyRows.map((row) => row.category ?? "Settings");
        throw originalError;
      }),
  };
  registerRows({
    id: "loon.injected",
    category: "Layout",
    rows: () => [{ label: "Injected row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  assert.throws(() => host.build(), (error) => error === originalError);
  assert.ok(
    snapshotNotices().entries.some(
      (entry) =>
        entry.message.includes("could not be inspected or changed (an object)") &&
        !entry.message.includes("length descriptor exploded"),
    ),
    "the guarded rollback describes the refusing value without reading it",
  );
});


test("a clean rollback of every appended row emits no notice", () => {
  const scenario = throwingHostAfter([
    { label: "Injected one", action: () => {} },
    { label: "Injected two", action: () => {} },
    { label: "Injected three", action: () => {} },
  ]);

  assert.throws(() => scenario.host.build(), (error) => error === scenario.originalError);
  assert.deepEqual(snapshotNotices().entries, []);
  assert.deepEqual(labels(scenario.rows), labels(hostRows()));
});

test("a host pop of one of three appended rows reports host and bridge removals truthfully", () => {
  const scenario = throwingHostAfter(
    [
      { label: "Injected one", action: () => {} },
      { label: "Injected two", action: () => {} },
      { label: "Injected three", action: () => {} },
    ],
    (rows) => rows.pop(),
  );

  assert.throws(() => scenario.host.build(), (error) => error === scenario.originalError);
  assert.deepEqual(labels(scenario.rows), labels(hostRows()));
  assert.deepEqual(snapshotNotices().entries.map((entry) => entry.message), [
    "gentle-shell-bridge: could not fully roll back the provisional rows: appended 3 rows; " +
      "1 already removed by the host; 2 removed by the bridge; 0 could not be removed. " +
      "The host menu was left as consistent as the array allowed.",
  ]);
});

test("a non-configurable appended index makes the rollback remove nothing", () => {
  let injected: CustomizeRow[] = [];
  const scenario = throwingHostAfter(
    [
      { label: "Injected one", action: () => {} },
      { label: "Injected two", action: () => {} },
      { label: "Injected three", action: () => {} },
    ],
    (rows) => {
      injected = rows.slice(rows.length - 3);
      Object.defineProperty(rows, String(rows.length - 3), { configurable: false });
    },
  );

  assert.throws(() => scenario.host.build(), (error) => error === scenario.originalError);
  assert.equal(scenario.rows.length, 7);
  assert.deepEqual(labels(scenario.rows), [
    ...labels(hostRows()),
    "Injected one",
    "Injected two",
    "Injected three",
  ]);
  injected.forEach((row, index) => {
    assert.equal(scenario.rows[4 + index], row, `appended row ${index} keeps its identity`);
  });
  for (let index = 0; index < 7; index += 1) {
    assert.equal(Object.hasOwn(scenario.rows, String(index)), true, `index ${index} is not a hole`);
  }
  assert.deepEqual(snapshotNotices().entries.map((entry) => entry.message), [
    "gentle-shell-bridge: could not fully roll back the provisional rows: index 4 is " +
      "non-configurable; appended 3 rows; 0 already removed by the host; 0 removed by the " +
      "bridge; 3 could not be removed. The host menu was left as consistent as the array allowed.",
  ]);
});

test("a throwing message getter on the rollback error is never inspected", () => {
  const rows = hostRows();
  const initialLength = rows.length;
  const hostile = new Error("descriptor exploded");
  Object.defineProperty(hostile, "message", {
    get() {
      throw new Error("message getter exploded");
    },
  });
  let lengthDescriptorReads = 0;
  const proxyRows = new Proxy(rows, {
    getOwnPropertyDescriptor(target, property) {
      if (property === "length" && target.length > initialLength) {
        lengthDescriptorReads += 1;
        if (lengthDescriptorReads > 1) throw hostile;
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  const originalError = new Error("factory exploded");
  const ui = {
    custom: (factory: (ui: unknown, theme: unknown, ...rest: unknown[]) => unknown): unknown =>
      factory(ui, undefined),
  };
  const host = {
    ui,
    build: (): unknown =>
      ui.custom(() => {
        proxyRows.map((row) => row.category ?? "Settings");
        throw originalError;
      }),
  };
  registerRows({
    id: "loon.injected",
    category: "Layout",
    rows: () => [{ label: "Injected row", action: () => {} }],
  });
  installCaptureBackend(host.ui);

  assert.throws(() => host.build(), (error) => error === originalError);
  assert.ok(
    snapshotNotices().entries.some(
      (entry) =>
        entry.message.includes("could not be inspected or changed (an object)") &&
        !entry.message.includes("message getter exploded"),
    ),
    "the rollback describes the hostile error without reading its message",
  );
});

test("swapping the last two appended rows removes all three and accounts for them", () => {
  const scenario = throwingHostAfter(
    [
      { label: "Injected one", action: () => {} },
      { label: "Injected two", action: () => {} },
      { label: "Injected three", action: () => {} },
    ],
    (rows) => {
      const first = rows.length - 3;
      const last = rows[first + 2] as CustomizeRow;
      rows[first + 2] = rows[first + 1] as CustomizeRow;
      rows[first + 1] = last;
    },
  );
  const hostBefore = [...scenario.rows];

  assert.throws(() => scenario.host.build(), (error) => error === scenario.originalError);
  assert.equal(scenario.rows.length, 4);
  assert.deepEqual(labels(scenario.rows), labels(hostRows()));
  scenario.rows.forEach((row, index) => {
    assert.equal(row, hostBefore[index], `host row ${index} keeps its identity`);
  });
  for (let index = 0; index < 4; index += 1) {
    assert.equal(Object.hasOwn(scenario.rows, String(index)), true, `index ${index} is not a hole`);
  }
  assert.deepEqual(snapshotNotices().entries.map((entry) => entry.message), [
    "gentle-shell-bridge: could not fully roll back the provisional rows: the host changed the " +
      "appended rows before the rollback; appended 3 rows; 0 already removed by the host; " +
      "3 removed by the bridge; 0 could not be removed. The host menu was left as consistent as " +
      "the array allowed.",
  ]);
});

test("a locked host row after the append leaves the build array byte-for-byte intact", () => {
  let buildLeft: CustomizeRow[] = [];
  const scenario = throwingHostAfter(
    [
      { label: "Injected one", action: () => {} },
      { label: "Injected two", action: () => {} },
      { label: "Injected three", action: () => {} },
    ],
    (rows) => {
      rows.push(
        { label: "Host extra one", action: () => {} },
        { label: "Host extra two", action: () => {} },
      );
      Object.defineProperty(rows, String(rows.length - 2), {
        configurable: false,
        writable: false,
      });
      buildLeft = [...rows];
    },
  );

  assert.throws(() => scenario.host.build(), (error) => error === scenario.originalError);
  assert.equal(scenario.rows.length, 9);
  assert.equal(scenario.rows.length, buildLeft.length);
  scenario.rows.forEach((row, index) => {
    assert.equal(row, buildLeft[index], `index ${index} keeps its build-left identity`);
  });
  for (let index = 0; index < 9; index += 1) {
    assert.equal(Object.hasOwn(scenario.rows, String(index)), true, `index ${index} is not a hole`);
  }
  assert.deepEqual(snapshotNotices().entries.map((entry) => entry.message), [
    "gentle-shell-bridge: could not fully roll back the provisional rows: index 7 is " +
      "non-configurable; appended 3 rows; 0 already removed by the host; 0 removed by the " +
      "bridge; 3 could not be removed. The host menu was left as consistent as the array allowed.",
  ]);
});

test("a getter-only earlier splice target makes the rollback write nothing", () => {
  let buildLeft: CustomizeRow[] = [];
  let getterIndex = -1;
  const scenario = throwingHostAfter(
    [
      { label: "Injected one", action: () => {} },
      { label: "Injected two", action: () => {} },
      { label: "Injected three", action: () => {} },
    ],
    (rows) => {
      rows.push(
        { label: "Host extra one", action: () => {} },
        { label: "Host extra two", action: () => {} },
      );
      // The splice writes the host's two later rows into the first two positions it removes.
      // A configurable getter-only accessor at the second target has no `writable` field, so it must
      // be rejected before the first target is written.
      getterIndex = rows.length - 4;
      const value = rows[getterIndex] as CustomizeRow;
      Object.defineProperty(rows, String(getterIndex), {
        configurable: true,
        enumerable: true,
        get() {
          return value;
        },
      });
      buildLeft = [...rows];
    },
  );

  assert.throws(() => scenario.host.build(), (error) => error === scenario.originalError);
  assert.equal(getterIndex, 5);
  assert.equal(scenario.rows.length, 9);
  scenario.rows.forEach((row, index) => {
    assert.equal(row, buildLeft[index], `index ${index} keeps its build-left identity and value`);
  });
  assert.equal(scenario.rows[4], buildLeft[4], "the earlier splice target was not written");
  assert.notEqual(scenario.rows[4], buildLeft[7], "the first host-added row was not duplicated");
  assert.equal(new Set(scenario.rows).size, scenario.rows.length, "no row identity is duplicated");
  for (let index = 0; index < 9; index += 1) {
    assert.equal(Object.hasOwn(scenario.rows, String(index)), true, `index ${index} is not a hole`);
  }
  assert.deepEqual(snapshotNotices().entries.map((entry) => entry.message), [
    "gentle-shell-bridge: could not fully roll back the provisional rows: index 5 is " +
      "read-only; appended 3 rows; 0 already removed by the host; 0 removed by the bridge; " +
      "3 could not be removed. The host menu was left as consistent as the array allowed.",
  ]);
});

test("a setter-bearing accessor is refused before any write", () => {
  let buildLeft: CustomizeRow[] = [];
  let getterIndex = -1;
  let setterCalls = 0;
  const scenario = throwingHostAfter(
    [
      { label: "Injected one", action: () => {} },
      { label: "Injected two", action: () => {} },
      { label: "Injected three", action: () => {} },
    ],
    (rows) => {
      rows.push(
        { label: "Host extra one", action: () => {} },
        { label: "Host extra two", action: () => {} },
      );
      // A setter is code, not a verifiable write: this one accepts the assignment syntactically and
      // throws the value away. It must never be reached.
      getterIndex = rows.length - 4;
      const value = rows[getterIndex] as CustomizeRow;
      Object.defineProperty(rows, String(getterIndex), {
        configurable: true,
        enumerable: true,
        get() {
          return value;
        },
        set() {
          setterCalls += 1;
        },
      });
      buildLeft = [...rows];
    },
  );

  assert.throws(() => scenario.host.build(), (error) => error === scenario.originalError);
  assert.equal(getterIndex, 5);
  assert.equal(setterCalls, 0, "the rollback never invokes the host setter");
  assert.equal(scenario.rows.length, 9);
  scenario.rows.forEach((row, index) => {
    assert.equal(row, buildLeft[index], `index ${index} keeps its build-left identity and value`);
  });
  assert.equal(new Set(scenario.rows).size, scenario.rows.length, "no row identity is duplicated");
  for (let index = 0; index < 9; index += 1) {
    assert.equal(Object.hasOwn(scenario.rows, String(index)), true, `index ${index} is not a hole`);
  }
  assert.deepEqual(snapshotNotices().entries.map((entry) => entry.message), [
    "gentle-shell-bridge: could not fully roll back the provisional rows: index 5 is " +
      "read-only; appended 3 rows; 0 already removed by the host; 0 removed by the bridge; " +
      "3 could not be removed. The host menu was left as consistent as the array allowed.",
  ]);
});
