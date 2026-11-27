import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { bridgeApi, publishBridgeApi } from "../src/api.ts";
import {
  registerRows,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  resetTransformsForTests,
  snapshotSections,
} from "../src/bus.ts";
import gentleShellBridge, {
  type BridgeCommandContext,
  type BridgeCommandHandler,
  type BridgeExtensionApi,
  type BridgeSessionHandler,
} from "../src/extension.ts";
import {
  HOST_OWN_STATUS_KEYS,
  PLUGIN_LINE_PREFIX,
  derivePluginName,
  getPluginLineReport,
  installPluginStatus,
  resetPluginLinesForTests,
} from "../src/plugin-lines.ts";
import { rowNameProblem } from "../src/row-names.ts";
import { setRepaintHost, resetRepaintForTests } from "../src/repaint.ts";
import { resetSectionPanelForTests, setSectionTheme } from "../src/section-panel.ts";
import { resetSectionPointerForTests } from "../src/section-pointer.ts";
import {
  SIDEBAR_RAIL_KEY,
  disableSidebarBackend,
  installSidebarBackend,
  resetSidebarStateForTests,
} from "../src/sidebar.ts";
import { installSectionRail, resetSectionFailuresForTests } from "../src/sidebar-render.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import {
  fakeState,
  fakeTerminal,
  fakeTui,
  registerNativeFooter,
  renderSidebar,
  resetSidebar,
} from "./fake-sidebar.ts";

/**
 * The integration line is proven against a FAKE footer: an object with `setStatus(key, text)` that
 * stores what it was handed, which is the whole of Pi's documented contract
 * (`docs/extensions.md:2895-2896`) and the whole of what the bridge can observe. The host's real
 * map, its sort order and the shared status role it paints with are read-only evidence from
 * gentle-shell (`extensions/gentle-shell.ts:357-385`, `lib/shell-bar.ts:289-298`), not something
 * these tests can execute.
 *
 * Attribution is NOT faked: every plugin below is a real module in its own temporary package, so
 * the caller frame, the `package.json` walk and the per-module cache run exactly as they do in Pi.
 */

interface FakeFooter {
  ui: { setStatus(key: string, text?: string): void; notify(): void };
  statuses: Map<string, string>;
  calls: Array<{ key: string; text?: string }>;
}

const createFakeFooter = (initial: Record<string, string> = {}): FakeFooter => {
  const statuses = new Map<string, string>(Object.entries(initial));
  const calls: Array<{ key: string; text?: string }> = [];
  return {
    statuses,
    calls,
    ui: {
      setStatus(key, text) {
        calls.push({ key, text });
        if (text === undefined) statuses.delete(key);
        else statuses.set(key, text);
      },
      notify() {
        // A plugin may deliver notices through the same ui; this footer only records rows.
      },
    },
  };
};

interface FakePi {
  api: BridgeExtensionApi;
  sessions: BridgeSessionHandler[];
  shutdowns: BridgeSessionHandler[];
  commands: Array<{ name: string; handler: BridgeCommandHandler }>;
}

const createFakePi = (): FakePi => {
  const sessions: BridgeSessionHandler[] = [];
  const shutdowns: BridgeSessionHandler[] = [];
  const commands: Array<{ name: string; handler: BridgeCommandHandler }> = [];
  const api: BridgeExtensionApi = {
    // `gentle-pi` is present, so `session_start` installs the INTEGRATIONS surface (S9/T12).
    getCommands: () => [{ name: "gentle:customize" }],
    on(event, handler) {
      if (event === "session_start") sessions.push(handler);
      else if (event === "session_shutdown") shutdowns.push(handler);
      else assert.fail(`the extension must not listen to ${String(event)}`);
    },
    registerCommand(name, command) {
      commands.push({ name, handler: command.handler });
    },
  };
  return { api, sessions, shutdowns, commands };
};

// ---------------------------------------------------------------------------------------------
// Real plugin modules in their own packages, outside the worktree
// ---------------------------------------------------------------------------------------------

const scratchDirs: string[] = [];
let fixtureCount = 0;

const PLUGIN_SOURCE_HEAD = `const api = globalThis[Symbol.for("gentle-shell-bridge/api/v1")];\n`;

/**
 * Write one plugin module into a fresh temporary package. `packageName: null` writes no manifest, so
 * the module has no owning package at all — the fail-closed case I2 describes.
 */
