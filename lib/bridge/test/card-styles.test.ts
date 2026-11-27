/**
 * The card-style registry, its process-global snapshot, and the bridge-owned selection (S1, S2, S12).
 *
 * A style is a registration like a provider or a section: one id, replace-in-place, an exact
 * disposer, and a fresh ordered snapshot. The selection is the bridge's own state, `native` by
 * default, and it must be resolvable to "no such style" WITHOUT throwing even after the style that
 * owned it was disposed (S12) — the transformer degrades from that answer, it never guesses.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { publishBridgeApi } from "../src/api.ts";
import {
  registerCardStyle,
  resetBusForTests,
  resetCardStylesForTests,
  resetSectionsForTests,
  snapshotCardStyles,
} from "../src/bus.ts";
import { CARD_STYLE_NATIVE } from "../src/card-style-line.ts";
import {
  CARD_STYLE_STORE_ID,
  getCardStyleSelection,
  resolveCardStyleSelection,
  setCardStyleSelection,
} from "../src/card-styles.ts";
import { resetStoreStateForTests } from "../src/store.ts";
import type { CardStyleRegistration } from "../src/types.ts";

let configHome: string;
let previousConfigHome: string | undefined;

test.before(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-card-styles-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
});

test.after(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  // The selection is a real file: every test starts from nothing on disk.
  rmSync(join(configHome, "gentle-shell-bridge"), { recursive: true, force: true });
  resetBusForTests();
  resetSectionsForTests();
  resetCardStylesForTests();
  resetStoreStateForTests();
});

const frame = () => ({
  top: (ctx: { width: number }) => "─".repeat(ctx.width),
  line: (ctx: { text: string }) => ctx.text,
  bottom: (ctx: { width: number }) => "─".repeat(ctx.width),
});

const style = (id: string, extra: Partial<CardStyleRegistration> = {}): CardStyleRegistration => ({
  id,
  label: id,
  frame: frame(),
  ...extra,
});

const ids = (): string[] => snapshotCardStyles().map((registered) => registered.id);

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

test("a registered style appears in the snapshot in registration order", () => {
  registerCardStyle(style("loon.cute"));
  registerCardStyle(style("loon.mono"));

  assert.deepEqual(ids(), ["loon.cute", "loon.mono"]);
});

test("a style may declare an order: ordered styles first, ascending, then the rest by registration", () => {
  registerCardStyle(style("late"));
  registerCardStyle(style("second", { order: 2 }));
  registerCardStyle(style("first", { order: 1 }));
  registerCardStyle(style("third", { order: 3 }));

  assert.deepEqual(ids(), ["first", "second", "third", "late"]);
});

test("the same id replaces in place: one entry, its position and neighbours kept", () => {
  registerCardStyle(style("a"));
  registerCardStyle(style("b", { label: "old" }));
  registerCardStyle(style("c"));

  const replacement = style("b", { label: "new" });
  registerCardStyle(replacement);

  assert.deepEqual(ids(), ["a", "b", "c"]);
  assert.equal(snapshotCardStyles()[1], replacement, "the later registration is the live one");
});

test("the disposer removes exactly its own registration, once", () => {
  registerCardStyle(style("a"));
  const disposeB = registerCardStyle(style("b"));
  registerCardStyle(style("c"));

  disposeB();
  disposeB();

  assert.deepEqual(ids(), ["a", "c"]);
});

test("after a same-id replacement the replaced registration's disposer is a no-op", () => {
  const disposeOld = registerCardStyle(style("a"));
  const replacement = style("a", { label: "new" });
  registerCardStyle(replacement);

  disposeOld();

  assert.equal(snapshotCardStyles().length, 1);
  assert.equal(snapshotCardStyles()[0], replacement);
});

test("the snapshot is a fresh copy, so a caller cannot mutate the registry", () => {
  registerCardStyle(style("a"));

  const snapshot = snapshotCardStyles() as CardStyleRegistration[];
  snapshot.push(style("b"));
  snapshot.length = 0;

  assert.deepEqual(ids(), ["a"]);
});

test("an id that cannot be a plain object key is rejected before anything is stored", () => {
  const rejected: unknown[] = ["", "   ", "__proto__", "constructor", "prototype", 42, null, undefined, "nu\0l"];

  for (const id of rejected) {
    assert.throws(
      () => registerCardStyle(style(id as string)),
      /invalid card style id/u,
      `must reject ${JSON.stringify(id)}`,
    );
  }
  assert.deepEqual(snapshotCardStyles(), [], "a rejected style never half-registers");
});

test("an id the bridge or the host already owns is rejected", () => {
  for (const id of [CARD_STYLE_NATIVE, "neon", "float"]) {
    assert.throws(() => registerCardStyle(style(id)), /invalid card style id/u, `must reject ${id}`);
  }
  assert.deepEqual(snapshotCardStyles(), []);
});

test("the three frame functions are required", () => {
  for (const broken of [
    { ...style("a"), frame: undefined },
    { ...style("a"), frame: {} },
    { ...style("a"), frame: { ...frame(), top: "nope" } },
    { ...style("a"), frame: { ...frame(), line: undefined } },
    { ...style("a"), frame: { ...frame(), bottom: 7 } },
  ]) {
    assert.throws(() => registerCardStyle(broken as CardStyleRegistration), /frame/u);
  }
  assert.deepEqual(snapshotCardStyles(), []);
});

test("a label is required, because it is what the user reads on the line", () => {
  for (const label of ["", "  ", 42, undefined]) {
    assert.throws(
      () => registerCardStyle({ ...style("a"), label } as unknown as CardStyleRegistration),
      /label/u,
    );
  }
  assert.deepEqual(snapshotCardStyles(), []);
});

test("a label that another style already shows is rejected (S13)", () => {
  registerCardStyle(style("loon.cute", { label: "cute" }));

  assert.throws(
    () => registerCardStyle(style("pix.cute", { label: "cute" })),
    /invalid card style label "cute"/u,
    "two values reading the same is ambiguous on the line",
  );
  assert.deepEqual(ids(), ["loon.cute"], "the rejected style never half-registered");
});

test("labels are compared case-sensitively, exactly as the host displays them (S13)", () => {
  registerCardStyle(style("loon.cute", { label: "cute" }));

  assert.doesNotThrow(
    () => registerCardStyle(style("pix.cute", { label: "Cute" })),
    "a different casing is a different string on the line, so it is allowed",
  );
  assert.deepEqual(ids(), ["loon.cute", "pix.cute"]);
});

test("a label equal to one of the host's own values is rejected (S13)", () => {
  for (const label of ["neon", "float"]) {
    assert.throws(
      () => registerCardStyle(style("loon.shadow", { label })),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(`invalid card style label "${label}" for "loon.shadow"`),
      `a value reading ${label} is indistinguishable from the host's`,
    );
  }
  assert.deepEqual(snapshotCardStyles(), []);
});

test("re-registering the same id may keep its own label (S13)", () => {
  registerCardStyle(style("loon.cute", { label: "cute" }));
  const replacement = style("loon.cute", { label: "cute", order: 5 });

  assert.doesNotThrow(() => registerCardStyle(replacement));

  assert.equal(snapshotCardStyles()[0], replacement);
});

test("two loaded copies of the package share one registry and one order", async () => {
  registerCardStyle(style("first", { order: 1 }));

  const copyPath = new URL("../src/bus.ts?second-copy", import.meta.url).href;
  const second = (await import(copyPath)) as typeof import("../src/bus.ts");
  second.registerCardStyle(style("second", { order: 2 }));

  assert.deepEqual(ids(), ["first", "second"], "the first copy sees the second copy's style");
  assert.deepEqual(
    second.snapshotCardStyles().map((registered: CardStyleRegistration) => registered.id),
    ["first", "second"],
    "and the second copy sees the same order",
  );
});

// ---------------------------------------------------------------------------------------------
// The bridge-owned selection
// ---------------------------------------------------------------------------------------------

test("the selection is native before anything is stored", () => {
  assert.equal(getCardStyleSelection(), CARD_STYLE_NATIVE);
  assert.deepEqual(resolveCardStyleSelection(), { kind: "native" });
});

test("a selection round-trips through the bridge's own file", () => {
  registerCardStyle(style("loon.cute"));

  setCardStyleSelection("loon.cute");

  assert.equal(getCardStyleSelection(), "loon.cute");
  const file = join(configHome, "gentle-shell-bridge", `${CARD_STYLE_STORE_ID}.json`);
  assert.ok(existsSync(file), "the bridge owns the file, not the host");
  const document = JSON.parse(readFileSync(file, "utf8")) as { schemaVersion: number; values: Record<string, unknown> };
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.values.cardStyle, "loon.cute");
  assert.deepEqual(readdirSync(join(configHome, "gentle-shell-bridge")), [`${CARD_STYLE_STORE_ID}.json`]);
});

test("a stored selection resolves to the registered style by identity", () => {
  const registered = style("loon.cute", { label: "cute" });
  registerCardStyle(registered);
  setCardStyleSelection("loon.cute");

  const resolved = resolveCardStyleSelection();
  assert.equal(resolved.kind, "style");
  assert.equal(resolved.kind === "style" ? resolved.style : undefined, registered);
});

test("a selection whose style is gone resolves to missing without throwing (S12)", () => {
  const dispose = registerCardStyle(style("loon.cute"));
  setCardStyleSelection("loon.cute");
  dispose();

  assert.deepEqual(resolveCardStyleSelection(), { kind: "missing", id: "loon.cute" });
  assert.equal(getCardStyleSelection(), "loon.cute", "the stored value is not rewritten behind the user");
});

test("a selection nobody ever registered resolves to missing, not to native", () => {
  setCardStyleSelection("loon.never");

  assert.deepEqual(resolveCardStyleSelection(), { kind: "missing", id: "loon.never" });
});

test("a hand-edited file that is not a string falls back to native", () => {
  const directory = join(configHome, "gentle-shell-bridge");
  const file = join(directory, `${CARD_STYLE_STORE_ID}.json`);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, values: { cardStyle: 7 } }), "utf8");

  assert.equal(getCardStyleSelection(), CARD_STYLE_NATIVE);
  assert.deepEqual(resolveCardStyleSelection(), { kind: "native" });
});

// ---------------------------------------------------------------------------------------------
// The published surface
// ---------------------------------------------------------------------------------------------

test("registerCardStyle is on the API object plugins receive", () => {
  const api = publishBridgeApi();
  const register = api.registerCardStyle;

  assert.equal(typeof register, "function", "the member is present, so a plugin may call it");
  const dispose = register?.(style("loon.cute"));

  assert.deepEqual(ids(), ["loon.cute"]);
  dispose?.();
  assert.deepEqual(snapshotCardStyles(), []);
});

test("registerCardStyle is exported from the package entry point", async () => {
  const entry = await import("../src/index.ts");
  assert.equal(entry.registerCardStyle, registerCardStyle);
});
