/**
 * The customize rows for tool designs (S6, T9): one line per tool that HAS designs, in the `Cards`
 * category, with the tool's own card as one value and each design as another. The selection is
 * persisted per tool in the bridge's own store, and changing it repaints the cards already drawn
 * through `requestRepaint()` — one differential frame, because the wrapper re-reads the live selection
 * on every render pass (S13/T23: dropping the caches was the freeze).
 *
 * Asserted through the row contract the host receives — `buildRows` — and the store file, so the
 * test reads what the menu reads.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { snapshotProviders } from "../src/bus.ts";
import { resetNoticesForTests } from "../src/notices.ts";
import { resetPluginLinesForTests } from "../src/plugin-lines.ts";
import { getRepaintDiagnostics, resetRepaintForTests, setRepaintHost } from "../src/repaint.ts";
import { buildRows, resetRowBuildStateForTests } from "../src/rows.ts";
import { collectStatus, formatStatus } from "../src/status.ts";
import { createStore, resetStoreStateForTests } from "../src/store.ts";
import {
  TOOL_DESIGN_DEFAULT_LABEL,
  TOOL_DESIGN_NATIVE,
  getToolDesignLineSelection,
  getToolDesignSelection,
  registerToolDesign,
  resetToolDesignsForTests,
  setToolDesignLineSelection,
  setToolDesignSelection,
  toolNamesWithDesigns,
} from "../src/tool-designs.ts";
import {
  TOOL_DESIGN_ROWS_PROVIDER_ID,
  installToolDesignRows,
  resetToolDesignRowStateForTests,
} from "../src/tool-design-rows.ts";
import {
  resetToolDesignWiringForTests,
  toolDesignResolver,
} from "../src/tool-design-wiring.ts";
import type { CustomizeRow, ToolDesignRegistration, ToolDesignScope } from "../src/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-tool-design-rows-"));
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
  resetToolDesignsForTests();
  resetToolDesignRowStateForTests();
  resetToolDesignWiringForTests();
  resetRepaintForTests();
  resetStoreStateForTests();
  resetNoticesForTests();
  resetPluginLinesForTests();
  resetRowBuildStateForTests();
});

const bashHeading: ToolDesignRegistration = {
  tool: "bash",
  id: "loon.bash-heading",
  label: "bash heading",
  description: "heads the card with bash instead of the host's $ prompt",
  preview: () => ({ title: "Cards · bash heading", sample: "bash ls -la" }),
  apply: (lines) => [...lines],
};

const bashFramed: ToolDesignRegistration = {
  tool: "bash",
  id: "loon.bash-framed",
  label: "bash framed",
  apply: (lines) => [...lines],
};

const writeBadge: ToolDesignRegistration = {
  tool: "write",
  id: "loon.write-badge",
  label: "write badge",
  apply: (lines) => [...lines],
};

/** The rows one menu build receives, with the design bus installed. */
const rowsForBuild = (): CustomizeRow[] => {
  installToolDesignRows();
  return buildRows({ theme: undefined, configHome }).rows;
};

/** The lines the host would draw for one setting, reading `current()` at render time. */
const toggleLines = (rows: readonly CustomizeRow[]): string[] => {
  const lines: string[] = [];
  let index = 0;
  while (index < rows.length) {
    const setting = rows[index].choice?.setting;
    if (setting === undefined) {
      index += 1;
      continue;
    }
    let end = index;
    while (end + 1 < rows.length && rows[end + 1].choice?.setting === setting) end += 1;
    const marks = rows
      .slice(index, end + 1)
      .map((row) => `${row.choice?.current() === true ? "●" : "○"} ${row.choice?.value ?? ""}`);
    lines.push(`${setting} ${marks.join(" ")}`);
    index = end + 1;
  }
  return lines;
};

const recordingTui = (): { calls: string[]; host: Record<string, unknown> } => {
  const calls: string[] = [];
  return {
    calls,
    host: {
      terminal: {},
      invalidate: () => calls.push("invalidate"),
      requestRender: () => calls.push("requestRender"),
    },
  };
};