const writePlugin = (packageName: string | null, body: string): string => {
  fixtureCount += 1;
  const root = mkdtempSync(join(tmpdir(), "gsb-plugin-lines-"));
  scratchDirs.push(root);
  const dir = join(root, `plugin-${String(fixtureCount)}`);
  mkdirSync(dir, { recursive: true });
  if (packageName !== null) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: packageName, type: "module" }));
  }
  const file = join(dir, `plugin-${String(fixtureCount)}.mjs`);
  writeFileSync(file, `${PLUGIN_SOURCE_HEAD}${body}\n`);
  return file;
};

const loadPlugin = async (file: string): Promise<void> => {
  await import(`${pathToFileURL(file).href}?load=${String(Date.now())}-${String(fixtureCount)}`);
};

/** One temporary package root, with the manifest (and any extra fields) a real one would have. */
const writePackageRoot = (
  packageName: string,
  manifestExtra: Record<string, unknown> = {},
): string => {
  const root = mkdtempSync(join(tmpdir(), "gsb-plugin-identity-"));
  scratchDirs.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: packageName, type: "module", ...manifestExtra }),
  );
  return root;
};

/** A plugin module at a relative path inside an existing package root (no new identity). */
const writeModuleAt = (root: string, relative: string, body: string): string => {
  fixtureCount += 1;
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${PLUGIN_SOURCE_HEAD}${body}\n`);
  return file;
};

/** Four registrations, four surfaces, one plugin: the I1 case in its strongest form. */
const FOUR_SURFACES = `
api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });
api.registerSection({ id: "loon.section", title: "Loon", lines: () => ["loon"] });
api.registerCardStyle({ id: "loon.plain", label: "plain", frame: { top: () => "", line: () => "", bottom: () => "" } });
api.registerTransform({ id: "loon.restyle", transform: (lines) => lines });
`;

test.beforeEach(() => {
  resetBusForTests();
  resetSectionsForTests();
  resetCardStylesForTests();
  resetTransformsForTests();
  resetPluginLinesForTests();
  resetStoreStateForTests();
});

test.after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

test("a plugin with four registrations gets exactly one line", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(writePlugin("@acme/loon-kit", FOUR_SURFACES));

  assert.equal(footer.statuses.size, 1, "four registrations, one footer entry");
  const [entry] = [...footer.statuses.entries()];
  assert.equal(entry[1], "Loon kit · ready", "the row is the plugin name plus its derived state");
  assert.equal(
    new Set(footer.calls.map((call) => call.key)).size,
    1,
    "every repaint uses the same key, so the host updates one row instead of adding four",
  );
  assert.equal(footer.calls.length, 1, "an unchanged status is not repainted: one host call");
  const report = getPluginLineReport();
  assert.equal(report.plugins.length, 1);
  assert.equal(report.plugins[0].accepted, 4);
  assert.equal(report.plugins[0].rejected.length, 0);
  assert.equal(report.plugins[0].nameSource, "derived");
  assert.equal(report.plugins[0].status, "ready");
});

test("two plugins get two lines with distinct keys", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(
    writePlugin(
      "@acme/loon-kit",
      `api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });`,
    ),
  );
  await loadPlugin(
    writePlugin(
      "other-tools",
      `api.registerSection({ id: "other.section", title: "Other", lines: () => [] });`,
    ),
  );

  assert.deepEqual([...footer.statuses.values()].sort(), [
    "Loon kit · ready",
    "Other tools · ready",
  ]);
  assert.equal(new Set(footer.statuses.keys()).size, 2);
});

test("an explicit name on the first registration wins over the package name", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(
    writePlugin(
      "acme-loon",
      `api.registerRows({ id: "loon.rows", category: "Banner", name: "Loon kit", rows: () => [] });`,
    ),
  );

  assert.deepEqual([...footer.statuses.values()], ["Loon kit · ready"]);
  const report = getPluginLineReport();
  assert.equal(report.plugins[0].nameSource, "explicit");
});

test("a derived name is cleaned of scope and marks", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(
    writePlugin(
      "@acme/loon-kit",
      `api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });`,
    ),
  );

  assert.deepEqual([...footer.statuses.values()], ["Loon kit · ready"]);
  assert.equal(getPluginLineReport().plugins[0].packageName, "@acme/loon-kit");
});

test("the derived name is clamped to three words, stripped of marks, and always conforms", () => {
  assert.equal(derivePluginName("@acme/loon-kit"), "Loon kit");
  assert.equal(derivePluginName("a-b-c-d-e"), "A b c");
  assert.equal(derivePluginName("!!!"), undefined);
  for (const packageName of ["@acme/loon-kit", "gentle.shell.bridge", "a-b-c-d-e"]) {
    const derived = derivePluginName(packageName);
    assert.ok(derived !== undefined);
    assert.equal(rowNameProblem(derived), undefined, `"${derived}" must satisfy the shape rule`);
  }
});

test("a package name with no usable words gets no line, and says why", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(
    writePlugin("!!!", `api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });`),
  );

  assert.equal(footer.statuses.size, 0, "fail closed: no invented name");
  const report = getPluginLineReport();
  assert.equal(report.plugins.length, 1, "the registration itself still happened");
  assert.equal(report.plugins[0].name, undefined);
  assert.equal(report.plugins[0].accepted, 1);
  assert.match(report.plugins[0].reason ?? "", /no usable words/u);
  const printed = formatStatus(collectStatus()).join("\n");
  assert.match(printed, /^plugin lines: 1$/m);
  assert.match(printed, /\(no line\)/u);
  assert.match(printed, /no usable words/u);
});

test("a module with no owning package gets no line, and says why", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);
  const file = writePlugin(
    null,
    `api.registerRows({ id: "loose.rows", category: "Banner", rows: () => [] });`,
  );

  await loadPlugin(file);

  assert.equal(footer.statuses.size, 0);
  const printed = formatStatus(collectStatus()).join("\n");
  assert.match(printed, /\(no line\)/u);
  assert.match(printed, /no package\.json/u);
  // The module path is a DIAGNOSTIC here, never a row name: the footer stayed empty.
  assert.ok(printed.includes(file), "the report names the module so the author can find it");
});

test("an unattributed module can still name itself explicitly", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(
    writePlugin(
      null,
      `api.registerRows({ id: "loose.rows", category: "Banner", name: "Bash card", rows: () => [] });`,
    ),
  );

  assert.deepEqual([...footer.statuses.values()], ["Bash card · ready"]);
});

test("a rejected registration degrades the line and names the reason in the report", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(
    writePlugin(
      "@acme/loon-kit",
      `
