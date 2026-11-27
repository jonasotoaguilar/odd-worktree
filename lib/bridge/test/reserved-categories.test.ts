/**
 * T26 / S15: `Keymaps` is the host's own interaction and is closed to plugins.
 *
 * The host's `Keymaps` page is not a list of settings: its rows capture the next key press, write
 * `keymaps.json` and carry a category footer that promises `Enter assign`
 * (`lib/keymaps-customize.ts:49-68`, `lib/visual-customize-view.ts:40`). A plugin row there would be
 * advertised as an assignable binding and could never honour it, so the category is reserved —
 * compared trimmed and case-insensitively, because ` Keymaps ` is the same page as `Keymaps`.
 *
 * The refusal reuses the bridge's ONE rejection channel, at the two boundaries that can see a
 * category:
 *
 * - registration (`./bus.ts`): the provider is refused BEFORE anything is stored, so the throw lands
 *   in `attributeRegistration` and the plugin's INTEGRATIONS line counts it and reads `degraded`
 *   (proved here with a real plugin module in its own temporary package, like every attribution
 *   test);
 * - menu build (`./rows.ts`): a single row whose OWN category is reserved is dropped as it is
 *   staged and recorded for `/bridge-status`, exactly like a row-name rejection. Its siblings still
 *   reach the menu — one bad row never costs the provider the rest.
 *
 * Nothing else changes: `Keymap`, `Key maps` and `Cards` are ordinary categories.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { publishBridgeApi, resetBridgeApiForTests } from "../src/api.ts";
import { armBridge } from "../src/arm.ts";
import {
  registerRows,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  resetTransformsForTests,
  snapshotProviders,
} from "../src/bus.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../src/capture.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import {
  getPluginLineReport,
  installPluginStatus,
  resetPluginLinesForTests,
} from "../src/plugin-lines.ts";
import { getRowNameRejections, resetRowNameRejectionsForTests } from "../src/row-names.ts";
import { getLastRowBuild, resetRowBuildStateForTests } from "../src/rows.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CustomizeRow, RowLabel } from "../src/types.ts";
import { createFakeHost, type FakeHost } from "./fake-host.ts";

/** The one sentence the refusal quotes, so the reason stands on its own in both places. */
const RULE =
  "works differently in the host (its own key capture and footer); not open to plugins yet";

const labelText = (label: RowLabel | undefined): string => {
  if (typeof label === "function") return label();
  return label ?? "";
};

const rowsOfLastBuild = (providerId: string): CustomizeRow[] =>
  getLastRowBuild()?.find((record) => record.providerId === providerId)?.rows ?? [];

const loonLabels = (host: FakeHost): string[] =>
  host
    .liveRows()
    .map((row) => labelText(row.label))
    .filter((label) => label.startsWith("Loon"));

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-reserved-categories-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

test.beforeEach(() => {
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetBridgeApiForTests();
  resetBusForTests();
  resetSectionsForTests();
  resetCardStylesForTests();
  resetTransformsForTests();
  resetRowNameRejectionsForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
  resetNoticesForTests();
  resetStoreStateForTests();
  resetPluginLinesForTests();
  disableCaptureBackend();
});

const menuHost = (): FakeHost => {
  const host = createFakeHost();
  armBridge(host.ui);
  return host;
};

const button = (category: string, label: string): CustomizeRow => ({
  category,
  label,
  action: () => {},
});

// ---------------------------------------------------------------------------------------------
// Registration (the throw the plugin's own call sees, and how it is reported)
// ---------------------------------------------------------------------------------------------

const registrationError = (category: string, id = "loon.keymaps"): string =>
  `gentle-shell-bridge: cannot register row provider ${JSON.stringify(id)}: its category ` +
  `${JSON.stringify(category)} is the reserved category "Keymaps". Keymaps ${RULE}. ` +
  `Place the rows in one of the host's other categories, e.g. "Cards".`;

