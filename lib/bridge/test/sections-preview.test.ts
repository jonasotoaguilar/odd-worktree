/**
 * The shared `Sections` preview (S1, S2, S4): one list for every section row.
 *
 * The host draws ONE preview for its `Sections` rows — a title naming the row and a sample listing
 * the sections that are active under that hypothetical (`[changes] [rdd] [agents] …`) — and a
 * section registered through the bridge must appear in that same list instead of drawing a card
 * picture of its own. These tests drive the real capture path with host `Sections` rows shaped
 * exactly like the host's own inline closures (`extensions/gentle-shell.ts:3522-3524`, L3) and
 * assert what `preview()` returns to the renderer.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  registerCardStyle,
  registerSection,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
} from "../src/bus.ts";
import {
  disableCaptureBackend,
  installCaptureBackend,
  resetCaptureStateForTests,
} from "../src/capture.ts";
import { resetHookStateForTests } from "../src/hook.ts";
import { resetRowBuildStateForTests } from "../src/rows.ts";
import { installSectionRows } from "../src/sections-rows.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CustomizeRow, InlineHelpers, SidebarSection } from "../src/types.ts";
import { setSectionVisible } from "../src/visibility.ts";
import { createFakeHost } from "./fake-host.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-preview-"));
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
  resetSectionsForTests();
  resetCardStylesForTests();
  resetStoreStateForTests();
  resetCaptureStateForTests();
  resetHookStateForTests();
  resetRowBuildStateForTests();
});

test.afterEach(() => {
  disableCaptureBackend();
});

const section = (id: string, extra: Partial<SidebarSection> = {}): SidebarSection => ({
  id,
  title: id.toUpperCase(),
  lines: () => [`body ${id}`],
  ...extra,
});

const inlineHelpers: InlineHelpers = {
  input: async () => undefined,
  confirm: async () => true,
  capture: async () => undefined,
};

/** The host's persisted section visibility for these tests: one section hidden, two shown. */
const VISIBILITY: Record<string, boolean> = { changes: true, rdd: false, agents: true };

/**
 * The host's own `Sections` rows (`extensions/gentle-shell.ts:3522-3524`): two per key, each with the
 * host's inline preview closure over its own visibility map.
 */
const hostSectionsRows = (visibility: Record<string, boolean>): CustomizeRow[] => {
  const rows: CustomizeRow[] = [];
  for (const key of ["changes", "rdd", "agents"]) {
    for (const shown of [true, false]) {
      const value = shown ? "shown" : "hidden";
      rows.push({
        category: "Sections",
        label: () => key,
        choice: {
          setting: key,
          value,
          current: () => visibility[key] === shown,
          applyOnMove: false,
        },
        preview: () => {
          const hypothetical = { ...visibility, [key]: shown };
          const active = Object.entries(hypothetical)
            .filter(([, on]) => on)
            .map(([name]) => name);
          return {
            title: `Sections · ${key} ${value}`,
            sample: `[${active.join("] [") || "no optional sections"}]`,
          };
        },
        action: () => {},
      });
    }
  }
  return rows;
};

/** The host's own `Card style` rows (`extensions/gentle-shell.ts:3398-3419`). */
const hostCardStyleRows = (): CustomizeRow[] =>
  ["neon", "float"].map((value) => ({
    category: "Cards",
    label: () => value,
    choice: {
      setting: "Card style",
      value,
      current: () => value === "neon",
      applyOnMove: false,
    },
    action: () => {},
  }));

/** One registered style, so the capture splices a value row into the host's `Card style` line. */
const CARD_STYLE = {
  id: "loon.frame",
  label: "frame",
  frame: { top: () => "╭", line: () => "│", bottom: () => "╰" },
};

const rowFor = (
  rows: readonly CustomizeRow[],
  match: (row: CustomizeRow) => boolean,
): CustomizeRow => {
  const found = rows.find(match);
  assert.ok(found !== undefined, "the menu holds the row this test writes about");
  return found;
};

const toggleRow = (rows: readonly CustomizeRow[], setting: string, value: string): CustomizeRow =>
  rowFor(rows, (row) => row.choice?.setting === setting && row.choice.value === value);

test("the host's own Sections row gains the bridge labels and keeps its title", () => {
  registerSection(section("loon.issues", { title: "ISSUES" }));
  registerSection(section("loon.music", { title: "MUSIC" }));
  installSectionRows();
  const host = createFakeHost({ rows: hostSectionsRows(VISIBILITY) });
  installCaptureBackend(host.ui);

  host.buildMenu();

  const rows = host.liveRows();
  const hostRow = toggleRow(rows, "changes", "shown");
  assert.deepEqual(hostRow.preview?.(), {
    title: "Sections · changes shown",
    sample: "[changes] [agents] [issues] [music]",
  });
  assert.deepEqual(
    hostRow.preview?.(),
    hostRow.preview?.(),
    "reading the preview twice never double-appends the bridge's labels",
  );

  assert.deepEqual(toggleRow(rows, "issues", "shown").preview?.(), {
    title: "Sections · issues shown",
    sample: "[changes] [agents] [issues] [music]",
  });
  assert.deepEqual(toggleRow(rows, "issues", "hidden").preview?.(), {
    title: "Sections · issues hidden",
    sample: "[changes] [agents] [music]",
  });
});