test("T9: the bridge owns one rows provider, and it is internal plumbing", () => {
  installToolDesignRows();
  assert.deepEqual(
    snapshotProviders().map((provider) => provider.id),
    [TOOL_DESIGN_ROWS_PROVIDER_ID],
  );
  installToolDesignRows();
  assert.equal(snapshotProviders().length, 1, "installing twice replaces the provider in place");
});

test("T9: no design means NO line: a session that never registers one is unchanged", () => {
  assert.deepEqual(rowsForBuild(), []);
});

test("T9: one Cards line per tool that has designs, in Cards, values are the tool's card + designs", () => {
  registerToolDesign(bashHeading);
  registerToolDesign(bashFramed);
  registerToolDesign(writeBadge);

  const rows = rowsForBuild();

  assert.ok(rows.every((row) => row.category === "Cards"), "every row belongs to Cards");
  const lines = toggleLines(rows);
  assert.equal(lines.length, 2, "one line per tool, never one line per design");
  assert.match(lines[0], /^Card bash /u, "the line is named after the Cards category, then the tool");
  assert.match(lines[0], /● default/u, "the tool's own card is the default selection");
  assert.match(lines[0], /○ bash heading/u);
  assert.match(lines[0], /○ bash framed/u);
  assert.match(lines[1], /^Card write /u);
  assert.match(lines[1], /○ write badge/u);
});

test("T9: the selection persists PER TOOL and moves the bullet on the next build", async () => {
  registerToolDesign(bashHeading);
  registerToolDesign(writeBadge);

  const rows = rowsForBuild();
  const pick = rows.find((row) => row.choice?.value === "bash heading");
  assert.ok(pick?.action !== undefined);
  await pick.action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined });

  assert.equal(getToolDesignSelection("bash"), "loon.bash-heading");
  assert.equal(getToolDesignSelection("write"), TOOL_DESIGN_NATIVE, "the other tool did not move");

  const after = toggleLines(rowsForBuild());
  assert.match(after[0], /○ default ● bash heading/u);
  assert.match(after[1], /● default ○ write badge/u);

  // And the way back to the host's own card.
  const native = rowsForBuild().find(
    (row) => row.choice?.value === TOOL_DESIGN_DEFAULT_LABEL && row.choice?.setting === "Card bash",
  );
  assert.ok(native?.action !== undefined);
  await native.action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined });
  assert.equal(getToolDesignSelection("bash"), TOOL_DESIGN_NATIVE);
});

test("T9: changing the value repaints the drawn cards through requestRepaint()", async () => {
  registerToolDesign(bashHeading);
  const tui = recordingTui();
  setRepaintHost(tui.host);

  const rows = rowsForBuild();
  const pick = rows.find((row) => row.choice?.value === "bash heading");
  assert.ok(pick?.action !== undefined);
  await pick.action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined });

  assert.deepEqual(
    tui.calls,
    ["requestRender"],
    "one differential frame; no cache is dropped and no forced full redraw is asked for",
  );
  assert.equal(getRepaintDiagnostics().lastTrigger?.outcome, "repainted");

  // Pressing the value that is already selected costs no frame.
  tui.calls.length = 0;
  await pick.action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined });
  assert.deepEqual(tui.calls, []);
});

test("T9: a design's own preview is the preview its value shows", () => {
  registerToolDesign(bashHeading);
  registerToolDesign(writeBadge);

  const rows = rowsForBuild();
  const heading = rows.find((row) => row.choice?.value === "bash heading");
  assert.ok(heading?.preview !== undefined);
  assert.deepEqual(heading.preview(), { title: "Cards · bash heading", sample: "bash ls -la" });

  const badge = rows.find((row) => row.choice?.value === "write badge");
  assert.ok(badge?.preview !== undefined);
  assert.match(badge.preview().title, /write badge/u);

  const native = rows.find(
    (row) => row.choice?.value === TOOL_DESIGN_DEFAULT_LABEL && row.choice?.setting === "Card bash",
  );
  assert.ok(native?.preview !== undefined);
  assert.match(native.preview().sample, /own card|host/u);
});