test("a provider registered in Keymaps is refused, and nothing is stored", () => {
  const api = publishBridgeApi();

  assert.throws(
    () => api.registerRows({ id: "loon.keymaps", category: "Keymaps", rows: () => [] }),
    { message: registrationError("Keymaps") },
    "the error names the category and says why it is closed",
  );

  assert.deepEqual(snapshotProviders(), [], "a refused provider never reaches the bus");
  const host = menuHost();
  host.buildMenu();
  assert.deepEqual(loonLabels(host), [], "and therefore never reaches the menu");
  assert.deepEqual(getLastRowBuild(), [], "no build record exists for it");
});

test("every spelling of the same category is refused: trimmed and case-insensitive", () => {
  const api = publishBridgeApi();
  const spellings = ["keymaps", " Keymaps ", "KEYMAPS", "\tKeyMaps\n"];

  for (const [index, category] of spellings.entries()) {
    const id = `loon.keymaps-${String(index)}`;
    assert.throws(
      () => api.registerRows({ id, category, rows: () => [] }),
      { message: registrationError(category, id) },
      `${JSON.stringify(category)} is the same page as Keymaps`,
    );
  }
  assert.deepEqual(snapshotProviders(), []);
});

test("lookalikes are ordinary categories: Keymap, Key maps and Cards are still allowed", () => {
  const api = publishBridgeApi();
  const categories = ["Keymap", "Key maps", "Cards"];

  for (const [index, category] of categories.entries()) {
    api.registerRows({
      id: `loon.lookalike-${String(index)}`,
      category,
      rows: () => [button(category, `Loon choice ${String(index)}`)],
    });
  }

  assert.deepEqual(
    snapshotProviders().map((provider) => provider.category),
    categories,
    "the comparison is exact after trimming: a near-miss is a different category",
  );

  const host = menuHost();
  host.buildMenu();
  assert.deepEqual(loonLabels(host), [
    "Loon choice 0",
    "Loon choice 1",
    "Loon choice 2",
  ]);
});

// ---------------------------------------------------------------------------------------------
// The reported rejection: the plugin's INTEGRATIONS line and /bridge-status
// ---------------------------------------------------------------------------------------------

const scratchDirs: string[] = [];
let fixtureCount = 0;