test("a hidden bridge section leaves the list, and its own row puts it back", async () => {
  registerSection(section("loon.issues", { title: "ISSUES" }));
  registerSection(section("loon.music", { title: "MUSIC" }));
  installSectionRows();
  const host = createFakeHost({ rows: hostSectionsRows(VISIBILITY) });
  installCaptureBackend(host.ui);
  host.buildMenu();

  const rows = host.liveRows();
  const hideIssues = toggleRow(rows, "issues", "hidden");
  assert.ok(typeof hideIssues.action === "function");
  await hideIssues.action(inlineHelpers);
  assert.deepEqual(
    [toggleRow(rows, "issues", "shown").choice?.current(), toggleRow(rows, "issues", "hidden").choice?.current()],
    [false, true],
    "the press persisted hidden",
  );

  assert.equal(
    toggleRow(rows, "issues", "shown").preview?.().sample,
    "[changes] [agents] [issues] [music]",
    "the focused row previews its OWN hypothetical, on top of the persisted state of the rest",
  );
  assert.equal(
    toggleRow(rows, "issues", "hidden").preview?.().sample,
    "[changes] [agents] [music]",
    "and the hidden hypothetical leaves it out",
  );
  assert.equal(
    toggleRow(rows, "changes", "shown").preview?.().sample,
    "[changes] [agents] [music]",
    "the host's own row follows the persisted state, not a hypothetical",
  );
});

test("a throwing host preview cannot break the menu", () => {
  registerSection(section("loon.issues", { title: "ISSUES" }));
  installSectionRows();
  const rows = hostSectionsRows(VISIBILITY);
  const broken = rows[0];
  assert.ok(broken !== undefined);
  broken.preview = () => {
    throw new Error("host preview exploded");
  };
  const host = createFakeHost({ rows });
  installCaptureBackend(host.ui);

  host.buildMenu();

  const hostRow = toggleRow(host.liveRows(), "changes", "shown");
  const preview = hostRow.preview?.();
  assert.ok(preview !== undefined, "the row still has a preview");
  assert.equal(preview.title, "Sections", "the title it could not read falls back to the category");
  assert.equal(preview.sample, "[issues]", "and the bridge's own list is still previewable");
});

test("a factory that throws leaves the host's own preview functions exactly as they were", () => {
  registerSection(section("loon.issues", { title: "ISSUES" }));
  installSectionRows();
  // A registered style makes the capture splice the host's `Card style` line, and those rows sit
  // BEFORE the `Sections` rows: the patch's indices only survive a rollback taken in reverse order,
  // so without this the two edits could be undone in either order and the test would not notice.
  registerCardStyle(CARD_STYLE);
  const rows = [...hostCardStyleRows(), ...hostSectionsRows(VISIBILITY)];
  const originals = rows.map((row) => row.preview);
  const identities = rows.slice();
  const host = createFakeHost();
  installCaptureBackend(host.ui);

  let duringBuild: CustomizeRow[] = [];
  assert.throws(
    () =>
      host.ui.custom?.((_ui, _theme) => {
        rows.map((row) => row.category ?? "Settings");
        duringBuild = rows.slice();
        throw new Error("factory exploded");
      }),
    /factory exploded/u,
  );

  // The two host rows, the one value row the splice inserts, and the bridge's two toggle rows.
  assert.equal(
    duringBuild.length,
    identities.length + 3,
    "the early injection spliced, patched and appended",
  );
  const firstSectionsRow = 3;
  assert.equal(
    duringBuild[firstSectionsRow]?.choice?.setting,
    "changes",
    "the splice shifted the Sections rows by the one value row this test assumes",
  );
  assert.notEqual(
    duringBuild[firstSectionsRow],
    identities[2],
    "the host's row is patched before the host's own map reads it",
  );
  assert.equal(
    duringBuild[firstSectionsRow]?.preview?.().sample,
    "[changes] [agents] [issues]",
    "and the bridge's label is in its sample during the build",
  );

  assert.equal(rows.length, identities.length, "the appended rows and the spliced value are gone");
  for (let index = 0; index < identities.length; index++) {
    assert.equal(rows[index], identities[index], "the host's own row is back in place");
    assert.equal(rows[index]?.preview, originals[index], "and its own preview is untouched");
  }
});

test("hiding a section through the store removes it from the host's sample", () => {
  registerSection(section("loon.issues", { title: "ISSUES" }));
  installSectionRows();
  const host = createFakeHost({ rows: hostSectionsRows(VISIBILITY) });
  installCaptureBackend(host.ui);
  host.buildMenu();
  assert.equal(
    toggleRow(host.liveRows(), "changes", "shown").preview?.().sample,
    "[changes] [agents] [issues]",
    "the section is in the shared list while it is shown",
  );

  setSectionVisible("loon.issues", false);

  assert.equal(
    toggleRow(host.liveRows(), "changes", "shown").preview?.().sample,
    "[changes] [agents]",
    "a hidden section is out of the list the host's row draws",
  );
});