test("T9: the line name starts with `Card `, then the tool's readable words, like the host's rows", () => {
  registerToolDesign({ ...writeBadge, tool: "bash", id: "loon.bash-heading" });
  registerToolDesign({ ...writeBadge, tool: "lsp_navigation", id: "loon.lsp" });
  registerToolDesign({ ...writeBadge, tool: "mcp__engram__mem_save", id: "loon.mcp" });
  registerToolDesign({ ...writeBadge, tool: "···", id: "loon.nowords" });

  const settings = [...new Set(rowsForBuild().map((row) => row.choice?.setting))];

  assert.deepEqual(settings, [
    "Card bash",
    "Card lsp navigation",
    // The TAIL of a long name is the specific part: `Card mcp engram` would say nothing.
    "Card mem save",
    // A tool name that derives to no words keeps the fallback word.
    "Card tool",
  ]);
  for (const setting of settings) {
    assert.ok(setting !== undefined);
    const words = setting.trim().split(/\s+/u);
    assert.ok(words.length >= 1 && words.length <= 3, `${setting} must stay within the word limit`);
    assert.equal(words[0], "Card", `${setting} must start with the Cards category's word`);
    assert.match(setting, /^Card( [a-z0-9]+){1,2}$/u, `${setting} is capitalised like Card style`);
  }
});

test("T9: two tools that clamp to the same name stay distinct and pass the shape rule", () => {
  registerToolDesign({ ...writeBadge, tool: "mcp__alpha__mem_save", id: "loon.alpha" });
  registerToolDesign({ ...writeBadge, tool: "mcp__beta__mem_save", id: "loon.beta" });

  const settings = [...new Set(rowsForBuild().map((row) => row.choice?.setting))];

  assert.deepEqual(settings, ["Card mem save", "Card mem 2"], "the second gets the lowest free ordinal");
  for (const setting of settings) {
    assert.ok(setting !== undefined);
    assert.ok(
      setting.trim().split(/\s+/u).length <= 3,
      `${setting} must stay within the row-name word limit`,
    );
    assert.doesNotMatch(setting, /[.:|/\\[\](){}→]/u, `${setting} must carry no structural mark`);
  }
});

test("T9: the persisted value and the stored selection are unchanged by the line's name", async () => {
  registerToolDesign(bashHeading);

  const pick = rowsForBuild().find((row) => row.choice?.value === "bash heading");
  assert.ok(pick?.action !== undefined);
  assert.equal(pick.choice?.setting, "Card bash", "the line is named after the card, not after the store");
  await pick.action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined });

  // The VALUE is the design's id and the store is still keyed by the TOOL name: only the visible
  // line name moved.
  assert.equal(getToolDesignSelection("bash"), "loon.bash-heading");
  const stored = createStore("bridge-tool-designs").get<Record<string, unknown>>("selections", {});
  assert.deepEqual(stored, { bash: "loon.bash-heading" });
});

test("T9: a tool name keeps a row name that passes the shape rule, even a long MCP one", () => {
  registerToolDesign({ ...writeBadge, tool: "mcp__engram__mem_save", id: "loon.mcp" });
  registerToolDesign({ ...writeBadge, tool: "mcp__engram__mem_search", id: "loon.mcp2" });

  installToolDesignRows();
  const result = buildRows({ theme: undefined, configHome });
  const rows = result.rows;

  assert.deepEqual(result.failures, []);
  const settings = new Set(rows.map((row) => row.choice?.setting));
  assert.equal(settings.size, 2, "two long tool names still produce two distinct lines");
  for (const setting of settings) {
    assert.ok(setting !== undefined);
    assert.ok(
      setting.trim().split(/\s+/u).length <= 3,
      `${setting} must stay within the row-name word limit`,
    );
    assert.doesNotMatch(setting, /[.:|/\\[\](){}→]/u, `${setting} must carry no structural mark`);
  }
});