api.registerSection({ id: "loon.bad", title: "Bad", rowLabel: "Loon → kit", lines: () => [] });
try {
  api.registerSection({ id: "", title: "Bad id", lines: () => [] });
} catch {}
`,
    ),
  );

  const texts = [...footer.statuses.values()];
  assert.deepEqual(texts, ["Loon kit · degraded"], "one row, and it does not promise ready");
  const report = getPluginLineReport();
  assert.equal(report.plugins[0].accepted, 0);
  assert.equal(report.plugins[0].rejected.length, 2);
  const printed = formatStatus(collectStatus()).join("\n");
  assert.match(printed, /"Loon kit" \(derived from package "@acme\/loon-kit"\): degraded, 0 accepted, 2 rejected/u);
  assert.match(printed, /Loon → kit/u, "the rejected label is printed verbatim");
  assert.match(printed, /invalid section id/u, "the invalid id keeps the bus's own message");
});

test("the same key is updated in place when the derived status changes", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(
    writePlugin(
      "@acme/loon-kit",
      `
api.registerSection({ id: "loon.section", title: "Loon", lines: () => [] });
try {
  api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });
  api.registerSection({ id: "", title: "Bad id", lines: () => [] });
} catch {}
`,
    ),
  );

  assert.equal(footer.statuses.size, 1, "still one row");
  assert.deepEqual([...footer.statuses.values()], ["Loon kit · degraded"]);
  const keys = new Set(footer.calls.map((call) => call.key));
  assert.equal(keys.size, 1, "the same key was reused for the update");
  assert.deepEqual(
    footer.calls.map((call) => call.text),
    ["Loon kit · ready", "Loon kit · degraded"],
    "the unchanged registrations cost no repaint; the change repaints the same key",
  );
});

test("an explicit name that breaks the shape rule gets no line, never a rejected name", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(
    writePlugin(
      "@acme/loon-kit",
      `api.registerRows({ id: "loon.rows", category: "Banner", name: "Loon → kit", rows: () => [] });`,
    ),
  );

  assert.equal(footer.statuses.size, 0);
  const record = getPluginLineReport().plugins[0];
  assert.equal(record.name, undefined);
  assert.equal(record.rejected.length, 1);
  assert.match(record.reason ?? "", /breaks the row-name shape/u);
});

test("session_start paints the line and session_shutdown clears it with undefined", async () => {
  const footer = createFakeFooter();
  await loadPlugin(
    writePlugin("@acme/loon-kit", `api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });`),
  );
  assert.equal(footer.statuses.size, 0, "registered before any ui existed");

  const pi = createFakePi();
  gentleShellBridge(pi.api);
  pi.sessions[0]({}, { hasUI: true, ui: footer.ui });
  assert.deepEqual([...footer.statuses.values()], ["Loon kit · ready"]);

  pi.shutdowns[0]({}, { hasUI: true, ui: footer.ui });

  assert.equal(footer.statuses.size, 0, "the bridge's own row is gone");
  const last = footer.calls[footer.calls.length - 1];
  assert.deepEqual(last, { key: [...footer.calls][0].key, text: undefined });
});

test("a ui without setStatus never throws into registration, and the report says unavailable", async () => {
  assert.equal(installPluginStatus({}), false);

  await assert.doesNotReject(
    loadPlugin(
      writePlugin("@acme/loon-kit", `api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });`),
    ),
  );

  const report = getPluginLineReport();
  assert.equal(report.availability, "unavailable");
  assert.match(report.reason ?? "", /no setStatus/u);
  const printed = formatStatus(collectStatus()).join("\n");
  assert.match(printed, /^plugin lines: 1 \(status unavailable: ctx\.ui has no setStatus\)$/m);
  assert.match(printed, /no line set \(ctx\.ui has no setStatus\)/u);
});

test("a setStatus that throws is contained and reported, not thrown at the plugin", async () => {
  installPluginStatus({
    setStatus() {
      throw new Error("footer is gone");
    },
  });

  await assert.doesNotReject(
    loadPlugin(
      writePlugin("@acme/loon-kit", `api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });`),
    ),
  );

  const record = getPluginLineReport().plugins[0];
  assert.equal(record.line, "not-set");
  assert.match(record.reason ?? "", /footer is gone/u);
});

test("the host's own filters still exclude its reserved keys, and keep one plugin line", async () => {
  // The host's own statuses, including the four keys it never shows in INTEGRATIONS
  // (`extensions/gentle-shell.ts:357-385`).
  const footer = createFakeFooter({
    "gentle-pi": "🧠 gentle-pi · ready",
    "gentle:mode": "Permissions: edit",
    "gentle:yolo": "YOLO — edit",
    "gentle-jobs": "2 jobs",
    "gentle-fast": "fast",
  });
  installPluginStatus(footer.ui);

  await loadPlugin(
    writePlugin("@acme/loon-kit", `api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });`),
  );

  const own = getPluginLineReport().plugins[0].key;
  assert.ok(own.startsWith(PLUGIN_LINE_PREFIX));
  assert.equal(HOST_OWN_STATUS_KEYS.includes(own), false);

  // The host's own INTEGRATIONS filter, as it reads the map.
  const integrations = [...footer.statuses.entries()]
    .filter(([key]) => key !== "gentle-fast" && key !== "gentle-jobs")
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([key]) => key !== "gentle:mode" && key !== "gentle:yolo")
    .map(([, text]) => text);

  assert.equal(
    integrations.filter((text) => text === "🧠 gentle-pi · ready").length,
    1,
    "the host's own row is untouched",
  );
  assert.equal(
    integrations.filter((text) => text === "Loon kit · ready").length,
    1,
    "the plugin row survives the host's filter exactly once",
  );
});

test("registering from the bridge's own package claims no footer line", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  // This test module is inside the bridge's own package, so it is plumbing, not a plugin.
  registerRows({ id: "bridge.internal", category: "Banner", rows: () => [] });

  assert.equal(footer.statuses.size, 0);
  assert.equal(getPluginLineReport().plugins.length, 0);
  assert.equal(collectStatus().pluginLines, undefined, "the report keeps its historical shape");
});

test("the status command prints the per-plugin list and every existing block", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);
  await loadPlugin(
    writePlugin("@acme/loon-kit", `api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });`),
  );

  const pi = createFakePi();
  gentleShellBridge(pi.api);
  const printed: string[] = [];
  const context: BridgeCommandContext = {
    ui: { notify: (message: string) => printed.push(message) },
  };
  pi.commands[0].handler("", context);

  assert.equal(printed.length, 1);
  assert.match(printed[0], /^gentle-shell-bridge status$/m);
  assert.match(printed[0], /^providers: 1$/m);
  assert.match(printed[0], /^backend: none$/m);
  assert.match(printed[0], /^duplicate settings: no build yet$/m);
  assert.match(printed[0], /^plugin lines: 1$/m);
  assert.match(printed[0], /"Loon kit" \(derived from package "@acme\/loon-kit"\): ready, 1 accepted, 0 rejected/u);
});

test("bridgeApi() is what the fixture plugins read", () => {
  assert.ok(bridgeApi() !== undefined);
});

// ---------------------------------------------------------------------------------------------
// Plugin identity (I8–I11): one identity, one row, whatever names the registrations carry
// ---------------------------------------------------------------------------------------------

test("a later registration names an identity its first registration left unnamed", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(
    writePlugin(
      "@acme/loon-kit",
      `
