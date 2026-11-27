/**
 * S19 / L14: the CLAIM SET of `scopes` is every OWN key, and the `scope` shorthand keeps the
 * diagnostics it had before `scopes` existed.
 *
 * Two defects the first S19 audit found, both observable through the published surface:
 *
 * 1. `scopes` was validated through `Object.keys` but READ through every own key, so a key that is
 *    not enumerable (a non-enumerable `read: null`, or a hidden foreign `find`) passed validation and
 *    then reached the live registry — and, through the legacy-selection migration, the persisted
 *    selection. S19 now validates EVERY own key (a symbol key included), and validation and reading
 *    use the SAME key set, so a refused registration leaves the registry and the store untouched.
 * 2. The `scope` shorthand regressed against 262632d: the S8 conflict text and the ungrouped refusal
 *    text changed shape when `scopes` arrived. The shorthand must keep the previous text BYTE FOR
 *    BYTE (it IS `scopes` with one object, so S2 pins it); the per-tool wording belongs to `scopes`.
 *
 * Everything asserted here is public: `registerToolDesign`, the conflict record `/bridge-status`
 * prints, the live snapshot, and the bytes of the store file.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resetNoticesForTests } from "../src/notices.ts";
import { resetPluginLinesForTests } from "../src/plugin-lines.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { createStore, resetStoreStateForTests } from "../src/store.ts";
import {
  TOOL_DESIGN_STORE_ID,
  TOOL_DESIGN_STORE_KEY,
  getToolDesignConflicts,
  registerToolDesign,
  resetToolDesignsForTests,
  snapshotToolDesigns,
  toolDesignClaims,
} from "../src/tool-designs.ts";
import type { ToolDesignRegistration, ToolDesignScope } from "../src/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-tool-design-scopes-audit-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

/** Fresh state per case, the way `test/tool-designs.test.ts` resets the registry and the store. */
const resetAll = (): void => {
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetToolDesignsForTests();
  resetStoreStateForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
};

test.beforeEach(resetAll);

const apply = (lines: readonly string[]): string[] => [...lines];
const scope: ToolDesignScope = { description: "under odd/", matches: () => false };

/** The one store file this surface writes, so a refusal can be shown to leave it byte for byte. */
const storeFile = (): string => join(configHome, "gentle-shell-bridge", `${TOOL_DESIGN_STORE_ID}.json`);

const invalidKeys = [
  ["read", null, /scopes for tool "read" must be an object/u],
  ["find", scope, /scopes names tool "find", which is not one/u],
] as const;

test("S19: a non-enumerable `scopes` key is validated before anything is stored", () => {
  for (const [key, value, reason] of invalidKeys) {
    resetAll();
    const id = `acme.hidden-${key}`;
    // A legacy per-tool selection is exactly what a hidden key used to reach through the migration.
    createStore(TOOL_DESIGN_STORE_ID).set(TOOL_DESIGN_STORE_KEY, { write: id });
    const bytes = readFileSync(storeFile());
    const registry = snapshotToolDesigns();
    const scopes = Object.defineProperty({ write: scope }, key, { value });
    assert.throws(
      () =>
        registerToolDesign({
          line: "tools",
          tools: ["write", "read"],
          scopes,
          id,
          label: `hidden ${key}`,
          apply,
        }),
      reason,
      `${key}: a hidden key is refused`,
    );
    assert.deepEqual(snapshotToolDesigns(), registry, `${key}: the registry is unchanged`);
    assert.deepEqual(readFileSync(storeFile()), bytes, `${key}: the persisted store is unchanged`);
    const conflict = getToolDesignConflicts().find((candidate) => candidate.id === id);
    assert.equal(conflict?.kind, "scope", `${key}: recorded under the scope kind`);
    assert.equal(conflict?.tool, "tools", `${key}: a grouped refusal carries its line`);
    assert.match(conflict?.message ?? "", reason, `${key}: and the same text is recorded`);
  }
});

test("S19: a symbol `scopes` key is refused too, enumerable or not", () => {
  for (const enumerable of [false, true]) {
    resetAll();
    const id = `acme.symbol-${String(enumerable)}`;
    createStore(TOOL_DESIGN_STORE_ID).set(TOOL_DESIGN_STORE_KEY, { write: id });
    const bytes = readFileSync(storeFile());
    const registry = snapshotToolDesigns();
    const foreign = Symbol("find");
    const scopes = Object.defineProperty({ write: scope }, foreign, { value: scope, enumerable });
    assert.throws(
      () =>
        registerToolDesign({ line: "tools", tools: ["write", "read"], scopes, id, label: "symbol", apply }),
      /scopes carries the symbol key Symbol\(find\)/u,
      `enumerable ${String(enumerable)}: a symbol cannot name a tool`,
    );
    assert.deepEqual(snapshotToolDesigns(), registry, "the registry is unchanged");
    assert.deepEqual(readFileSync(storeFile()), bytes, "the persisted store is unchanged");
    const conflict = getToolDesignConflicts().find((candidate) => candidate.id === id);
    assert.equal(conflict?.kind, "scope");
    assert.equal(conflict?.tool, "tools");
  }
});