test("T9: tools are listed in a deterministic order, and only tools with designs appear", () => {
  registerToolDesign(writeBadge);
  registerToolDesign(bashHeading);

  const rows = rowsForBuild();
  assert.deepEqual(toolNamesWithDesigns(), ["write", "bash"], "registration order");
  assert.deepEqual(
    [...new Set(rows.map((row) => row.choice?.setting))].length,
    2,
  );
  assert.equal(
    rows.some((row) => row.choice?.setting.toLowerCase().includes("edit")),
    false,
    "a tool with no design has no line",
  );
});

test("S2: picking a design in the menu repaints the card ALREADY on screen", async () => {
  // The user's words: the choice has to change "tanto las antiguas como posteriores", not only new
  // cards. Pi resolves the renderers once, when the card is constructed, and re-renders that same
  // component on every frame — so this is the card the menu action must reach.
  const hostCard = ["│ $ ls -la", "│ total 4"];
  const component = { render: (_width: number): string[] => [...hostCard] };
  const renderers = { renderShell: "default", renderCall: () => component };

  registerToolDesign({
    ...bashHeading,
    apply: (lines) => lines.map((line) => line.replace("$ ", "bash ")),
  });
  const resolved = toolDesignResolver("bash", () => renderers);
  assert.ok(resolved !== undefined);
  const card = (resolved.renderCall as () => typeof component)();
  assert.deepEqual(card.render(80), hostCard, "no design selected: the host's own bytes");

  const pick = rowsForBuild().find((row) => row.choice?.value === "bash heading");
  assert.ok(pick?.action !== undefined);
  await pick.action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined });

  assert.deepEqual(
    card.render(80),
    ["│ bash ls -la", "│ total 4"],
    "the SAME, already-drawn card now shows the design the menu selected",
  );
});

test("PRESERVE: the provider's rows stay empty after the last design is disposed", () => {
  const dispose = registerToolDesign(bashHeading);
  assert.equal(rowsForBuild().length, 2, "native + one design");
  dispose();
  assert.deepEqual(rowsForBuild(), []);
});

// ---------------------------------------------------------------------------------------------
// S1/S3/S8 — ONE line over several tools
// ---------------------------------------------------------------------------------------------

const grouped = (overrides: Partial<ToolDesignRegistration> = {}): ToolDesignRegistration => ({
  line: "tools",
  tools: ["bash", "write"],
  id: "loon.tools-activity",
  label: "activity",
  apply: (lines) => [...lines],
  ...overrides,
});

test("S1/S3: a grouped line is ONE Cards row named after the line, default first, then its designs", () => {
  registerToolDesign(grouped({ tools: ["bash", "write"] }));
  registerToolDesign(grouped({ id: "loon.tools-complete", label: "complete", tools: ["bash"] }));

  const lines = toggleLines(rowsForBuild());
  assert.deepEqual(
    lines,
    ["Card tools ● default ○ activity ○ complete"],
    "one line for bash, write and read, named by the line, in registration order",
  );
});

test("S7: picking a grouped value stores it per LINE under `lines`, never per tool", async () => {
  registerToolDesign(grouped());

  const pick = rowsForBuild().find((row) => row.choice?.value === "activity");
  assert.ok(pick?.action !== undefined);
  await pick.action({ input: async () => undefined, confirm: async () => true, capture: async () => undefined });

  assert.equal(getToolDesignLineSelection("line", "tools"), "loon.tools-activity");
  assert.equal(getToolDesignSelection("bash"), TOOL_DESIGN_NATIVE, "the per-tool map did not move");
  assert.deepEqual(
    createStore("bridge-tool-designs").get("selections", {}),
    { $lines: { tools: "loon.tools-activity" } },
    "the choice is keyed by the line, inside the ONE stored value (one read per frame)",
  );
});