api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });
api.registerSection({ id: "loon.section", title: "Loon", name: "Bash card", lines: () => [] });
`,
    ),
  );

  assert.deepEqual([...footer.statuses.values()], ["Bash card · ready"]);
  assert.equal(footer.statuses.size, 1, "one identity still means one row");
  const report = getPluginLineReport();
  assert.equal(report.plugins.length, 1);
  assert.equal(report.plugins[0].name, "Bash card");
  assert.equal(report.plugins[0].nameSource, "explicit");
  assert.equal(report.plugins[0].accepted, 2);
  assert.equal(report.plugins[0].nameConflicts.length, 0);
});

test("one named registration and one unnamed from the same module keep the explicit name", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(
    writePlugin(
      "@acme/loon-kit",
      `
api.registerRows({ id: "loon.rows", category: "Banner", name: "Bash card", rows: () => [] });
api.registerSection({ id: "loon.section", title: "Loon", lines: () => [] });
`,
    ),
  );

  assert.deepEqual([...footer.statuses.values()], ["Bash card · ready"]);
  assert.equal(new Set(footer.calls.map((entry) => entry.key)).size, 1);
  const report = getPluginLineReport();
  assert.equal(report.plugins.length, 1);
  assert.equal(report.plugins[0].nameSource, "explicit");
  assert.equal(report.plugins[0].accepted, 2);
});

test("repeating the same explicit name is inheritance, not a conflict", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(
    writePlugin(
      "@acme/loon-kit",
      `
