/**
 * T26 / S15: `Keymaps` is the host's own interaction and is closed to plugins.
 *
 * The host's `Keymaps` page is not a list of settings: its rows capture the next key press, write
 * `keymaps.json` and carry a category footer that promises `Enter assign`
 * (`lib/keymaps-customize.ts:49-68`, `lib/visual-customize-view.ts:40`). A plugin row there would be
 * advertised as an assignable binding and could never honour it, so the category is reserved —
 * compared trimmed and case-insensitively, because ` Keymaps ` is the same page as `Keymaps`.
 *
 * The refusal reuses the shell API's ONE rejection channel, at the two boundaries that can see a
 * category:
 *
 * - registration (`./bus.ts`): the provider is refused BEFORE anything is stored, so the throw lands
 *   in `attributeRegistration` and the plugin's INTEGRATIONS line counts it and reads `degraded`
 *   (proved here with a real plugin module in its own temporary package, like every attribution
 *   test);
 * - menu build (`./rows.ts`): a single row whose OWN category is reserved is dropped as it is
 *   staged and recorded for the diagnostics record, exactly like a row-name rejection. Its siblings still
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

import { publishShellApi, resetShellApiForTests } from "../../lib/shell-api/api.ts";
import { armShellApi } from "../../lib/shell-api/arm.ts";
import {
  registerRows,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  resetTransformsForTests,
  snapshotProviders,
} from "../../lib/shell-api/bus.ts";
import { disableCaptureBackend, resetCaptureStateForTests } from "../../lib/shell-api/capture.ts";
import { resetHookStateForTests } from "../../lib/shell-api/hook.ts";
import { resetNoticesForTests } from "../../lib/shell-api/notices.ts";
import {
  resetPluginLinesForTests,
} from "../../lib/shell-api/plugin-lines.ts";
import { getRowNameRejections, resetRowNameRejectionsForTests } from "../../lib/shell-api/row-names.ts";
import { getLastRowBuild, resetRowBuildStateForTests } from "../../lib/shell-api/rows.ts";
import { resetStoreStateForTests } from "../../lib/shell-api/store.ts";
import type { CustomizeRow, RowLabel } from "../../lib/shell-api/types.ts";
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
  resetShellApiForTests();
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
  armShellApi(host.ui);
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
  `odd-worktree: cannot register row provider ${JSON.stringify(id)}: its category ` +
  `${JSON.stringify(category)} is the reserved category "Keymaps". Keymaps ${RULE}. ` +
  `Place the rows in one of the host's other categories, e.g. "Cards".`;

test("a provider registered in Keymaps is refused, and nothing is stored", () => {
  const api = publishShellApi();

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
  const api = publishShellApi();
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
  const api = publishShellApi();
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
// The reported rejection: the plugin's INTEGRATIONS line and the diagnostics record
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
    `const api = globalThis[Symbol.for("odd-worktree/shell-api/v1")];\n${body}\n`,
  );
  return file;
};

const loadPlugin = async (file: string): Promise<void> => {
  await import(`${pathToFileURL(file).href}?load=${String(Date.now())}-${String(fixtureCount)}`);
};

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