test("S8: a line and a tool that derive the same name are told apart by the ordinal rule", () => {
  registerToolDesign({ ...writeBadge, tool: "tools", id: "loon.tool-tools", label: "tools card" });
  registerToolDesign(grouped({ tools: ["bash"], id: "loon.line-tools", label: "line tools" }));

  const settings = [...new Set(rowsForBuild().map((row) => row.choice?.setting))];
  assert.deepEqual(
    settings,
    ["Card tools", "Card tools 2"],
    "the same name from a tool and a line gets the lowest free ordinal, deterministically",
  );
});

test("D5: a design preview is drawn as ONE row: the sample's first line only", () => {
  registerToolDesign({
    ...bashHeading,
    preview: () => ({ title: "Cards · multiline", sample: "first row\nsecond row" }),
  });

  const row = rowsForBuild().find((candidate) => candidate.choice?.value === bashHeading.label);
  assert.ok(row?.preview !== undefined);
  assert.deepEqual(row.preview(), { title: "Cards · multiline", sample: "first row" });
});

test("D3: a legacy per-tool value appears selected on the line once the tool joins it", () => {
  setToolDesignSelection("bash", "loon.tools-activity");
  registerToolDesign(grouped({ tools: ["bash", "write"] }));

  assert.match(toggleLines(rowsForBuild())[0] ?? "", /○ default ● activity/u);
});

// ---------------------------------------------------------------------------------------------
// S13 — a scoped line shows its scope inside the SAME preview row
// ---------------------------------------------------------------------------------------------

const SCOPE_DESCRIPTION = "paths under skills/ or odd/";

/** The second line the consumer asked for: scoped to the paths its own `apply` recognises. */
const scopedDiff: ToolDesignRegistration = {
  line: "diff",
  tools: ["write"],
  id: "loon.diff",
  label: "diff card",
  description: "draws a write as an IDE diff",
  scope: {
    description: SCOPE_DESCRIPTION,
    matches: (call) =>
      typeof (call.args as { path?: unknown } | undefined)?.path === "string",
  },
  preview: () => ({ title: "Cards · diff card", sample: "◂ diff src/index.ts" }),
  apply: (lines) => [...lines],
};

const unscopedLine: ToolDesignRegistration = {
  line: "tools",
  tools: ["read"],
  id: "loon.tools-activity",
  label: "activity",
  apply: (lines) => [...lines],
};