api.registerRows({ id: "loon.rows", category: "Banner", name: "Bash card", rows: () => [] });
api.registerSection({ id: "loon.section", title: "Loon", name: "Bash card", lines: () => [] });
`,
    ),
  );

  assert.deepEqual([...footer.statuses.values()], ["Bash card · ready"]);
  const record = getPluginLineReport().plugins[0];
  assert.equal(record.nameConflicts.length, 0);
  assert.equal(record.rejected.length, 0);
  assert.equal(record.accepted, 2);
});

test("a different name from the same identity keeps one row and reports the conflict", async () => {
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  const root = writePackageRoot("@acme/loon-kit");
  const first = writeModuleAt(
    root,
    "src/first.mjs",
    `api.registerRows({ id: "loon.rows", category: "Banner", name: "Bash card", rows: () => [] });`,
  );
  await loadPlugin(first);

  assert.deepEqual([...footer.statuses.values()], ["Bash card · ready"], "the first name stays");
  assert.equal(footer.statuses.size, 1, "a conflicting name adds no second row");
  assert.deepEqual(
    footer.calls.map((entry) => entry.text),
    ["Bash card · ready"],
    "the row is never repainted under the conflicting name",
  );

  const second = writeModuleAt(
    root,
    "src/second.mjs",
    `api.registerSection({ id: "loon.section", title: "Loon", name: "Loon kit", lines: () => [] });`,
  );
  await loadPlugin(second);

  assert.deepEqual([...footer.statuses.values()], ["Bash card · ready"]);
  assert.equal(footer.statuses.size, 1);
  const record = getPluginLineReport().plugins[0];
  assert.equal(record.name, "Bash card");
  assert.deepEqual(record.nameConflicts, [
    { surface: "section", id: "loon.section", name: "Loon kit", kept: "Bash card" },
  ]);
  assert.equal(record.rejected.length, 0, "the registration itself was accepted");
  assert.equal(record.accepted, 2);
  assert.equal(record.status, "ready");

  const printed = formatStatus(collectStatus()).join("\n");
  assert.match(
    printed,
    /name conflict on section "loon\.section": declared "Loon kit", kept "Bash card"/u,
    "the conflict is reported where the author looks",
  );

  // Registering the same conflicting declaration again reports it once, not once per call.
  const third = writeModuleAt(
    root,
    "src/third.mjs",
    `api.registerSection({ id: "loon.section", title: "Loon", name: "Loon kit", lines: () => [] });`,
  );
  await loadPlugin(third);
  assert.equal(
    getPluginLineReport().plugins.length,
    1,
    "a third module in the same package is the same plugin",
  );
  assert.equal(getPluginLineReport().plugins[0].nameConflicts.length, 1);
});

test("one identity survives another module in the same package, and a package rename keeps its key", async () => {
  const root = writePackageRoot("acme-loon");
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  const first = writeModuleAt(
    root,
    "src/first.mjs",
    `api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });`,
  );
  await loadPlugin(first);

  assert.deepEqual([...footer.statuses.values()], ["Acme loon · ready"]);
  const keyBefore = getPluginLineReport().plugins[0].key;

  // A second module in the same package is the same plugin (I8), and it may name it (I9).
  const second = writeModuleAt(
    root,
    "src/second.mjs",
    `api.registerSection({ id: "loon.section", title: "Loon", name: "Bash card", lines: () => [] });`,
  );
  await loadPlugin(second);

  const afterName = getPluginLineReport();
  assert.equal(afterName.plugins.length, 1);
  assert.equal(afterName.plugins[0].key, keyBefore, "an explicit name never changes the key");
  assert.equal(afterName.plugins[0].name, "Bash card");
  assert.deepEqual([...footer.statuses.values()], ["Bash card · ready"]);

  // Renaming the PACKAGE is the same identity at the same root: same key, no orphan (I10).
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "acme-falcon", type: "module" }));
  resetPluginLinesForTests();
  const renamedFooter = createFakeFooter();
  installPluginStatus(renamedFooter.ui);
  const third = writeModuleAt(
    root,
    "src/third.mjs",
    `api.registerRows({ id: "loon.reloaded", category: "Banner", rows: () => [] });`,
  );
  await loadPlugin(third);

  const afterRename = getPluginLineReport();
  assert.equal(afterRename.plugins[0].key, keyBefore, "the key is the identity, not the package name");
  assert.equal(afterRename.plugins[0].name, "Acme falcon", "the derived label follows the new package name");
  assert.deepEqual([...renamedFooter.statuses.values()], ["Acme falcon · ready"]);
});

test("a module owned by the Pi distribution gets no row, and says why", async () => {
  const root = writePackageRoot("@acme/pi-coding-agent", { bin: { pi: "./dist/cli.js" } });
  const file = writeModuleAt(
    root,
    "extensions/bash-card.mjs",
    `api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });`,
  );
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(file);

  assert.equal(footer.statuses.size, 0, "the Pi distribution is never a plugin identity");
  const record = getPluginLineReport().plugins[0];
  assert.equal(record.name, undefined);
  assert.equal(record.accepted, 1, "the registration itself still happened");
  assert.match(record.reason ?? "", /Pi installation/u);

  const printed = formatStatus(collectStatus()).join("\n");
  assert.match(printed, /\(no line\)/u);
  assert.match(printed, /Pi installation/u);
  assert.ok(printed.includes(file), "the module is named as a diagnostic, never as a row");
});

test("a Pi-owned module can still name itself explicitly, and gets exactly one row", async () => {
  const root = writePackageRoot("@acme/pi-coding-agent", { bin: { pi: "./dist/cli.js" } });
  const file = writeModuleAt(
    root,
    "extensions/bash-card.mjs",
    `
