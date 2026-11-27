import assert from "node:assert/strict";
import test from "node:test";

import { recordObservedHostCategories, resetBusForTests, registerRows } from "../src/bus.ts";
import {
  getCaptureDiagnostics,
  installCaptureBackend,
  resetCaptureStateForTests,
} from "../src/capture.ts";
import { resetHookStateForTests, installHookBackend } from "../src/hook.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { createRowContext } from "../src/rows.ts";
import {
  collectStatus,
  findDuplicateSettings,
  formatStatus,
  type StatusSnapshot,
} from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CustomizeRow, RowProvider } from "../src/types.ts";

const HOOK_KEY = Symbol.for("gentle-pi.customize-row-providers");
const hookSlot = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>;

test.beforeEach(() => {
  resetBusForTests();
  resetCaptureStateForTests();
  resetRowBuildStateForTests();
  resetHookStateForTests();
  resetStoreStateForTests();
});

test.afterEach(() => {
  delete hookSlot()[HOOK_KEY];
  resetHookStateForTests();
});

// No row-level category: `findDuplicateSettings` must fall back to the provider's category, which
// is what distinguishes the two providers in the cross-category case below.
const choiceRow = (setting: string, value: string): CustomizeRow => ({
  label: setting,
  choice: { setting, value, current: () => false },
  action: () => {},
});

const settingProvider = (id: string, category: string, setting: string): RowProvider => ({
  id,
  category,
  rows: () => [choiceRow(setting, "a"), choiceRow(setting, "b")],
});

test("an empty state formats every field as none", () => {
  const snapshot = collectStatus();

  assert.deepEqual(snapshot, {
    providers: [],
    backend: "none",
    failures: [],
    storeProblems: [],
  });
  assert.equal(snapshot.duplicates, undefined, "no build has happened, so duplicates are unknown");
  assert.deepEqual(formatStatus(snapshot), [
    "gentle-shell-bridge status",
    "providers: none",
    "backend: none",
    "last capture: none",
    "last failures: none",
    "store problems: none",
    "duplicate settings: no build yet",
  ]);
});

test("a populated state formats providers, backend, capture, failures, store and duplicates", () => {
  const snapshot: StatusSnapshot = {
    providers: [
      { id: "loon.banner-source", category: "Banner" },
      { id: "other.card", category: "Cards" },
    ],
    backend: "capture",
    lastCapture: { kind: "injected", injectedRows: 2 },
    failures: [{ providerId: "boom", message: "provider exploded", rowsDropped: true }],
    storeProblems: [
      {
        pluginId: "loon",
        path: "/tmp/x/gentle-shell-bridge/loon.json",
        kind: "invalid-json",
        message: "Unexpected token",
      },
    ],
    duplicates: [
      { category: "Banner", setting: "Loon → Banner source", providerIds: ["loon.banner-source", "other.card"] },
    ],
  };

  assert.deepEqual(formatStatus(snapshot), [
    "gentle-shell-bridge status",
    "providers: 2",
    "  - loon.banner-source (Banner)",
    "  - other.card (Cards)",
    "backend: capture",
    "last capture: injected 2 rows",
    "last failures: 1",
    "  - boom: provider exploded (rows dropped)",
    "store problems: 1",
    "  - loon (/tmp/x/gentle-shell-bridge/loon.json): invalid-json: Unexpected token (reads fall back to defaults; the file is left as is)",
    "duplicate settings: 1",
    '  - Banner / "Loon → Banner source": loon.banner-source, other.card',
  ]);
});

test("an uncaptured outcome with a reason is reported, not hidden", () => {
  const snapshot: StatusSnapshot = {
    providers: [],
    backend: "capture",
    lastCapture: { kind: "uncaptured", injectedRows: 0, reason: "no-capture" },
    failures: [],
    storeProblems: [],
    duplicates: [],
  };

  assert.ok(formatStatus(snapshot).includes("last capture: uncaptured (no-capture)"));
});

test("collectStatus reports the capture backend and its last outcome and failures", () => {
  const providers: RowProvider[] = [
    { id: "ok", category: "Cards", rows: () => [{ label: "fine", action: () => {} }] },
    {
      id: "boom",
      category: "Banner",
      rows: () => {
        throw new Error("provider exploded");
      },
    },
  ];
  for (const provider of providers) registerRows(provider);

  const host = {
    custom(factory: (ui: unknown, theme: unknown) => unknown) {
      return factory(undefined, undefined);
    },
  };
  installCaptureBackend(host);
  const rows: CustomizeRow[] = [
    { category: "Cards", label: "one", action: () => {} },
    { category: "Cards", label: "two", action: () => {} },
    { category: "Cards", label: "three", action: () => {} },
  ];
  host.custom(() => {
    rows.map((row) => row.category);
    return { invalidate: () => {}, render: () => [], handleInput: () => {}, dispose: () => {} };
  });

  const snapshot = collectStatus();

  assert.equal(snapshot.backend, "capture");
  assert.deepEqual(snapshot.lastCapture, { kind: "injected", injectedRows: 1 });
  assert.deepEqual(snapshot.failures, [
    { providerId: "boom", message: "provider exploded", rowsDropped: true },
  ]);
  assert.equal(getCaptureDiagnostics().armedTargets, 1);
});