test("S13: one row per line, `default` first, and a scoped line's description in its preview row", () => {
  registerToolDesign(unscopedLine);
  registerToolDesign(scopedDiff);

  const rows = rowsForBuild();
  assert.deepEqual(
    toggleLines(rows),
    ["Card tools ● default ○ activity", "Card diff ● default ○ diff card"],
    "row count, row order and naming are unchanged: one line per line, default first",
  );

  for (const value of [TOOL_DESIGN_DEFAULT_LABEL, "diff card"]) {
    const row = rows.find(
      (candidate) => candidate.choice?.setting === "Card diff" && candidate.choice?.value === value,
    );
    assert.ok(row?.preview !== undefined, `${value}: a scoped line's values keep their preview`);
    const preview = row.preview();
    assert.match(preview.sample, /paths under skills\/ or odd\//u, `${value}: the scope is explained`);
    assert.doesNotMatch(preview.sample, /\n/u, `${value}: still ONE row, never a second line`);
  }

  // The unscoped line's values say nothing about a scope they do not have.
  for (const row of rows.filter((candidate) => candidate.choice?.setting === "Card tools")) {
    assert.ok(row.preview !== undefined);
    assert.doesNotMatch(row.preview().sample, /scope/u);
  }
});

test("S2/S13/S14: disposing a value preserves the DISPLAY order of the lines it does not change", () => {
  // Claim PRECEDENCE is line creation order (S10); DISPLAY order is a different thing and stays what
  // it always was: the Cards rows and the `/bridge-status` block follow the first LIVE registration of
  // a line (S2). Disposing the founding value of a line, while a later value of it survives, must
  // therefore move neither the menu nor the status order — it moved both before this test existed.
  const alphaLine = (id: string): ToolDesignRegistration => ({
    line: "alpha",
    tools: ["write"],
    id,
    label: id,
    apply: (lines) => [...lines],
  });
  const disposeFounding = registerToolDesign(alphaLine("loon.alpha-one"));
  registerToolDesign({ tool: "read", id: "loon.read-card", label: "read card", apply: (lines) => [...lines] });
  registerToolDesign(alphaLine("loon.alpha-two"));

  /** What a person reads: the tools status walks, and the lines the menu draws, in order. */
  const shown = (): { status: string[]; menu: Array<string | undefined> } => {
    const designs = collectStatus().toolDesigns;
    assert.ok(designs !== undefined);
    return {
      status: designs.tools.map((entry) => entry.tool),
      menu: rowsForBuild().map((row) => row.choice?.setting),
    };
  };

  assert.deepEqual(
    shown(),
    {
      status: ["write", "read"],
      menu: ["Card alpha", "Card alpha", "Card alpha", "Card read", "Card read"],
    },
    "while both values of `alpha` are live: the first registration of each line orders it",
  );

  disposeFounding();

  assert.deepEqual(
    shown(),
    {
      status: ["read", "write"],
      menu: ["Card read", "Card read", "Card alpha", "Card alpha"],
    },
    "after disposing alpha's founding value, the menu and status follow the first LIVE entry",
  );
});

test("S13/PRESERVE: an unscoped registry's rows are byte-identical to today", () => {
  registerToolDesign(bashHeading);
  registerToolDesign(writeBadge);

  const shown = rowsForBuild().map((row) => ({
    setting: row.choice?.setting,
    value: row.choice?.value,
    preview: row.preview?.(),
  }));
  assert.deepEqual(shown, [
    {
      setting: "Card bash",
      value: TOOL_DESIGN_DEFAULT_LABEL,
      preview: {
        title: "Cards · Card bash",
        sample: "Card bash: the host's own card for bash, untouched",
      },
    },
    {
      setting: "Card bash",
      value: "bash heading",
      preview: { title: "Cards · bash heading", sample: "bash ls -la" },
    },
    {
      setting: "Card write",
      value: TOOL_DESIGN_DEFAULT_LABEL,
      preview: {
        title: "Cards · Card write",
        sample: "Card write: the host's own card for write, untouched",
      },
    },
    {
      setting: "Card write",
      value: "write badge",
      preview: {
        title: "Cards · write badge",
        sample: "write badge: rewrites the rows write's own card produced",
      },
    },
  ]);
});


// ---------------------------------------------------------------------------------------------
// S19 — the scope belongs to the (line, tool) CLAIM, not to the line
// ---------------------------------------------------------------------------------------------

/** The consumer's rule: a path under `skills/` or `odd/`. */
const CONSUMER_SCOPE: ToolDesignScope = {
  description: SCOPE_DESCRIPTION,
  matches: (call) => typeof (call.args as { path?: unknown } | undefined)?.path === "string",
};

/** `Card tools`: bash for EVERY call, write/edit only under skills/ or odd/ — ONE shared scope. */
const toolsLine: ToolDesignRegistration = {
  line: "tools",
  tools: ["bash", "write", "edit"],
  id: "odd-worktree.tools",
  label: "tools activity",
  scopes: { write: CONSUMER_SCOPE, edit: CONSUMER_SCOPE },
  apply: (lines) => [...lines],
};

/** `Card diff`: write and edit for EVERY call — the generic claim the specific one wins over. */
const diffLine: ToolDesignRegistration = {
  line: "diff",
  tools: ["write", "edit"],
  id: "odd-worktree.diff",
  label: "diff card",
  apply: (lines) => [...lines],
};

test("S19/S13: a line's scopes stay inside ONE preview row, today's text when they share one", () => {
  registerToolDesign(toolsLine);
  registerToolDesign(diffLine);

  const rows = rowsForBuild();
  assert.deepEqual(
    toggleLines(rows),
    ["Card tools ● default ○ tools activity", "Card diff ● default ○ diff card"],
    "still one row per line, `default` first",
  );

  // ONE scope object across the line's scoped claims: today's text, byte for byte.
  const toolsRows = rows.filter((row) => row.choice?.setting === "Card tools");
  assert.equal(toolsRows.length, 2);
  for (const row of toolsRows) {
    assert.ok(row.preview !== undefined);
    const preview = row.preview();
    assert.ok(
      preview.sample.endsWith(` — scope: ${SCOPE_DESCRIPTION}`),
      `${row.choice?.value}: today's text, byte for byte`,
    );
    assert.doesNotMatch(preview.sample, /;/u, `${row.choice?.value}: one scope, not a per-tool list`);
    assert.doesNotMatch(preview.sample, /\n/u, `${row.choice?.value}: still ONE row`);
  }

  // The unscoped line says nothing about a scope it does not have.
  for (const row of rows.filter((candidate) => candidate.choice?.setting === "Card diff")) {
    assert.ok(row.preview !== undefined);
    assert.doesNotMatch(row.preview().sample, /scope/u);
  }

  // Several DISTINCT scopes on one line: one ` — scope: <tools>: <description>` per scope, joined by
  // `; `, still inside the SAME preview row.
  registerToolDesign({
    line: "per-tool",
    tools: ["bash", "write"],
    id: "loon.per-tool",
    label: "per tool",
    scopes: {
      bash: { description: "bash commands", matches: () => true },
      write: { description: "paths under odd/", matches: () => true },
    },
    apply: (lines) => [...lines],
  });

  const perTool = rowsForBuild().filter((row) => row.choice?.setting === "Card per tool");
  assert.equal(perTool.length, 2, "one row per value, `default` first");
  const expected = " — scope: bash: bash commands; — scope: write: paths under odd/";
  const nativePreview = perTool[0].preview?.();
  assert.ok(nativePreview !== undefined);
  assert.equal(
    nativePreview.sample,
    `Card per tool: the host's own card for bash, write, untouched${expected}`,
  );
  const designPreview = perTool[1].preview?.();
  assert.ok(designPreview !== undefined);
  assert.equal(
    designPreview.sample,
    `per tool: rewrites the rows the bash, write cards produced${expected}`,
    "each scope names the tools it covers, on the same single row",
  );
  assert.doesNotMatch(designPreview.sample, /\n/u, "never a second row");
});

test("S19/S14: /bridge-status lists every claiming line with the scope OF THAT TOOL", () => {
  registerToolDesign(toolsLine);
  registerToolDesign(diffLine);
  setToolDesignLineSelection("line", "tools", "odd-worktree.tools");
  setToolDesignLineSelection("line", "diff", "odd-worktree.diff");

  const designs = collectStatus().toolDesigns;
  assert.ok(designs !== undefined);
  const write = designs.tools.find((entry) => entry.tool === "write");
  assert.ok(write !== undefined);
  assert.equal(write.line, undefined, "a tool with scoped claims lists its lines instead of one");
  assert.deepEqual(
    write.claims,
    [
      { kind: "line", line: "tools", stored: "odd-worktree.tools", scope: SCOPE_DESCRIPTION },
      { kind: "line", line: "diff", stored: "odd-worktree.diff" },
    ],
    "the scope shown is the one of THIS tool's claim, and an unscoped claim shows none",
  );

  // `bash` is claimed by the tools line only, and UNSCOPED: it prints as today, with no claims list.
  const bash = designs.tools.find((entry) => entry.tool === "bash");
  assert.ok(bash !== undefined);
  assert.equal(bash.line, "tools", "today's `line` field");
  assert.equal(bash.claims, undefined, "and no claims list");

  const report = formatStatus(collectStatus()).join("\n");
  assert.match(
    report,
    /line "tools": odd-worktree\.tools — scope: paths under skills\/ or odd\/\n/u,
    "the scoped claim says which calls its line owns",
  );
  assert.match(report, /line "diff": odd-worktree\.diff\n/u, "an unscoped claim adds no scope text");
});