api.registerRows({ id: "loon.rows", category: "Banner", name: "Bash card", rows: () => [] });
api.registerSection({ id: "loon.section", title: "Loon", lines: () => [] });
`,
  );
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  await loadPlugin(file);

  assert.deepEqual([...footer.statuses.values()], ["Bash card · ready"]);
  assert.equal(new Set(footer.calls.map((entry) => entry.key)).size, 1);
  const record = getPluginLineReport().plugins[0];
  assert.equal(record.nameSource, "explicit");
  assert.equal(record.accepted, 2);
});

test("the package that owns the running entry point is recognised as the Pi distribution", async () => {
  const root = writePackageRoot("acme-pi-runtime");
  const cli = writeModuleAt(root, "dist/cli.mjs", "");
  const file = writeModuleAt(
    root,
    "extensions/other.mjs",
    `api.registerRows({ id: "loon.rows", category: "Banner", rows: () => [] });`,
  );
  const footer = createFakeFooter();
  installPluginStatus(footer.ui);

  const previous = process.argv[1];
  (process.argv as string[])[1] = cli;
  try {
    await loadPlugin(file);
  } finally {
    (process.argv as string[])[1] = previous;
  }

  assert.equal(footer.statuses.size, 0, "recognised as the running pi installation, not derived");
  assert.match(getPluginLineReport().plugins[0].reason ?? "", /Pi installation/u);
});

test("the example installed under the Pi distribution registers one identity and one row", async () => {
  const distRoot = writePackageRoot("@acme/pi-coding-agent", { bin: { pi: "./dist/cli.js" } });
  const extensions = join(distRoot, "extensions");
  mkdirSync(extensions, { recursive: true });
  const installed = join(extensions, "bash-card.ts");
  writeFileSync(
    installed,
    readFileSync(new URL("../examples/bash-card.ts", import.meta.url), "utf8"),
  );
  const configHome = mkdtempSync(join(tmpdir(), "gsb-example-config-"));
  scratchDirs.push(configHome);
  const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
  publishBridgeApi();

  const footer = createFakeFooter();
  installPluginStatus(footer.ui);
  const sessionHandlers: Array<
    (event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void
  > = [];
  try {
    const loaded = (await import(`${pathToFileURL(installed).href}?load=${String(Date.now())}`)) as {
      default: (pi: {
        on?: (event: string, handler: (event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void) => void;
      }) => () => void;
    };
    const dispose = loaded.default({
      on(_event, handler) {
        sessionHandlers.push(handler);
      },
    });
    try {
      assert.equal(sessionHandlers.length, 1, "the example registers from its session_start handler");
      sessionHandlers[0]({}, { hasUI: true, ui: footer.ui });
    } finally {
      dispose();
    }
  } finally {
    if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
    else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  }

  assert.deepEqual(
    [...footer.statuses.values()],
    ["Card bash · ready"],
    "the design, the demo provider, the section and the card style: one identity, one row",
  );
  assert.equal(footer.statuses.size, 1);
  assert.equal(new Set(footer.calls.map((entry) => entry.key)).size, 1);
  const report = getPluginLineReport();
  assert.equal(report.plugins.length, 1);
  assert.equal(report.plugins[0].name, "Card bash");
  assert.equal(report.plugins[0].nameSource, "explicit");
  assert.ok(
    report.plugins[0].key.startsWith(`${PLUGIN_LINE_PREFIX}bash-card.`),
    "the key names the plugin module, never the Pi distribution (I10, I11)",
  );
  assert.equal(
    report.plugins[0].accepted,
    4,
    "the bash design, the demo row provider, the CARD BASH section and the plain card style",
  );
  assert.equal(report.plugins[0].rejected.length, 0);
  assert.equal(report.plugins[0].nameConflicts.length, 0);
});

/** The example's OWN store value, read the way a user reads the file (`bash-card.json`). */
const storedPresses = (configHome: string): unknown => {
  const document = JSON.parse(
    readFileSync(join(configHome, "gentle-shell-bridge", "bash-card.json"), "utf8"),
  ) as { values?: Record<string, unknown> };
  return document.values?.demoPresses;
};

/** The `demo presses` row of the example's section, as it is drawn right now. */
const pressesRow = (
  section: { lines(ctx: { theme: undefined; configHome: string }): unknown[] },
  configHome: string,
): { label?: string; meta?: string; onClick?: () => void } | undefined => {
  const row = section.lines({ theme: undefined, configHome }).find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { label?: unknown }).label === "demo presses",
  );
  return row as { label?: string; meta?: string; onClick?: () => void } | undefined;
};

test("T42: the example's `demo presses` row is clickable, prints once, and hovers through the host's rail", async () => {
  const configHome = mkdtempSync(join(tmpdir(), "gsb-example-demo-"));
  scratchDirs.push(configHome);
  const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
  try {
    resetSidebar();
    resetSidebarStateForTests();
    resetSectionFailuresForTests();
    resetSectionPanelForTests();
    resetSectionPointerForTests();
    resetRepaintForTests();
    disableSidebarBackend();

    // The real entry: the example's default export, loaded from its own file, registers the section
    // through the published bridge object exactly as Pi loads it.
    publishBridgeApi();
    const installed = new URL("../examples/bash-card.ts", import.meta.url);
    const sessionHandlers: Array<
      (event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void
    > = [];
    const loaded = (await import(
      `${pathToFileURL(installed.pathname).href}?load=${String(Date.now())}`
    )) as {
      default: (pi: {
        on?: (event: string, handler: (event: unknown, ctx: { hasUI?: boolean; ui?: unknown }) => void) => void;
      }) => () => void;
    };
    const dispose = loaded.default({
      on(_event, handler) {
        sessionHandlers.push(handler);
      },
    });
    try {
      sessionHandlers[0]({}, { hasUI: true, ui: createFakeFooter().ui });

      const section = snapshotSections().find((candidate) => candidate.id === "bash-card.status");
      assert.ok(section !== undefined, "the example registered its section through the real entry");
      const ctx = { theme: undefined, configHome };
      assert.equal(section.meta?.(ctx), "default", "the header meta is the live selection");
      assert.equal(
        section
          .lines(ctx)
          .some((row) => typeof row !== "string" && row.label === "selected"),
        false,
        "the selection is printed once, never as a duplicate body row",
      );

      const presses = pressesRow(section, configHome);
      assert.ok(presses !== undefined, "the demo presses row is a structured row");
      assert.equal(presses.meta, "0", "its meta is the live press count");
      assert.equal(typeof presses.onClick, "function", "and it is a clickable action row");

      presses.onClick?.();
      assert.equal(storedPresses(configHome), 1, "one action, one stored increment");
      assert.equal(pressesRow(section, configHome)?.meta, "1", "the next frame reads the new count");
      presses.onClick?.();
      assert.equal(storedPresses(configHome), 2, "and one more action, one more increment");

      // The same row, mounted on the host's rail: hover paints it, a click runs it once.
      let renders = 0;
      setRepaintHost({
        terminal: fakeTerminal(),
        requestRender: () => {
          renders += 1;
        },
      });
      setSectionTheme({
        fg: (role: string, text: string) => (role === "warning" ? `\u001b[33m${text}\u001b[39m` : text),
        bold: (text: string) => text,
      });
      registerNativeFooter();
      installSidebarBackend(() => fakeTui());
      installSectionRail();
      renderSidebar();

      const rail = fakeState().parts.get(SIDEBAR_RAIL_KEY);
      const frame = rail?.render(40) ?? [];
      const y = frame.findIndex((row) => row.includes("demo presses"));
      assert.ok(y > 0, "the action row is inside the host part's frame");
      assert.ok(!frame[y]?.includes("\u001b[33m"), "it starts idle");

      const before = renders;
      assert.deepEqual(
        rail?.handleMouse?.({ type: "move", button: "none", x: 4, y, width: 40, height: 40 }),
        { handled: true, render: true },
        "the row answers a hover through the host's dispatch",
      );
      assert.equal(renders, before + 1, "one frame is asked for");
      assert.ok(
        (rail?.render(40) ?? [])[y]?.includes("\u001b[33m"),
        "and it is painted with the host's hover role",
      );

      assert.deepEqual(
        rail?.handleMouse?.({ type: "click", button: "left", x: 4, y, width: 40, height: 40 }),
        { handled: true, render: true },
      );
      assert.equal(storedPresses(configHome), 3, "one rail click, one increment");
    } finally {
      dispose();
    }
  } finally {
    if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
    else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  }
});