/** A real plugin module in its own temporary package, so attribution runs as it does in Pi. */
const writePlugin = (packageName: string, body: string): string => {
  fixtureCount += 1;
  const root = mkdtempSync(join(tmpdir(), "gsb-reserved-plugin-"));
  scratchDirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: packageName, type: "module" }));
  const dir = join(root, `plugin-${String(fixtureCount)}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `plugin-${String(fixtureCount)}.mjs`);
  writeFileSync(
    file,
    `const api = globalThis[Symbol.for("gentle-shell-bridge/api/v1")];\n${body}\n`,
  );
  return file;
};

const loadPlugin = async (file: string): Promise<void> => {
  await import(`${pathToFileURL(file).href}?load=${String(Date.now())}-${String(fixtureCount)}`);
};

test("the refused registration is counted in the plugin's INTEGRATIONS line", async () => {
  const statuses = new Map<string, string>();
  installPluginStatus({
    setStatus(key: string, text?: string) {
      if (text === undefined) statuses.delete(key);
      else statuses.set(key, text);
    },
    notify() {},
  });
  publishBridgeApi();

  const file = writePlugin(
    "@acme/loon-kit",
    `api.registerRows({ id: "loon.keymaps", category: "Keymaps", rows: () => [] });`,
  );
  await assert.rejects(loadPlugin(file), {
    message: registrationError("Keymaps"),
  });

  assert.deepEqual([...statuses.values()], ["Loon kit · degraded"], "one line, and it says so");
  const [plugin] = getPluginLineReport().plugins;
  assert.equal(plugin?.accepted, 0, "the registration was not accepted");
  assert.equal(plugin?.rejected.length, 1, "it is the plugin's one reported rejection");
  assert.equal(plugin?.rejected[0]?.surface, "rows");
  assert.equal(plugin?.rejected[0]?.id, "loon.keymaps");
  assert.equal(plugin?.rejected[0]?.reason, registrationError("Keymaps"));

  const report = formatStatus(collectStatus());
  const text = report.join("\n");
  assert.ok(
    report.includes(`    - rows "loon.keymaps": ${registrationError("Keymaps")}`),
    text,
  );
  assert.ok(text.includes("0 accepted, 1 rejected"), text);
  assert.deepEqual(snapshotProviders(), [], "and nothing is registered");
});

// ---------------------------------------------------------------------------------------------
// A single row whose own category is reserved (the build boundary)
// ---------------------------------------------------------------------------------------------

const rowRejection = (value: string, id = "loon.mixed"): unknown => ({
  surface: "rows",
  id,
  field: "category",
  value,
  rule: "reserved category",
  reason: `it is the reserved category "Keymaps", which ${RULE}`,
});

test("a row in Keymaps is dropped, its siblings still render, and /bridge-status lists it", () => {
  registerRows({
    id: "loon.mixed",
    category: "Cards",
    rows: () => [
      button("Cards", "Loon first"),
      { category: "Keymaps", label: "Loon keymap", action: () => {} },
      { category: "  keymaps ", label: "Loon other keymap", action: () => {} },
      button("Cards", "Loon third"),
    ],
  });

  const host = menuHost();
  host.buildMenu();

  assert.deepEqual(
    loonLabels(host),
    ["Loon first", "Loon third"],
    "the refused rows are absent; every sibling is injected",
  );
  assert.equal(
    host.liveRows().some((row) => row.category === "Keymaps"),
    false,
    "nothing reached the host's array under the reserved category",
  );
  assert.deepEqual(
    rowsOfLastBuild("loon.mixed").map((row) => labelText(row.label)),
    ["Loon first", "Loon third"],
    "and the effective set /bridge-status reads holds the siblings only",
  );
  assert.deepEqual(
    getRowNameRejections(),
    [rowRejection("Keymaps"), rowRejection("  keymaps ")],
    "one record per offending string, recorded verbatim",
  );
  assert.deepEqual(
    collectStatus().failures,
    [],
    "a refused row is a rejection, never a build failure: the provider keeps its rows",
  );

  const report = formatStatus(collectStatus());
  assert.ok(
    report.includes(
      '  - rows "loon.mixed" category "Keymaps": it is the reserved category "Keymaps", ' +
        `which ${RULE} (rejected, never rewritten)`,
    ),
    report.join("\n"),
  );
});

test("a rebuild keeps one record, and a corrected provider clears it", () => {
  const dispose = registerRows({
    id: "loon.mixed",
    category: "Cards",
    rows: () => [button("Cards", "Loon first"), { category: "Keymaps", label: "Loon keymap", action: () => {} }],
  });

  menuHost().buildMenu();
  menuHost().buildMenu();
  assert.equal(getRowNameRejections().length, 1, "a repeated build cannot grow the report");

  dispose();
  registerRows({
    id: "loon.mixed",
    category: "Cards",
    rows: () => [button("Cards", "Loon first"), button("Cards", "Loon second")],
  });
  const host = menuHost();
  host.buildMenu();

  assert.deepEqual(
    getRowNameRejections(),
    [],
    "the build that no longer contains the refused row clears the stale record",
  );
  assert.deepEqual(loonLabels(host), ["Loon first", "Loon second"]);
});

test("a provider the bus already holds in Keymaps still cannot inject rows", () => {
  // A copy of this package that predates the registration check can leave such a provider in the
  // process-global bus; the build boundary is the second, independent check. The bus holds the
  // provider object itself, so re-pointing its category is exactly the state an older copy writes.
  const provider = {
    id: "loon.legacy",
    category: "Cards",
    rows: () => [button("Cards", "Loon legacy")],
  };
  registerRows(provider);
  provider.category = "Keymaps";

  const host = menuHost();
  host.buildMenu();

  assert.deepEqual(loonLabels(host), [], "not one row of it reaches the menu");
  assert.deepEqual(getRowNameRejections(), [rowRejection("Keymaps", "loon.legacy")]);
  assert.equal(getRowNameRejections()[0]?.id, "loon.legacy");
  assert.deepEqual(collectStatus().failures, [], "and it is a rejection, not a build failure");
});