test("S19: enumerable invalid `scopes` keys are still rejected unchanged", () => {
  for (const [key, value, reason] of invalidKeys) {
    resetAll();
    const id = `acme.plain-${key}`;
    createStore(TOOL_DESIGN_STORE_ID).set(TOOL_DESIGN_STORE_KEY, { write: id });
    const bytes = readFileSync(storeFile());
    const registry = snapshotToolDesigns();
    const scopes = { write: scope, [key]: value } as unknown as Readonly<Record<string, ToolDesignScope>>;
    assert.throws(
      () =>
        registerToolDesign({ line: "tools", tools: ["write", "read"], scopes, id, label: `plain ${key}`, apply }),
      reason,
      `${key}: the ordinary path is unchanged by the own-key validation`,
    );
    assert.deepEqual(snapshotToolDesigns(), registry, `${key}: the registry is unchanged`);
    assert.deepEqual(readFileSync(storeFile()), bytes, `${key}: the persisted store is unchanged`);
    assert.equal(
      getToolDesignConflicts().find((candidate) => candidate.id === id)?.kind,
      "scope",
      `${key}: recorded under the scope kind`,
    );
  }
});

test("S19: a validated non-enumerable key is READ too, so one key set serves both", () => {
  const hidden = "write";
  const scopes = Object.defineProperty({ read: scope }, hidden, { value: scope });
  registerToolDesign({
    line: "tools",
    tools: ["write", "read"],
    scopes,
    id: "acme.hidden-valid",
    label: "hidden valid",
    apply,
  });
  assert.equal(getToolDesignConflicts().length, 0, "nothing was refused");
  assert.equal(toolDesignClaims("write")[0]?.scopeDescription, scope.description);
  assert.equal(toolDesignClaims("read")[0]?.scopeDescription, scope.description);
});

test("S19: the `scope` shorthand keeps the previous conflict diagnostics, byte for byte", (t) => {
  const dispose = registerToolDesign({
    line: "tools",
    tools: ["write"],
    id: "acme.owner",
    label: "owner",
    scope,
    apply,
  });
  t.after(dispose);
  const expected = [
    'gentle-shell-bridge: design "acme.other" for line "tools" was refused whole: the line already ' +
      'carries a different scope on design "acme.owner". One line is one switch, so every live ' +
      "registration of a line must share the SAME scope object (S8); re-register the same (line, id) " +
      "to change it.",
    'gentle-shell-bridge: invalid tool design "acme.ungrouped" for tool "write": a scope is declared ' +
      'on a GROUPED registration only, and `{ tool, id, label, apply }` is that tool\'s own Card "write" ' +
      "line, which means every call of the tool. To claim only SOME calls, register a grouped line " +
      "`{ line, tools, scope, id, label, apply }` for the tool beside the line that already claims " +
      "it. The registration was refused whole.",
  ];
  const registrations: ToolDesignRegistration[] = [
    { line: "tools", tools: ["write"], id: "acme.other", label: "other", scope: { ...scope }, apply },
    { tool: "write", id: "acme.ungrouped", label: "ungrouped", scope, apply },
  ];
  for (const [index, registration] of registrations.entries()) {
    assert.throws(() => registerToolDesign(registration), { message: expected[index] });
    const conflict = getToolDesignConflicts().find((candidate) => candidate.id === registration.id);
    assert.equal(conflict?.message, expected[index], "and the recorded conflict reads the same");
    assert.equal(conflict?.kind, "scope");
    assert.equal(
      conflict?.tool,
      registration.line ?? registration.tool,
      "the shorthand's conflict still carries the line (the tool for the ungrouped refusal)",
    );
  }
  // The formatted /bridge-status block prints the same two diagnostics, in registration order.
  const lines = formatStatus(collectStatus());
  const start = lines.indexOf("tool design conflicts: 2");
  assert.notEqual(start, -1, "the status block lists both conflicts");
  assert.deepEqual(lines.slice(start + 1, start + 3), [
    `  - tools / acme.other (scope): ${expected[0]}`,
    `  - write / acme.ungrouped (scope): ${expected[1]}`,
  ]);
});

test("S19: `scopes` keeps the per-tool wording, naming `scopes` on the ungrouped shape", (t) => {
  const dispose = registerToolDesign({
    line: "tools",
    tools: ["write"],
    id: "acme.scoped-owner",
    label: "scoped owner",
    scopes: { write: scope },
    apply,
  });
  t.after(dispose);
  assert.throws(
    () =>
      registerToolDesign({
        line: "tools",
        tools: ["write"],
        id: "acme.scoped-other",
        label: "scoped other",
        scopes: { write: { ...scope } },
        apply,
      }),
    /the line already carries a different scope on tool "write"/u,
    "a map disagrees per (line, tool)",
  );
  assert.throws(
    () =>
      registerToolDesign({
        tool: "write",
        id: "acme.scoped-ungrouped",
        label: "scoped ungrouped",
        scopes: { write: scope },
        apply,
      } as unknown as ToolDesignRegistration),
    (error: Error) => {
      assert.ok(
        error.message.includes("{ line, tools, scopes, id, label, apply }"),
        "the grouped shape names `scopes`, the member the registration used",
      );
      assert.ok(error.message.includes("`scopes` on an ungrouped registration was refused"));
      return true;
    },
  );
});