test("collectStatus reports the hook backend when the registry is in use", () => {
  hookSlot()[HOOK_KEY] = [];
  installHookBackend();

  assert.equal(collectStatus().backend, "hook");
});

test("duplicate category + setting across two providers is detected", () => {
  const providers = [
    settingProvider("loon.banner-source", "Banner", "Loon → Banner source"),
    settingProvider("other.banner", "Banner", "Loon → Banner source"),
  ];

  assert.deepEqual(findDuplicateSettings(providers, createRowContext(undefined)), [
    { category: "Banner", setting: "Loon → Banner source", providerIds: ["loon.banner-source", "other.banner"] },
  ]);
});

test("one provider's own toggle rows are not a duplicate", () => {
  const providers = [settingProvider("loon.banner-source", "Banner", "Loon → Banner source")];

  assert.deepEqual(findDuplicateSettings(providers, createRowContext(undefined)), []);
});

test("the same setting in different categories is not a duplicate", () => {
  const providers = [
    settingProvider("a", "Banner", "Loon → Banner source"),
    settingProvider("b", "Cards", "Loon → Banner source"),
  ];

  assert.deepEqual(findDuplicateSettings(providers, createRowContext(undefined)), []);
});

test("a throwing provider is skipped by the duplicate scan instead of breaking it", () => {
  const providers: RowProvider[] = [
    {
      id: "boom",
      category: "Banner",
      rows: () => {
        throw new Error("duplicate scan exploded");
      },
    },
    settingProvider("a", "Banner", "Shared setting"),
  ];

  assert.deepEqual(findDuplicateSettings(providers, createRowContext(undefined)), []);
});

// ---------------------------------------------------------------------------------------------
// Row placement (S1, S2, S3, S5): requested vs landed, on the provider's own line
// ---------------------------------------------------------------------------------------------

test("collectStatus reports each explicit row placement and the fallback that explains it", () => {
  recordObservedHostCategories(["Layout", "Banner"]);
  registerRows({ id: "loon.top", category: "Layout", placement: "start", rows: () => [] });
  registerRows({
    id: "loon.after",
    category: "Layout",
    placement: { after: "missing" },
    rows: () => [],
  });
  registerRows({ id: "plain", category: "Layout", rows: () => [] });

  const snapshot = collectStatus();

  assert.deepEqual(snapshot.providers, [
    {
      id: "loon.top",
      category: "Layout",
      placement: { requested: "start", landed: "start" },
    },
    {
      id: "loon.after",
      category: "Layout",
      placement: {
        requested: 'after "missing"',
        landed: "end",
        reason: 'after "missing" is not a registered row provider id',
      },
    },
    { id: "plain", category: "Layout" },
  ]);

  const lines = formatStatus(snapshot);
  assert.ok(lines.includes("  - loon.top (Layout), placement start → start"), lines.join("\n"));
  assert.ok(
    lines.includes(
      '  - loon.after (Layout), placement after "missing" → end ' +
        '(after "missing" is not a registered row provider id)',
    ),
    lines.join("\n"),
  );
  assert.ok(
    lines.includes("  - plain (Layout)"),
    "a provider with no placement keeps the entry and line it had before this field existed",
  );
});

test("collectStatus reports a malformed row placement as a rejection, and the provider still lands at the end", () => {
  const malformed = { after: "" } as unknown as RowProvider["placement"];
  registerRows({ id: "loon.broken", category: "Layout", placement: malformed, rows: () => [] });

  const snapshot = collectStatus();

  assert.deepEqual(snapshot.rowPlacementRejections, [
    {
      providerId: "loon.broken",
      value: '{"after":""}',
      reason: snapshot.rowPlacementRejections?.[0].reason,
    },
  ]);
  assert.match(snapshot.rowPlacementRejections?.[0].reason ?? "", /non-empty string/);
  assert.deepEqual(snapshot.providers, [
    {
      id: "loon.broken",
      category: "Layout",
      placement: {
        requested: 'after ""',
        landed: "end",
        reason: snapshot.providers[0].placement?.reason,
      },
    },
  ]);

  const lines = formatStatus(snapshot);
  assert.ok(lines.includes("row placement rejections: 1"), lines.join("\n"));
  assert.ok(
    lines.some((line) =>
      /^  - provider "loon\.broken" placement \{"after":""\}: .* \(the rows were placed at the end\)$/u.test(
        line,
      ),
    ),
    lines.join("\n"),
  );
});
