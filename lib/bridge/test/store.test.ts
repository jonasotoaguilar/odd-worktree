import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createStore,
  getStoreDiagnostics,
  resetStoreStateForTests,
  STORE_SCHEMA_VERSION,
} from "../src/store.ts";

let configHome: string;
let previousConfigHome: string | undefined;

const bridgeDir = (): string => join(configHome, "gentle-shell-bridge");
const storePath = (pluginId: string): string => join(bridgeDir(), `${pluginId}.json`);

test.beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "gsb-store-"));
  previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
  process.env.GENTLE_PI_CONFIG_HOME = configHome;
  resetStoreStateForTests();
});

test.afterEach(() => {
  if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
  else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
  rmSync(configHome, { recursive: true, force: true });
});

test("round-trips a value through a namespaced file", () => {
  const store = createStore("loon");

  assert.equal(store.get("bannerSource", "activity"), "activity");
  assert.equal(store.path, storePath("loon"));

  store.set("bannerSource", "output");

  assert.equal(store.get("bannerSource", "activity"), "output");
  const document = JSON.parse(readFileSync(storePath("loon"), "utf8"));
  assert.equal(document.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(document.values, { bannerSource: "output" });
});

test("a second store instance reads what the first wrote", () => {
  createStore("loon").set("bannerSource", "output");

  assert.equal(createStore("loon").get("bannerSource", "activity"), "output");
});

test("a missing file reads the caller's default and creates nothing", () => {
  const store = createStore("loon");

  assert.equal(store.get("bannerSource", "activity"), "activity");
  assert.deepEqual(getStoreDiagnostics(), [], "a missing file is not a problem to report");
  assert.equal(existsSync(bridgeDir()), false, "reading must not create the bridge directory");
});

test("malformed JSON reads the default, is reported, and is left untouched", () => {
  mkdirSync(bridgeDir(), { recursive: true });
  writeFileSync(storePath("loon"), "{ not json", "utf8");

  const store = createStore("loon");

  assert.equal(store.get("bannerSource", "activity"), "activity");
  const problems = getStoreDiagnostics();
  assert.equal(problems.length, 1);
  assert.equal(problems[0].pluginId, "loon");
  assert.equal(problems[0].kind, "invalid-json");
  assert.equal(problems[0].path, storePath("loon"));
  assert.equal(
    readFileSync(storePath("loon"), "utf8"),
    "{ not json",
    "the malformed file is neither repaired nor deleted",
  );
});

test("a later set after a malformed file writes a valid document", () => {
  mkdirSync(bridgeDir(), { recursive: true });
  writeFileSync(storePath("loon"), "{ not json", "utf8");
  const store = createStore("loon");

  store.set("bannerSource", "output");

  const document = JSON.parse(readFileSync(storePath("loon"), "utf8"));
  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(document.values, { bannerSource: "output" });
  assert.equal(store.get("bannerSource", "activity"), "output");
  assert.deepEqual(getStoreDiagnostics(), [], "a valid write clears that plugin's problem");
});

test("a document that is not an object reads the default and is reported", () => {
  mkdirSync(bridgeDir(), { recursive: true });
  writeFileSync(storePath("loon"), "[1,2,3]", "utf8");

  const store = createStore("loon");

  assert.equal(store.get("bannerSource", "activity"), "activity");
  assert.equal(getStoreDiagnostics()[0]?.kind, "not-an-object");
});

test("an unknown schemaVersion reads the default and is reported", () => {
  mkdirSync(bridgeDir(), { recursive: true });
  writeFileSync(
    storePath("loon"),
    JSON.stringify({ schemaVersion: 99, values: { keep: "me" }, extraTopLevel: true }),
    "utf8",
  );

  const store = createStore("loon");

  assert.equal(store.get("bannerSource", "activity"), "activity");
  assert.equal(getStoreDiagnostics()[0]?.kind, "unsupported-schema-version");
});

test("a later set after an unknown schemaVersion writes only the caller's keys and reports the discarded payload", () => {
  mkdirSync(bridgeDir(), { recursive: true });
  writeFileSync(
    storePath("loon"),
    JSON.stringify({ schemaVersion: 99, values: { keep: "me" }, extraTopLevel: true }),
    "utf8",
  );
  const store = createStore("loon");

  store.set("added", 1);

  const document = JSON.parse(readFileSync(storePath("loon"), "utf8"));
  assert.equal(document.schemaVersion, 1);
  assert.deepEqual(
    document.values,
    { added: 1 },
    "a future schema's payload is never re-labelled as schema 1",
  );
  assert.equal(
    "extraTopLevel" in document,
    false,
    "keys the bridge does not understand are not carried into the valid document",
  );
  const problem = getStoreDiagnostics()[0];
  assert.equal(problem?.kind, "unsupported-schema-version");
  assert.match(problem?.message ?? "", /discarded/);
});

test("writes are atomic: the temp file is gone and the target parses completely", () => {
  const store = createStore("loon");

  for (let index = 0; index < 5; index += 1) {
    store.set("counter", index);
    assert.deepEqual(readdirSync(bridgeDir()), ["loon.json"], `no temp file after write ${index}`);
    assert.equal(JSON.parse(readFileSync(storePath("loon"), "utf8")).values.counter, index);
  }
});

test("two plugin ids never touch each other's file", () => {
  const loon = createStore("loon");
  const card = createStore("cards");

  loon.set("bannerSource", "output");
  card.set("style", "rounded");

  assert.deepEqual(readdirSync(bridgeDir()).sort(), ["cards.json", "loon.json"]);
  assert.equal(loon.get("style", "none"), "none");
  assert.equal(card.get("bannerSource", "none"), "none");
  assert.equal(loon.get("bannerSource", "activity"), "output");
  assert.equal(card.get("style", "plain"), "rounded");
});

test("invalid plugin ids are rejected before any filesystem access", () => {
  const invalidIds = ["", ".", "..", "../escape", "a/b", "a\\b", "nested/../escape", "loon..v2"];

  for (const pluginId of invalidIds) {
    assert.throws(
      () => createStore(pluginId),
      /invalid plugin id/,
      `plugin id ${JSON.stringify(pluginId)} must be rejected`,
    );
  }

  assert.equal(existsSync(bridgeDir()), false, "rejection happens before the directory is created");
  assert.equal(existsSync(join(configHome, "escape.json")), false, "nothing escaped the bridge dir");
});
