import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";

import {
  getBridgeConfigHome,
  getConfigHome,
  resolveBridgeConfigHome,
  resolveConfigHome,
} from "../src/config.ts";

const HOME = "/home/tester";
const CWD = "/work/repo";

test("GENTLE_PI_CONFIG_HOME set is used verbatim", () => {
  assert.equal(
    resolveConfigHome({ env: { GENTLE_PI_CONFIG_HOME: "/srv/gentle" }, homeDir: HOME, cwd: CWD }),
    "/srv/gentle",
  );
});

test("unset GENTLE_PI_CONFIG_HOME falls back to <home>/.pi/gentle-ai", () => {
  assert.equal(resolveConfigHome({ env: {}, homeDir: HOME, cwd: CWD }), `${HOME}/.pi/gentle-ai`);
});

test("empty GENTLE_PI_CONFIG_HOME falls back to the default", () => {
  assert.equal(
    resolveConfigHome({ env: { GENTLE_PI_CONFIG_HOME: "" }, homeDir: HOME, cwd: CWD }),
    `${HOME}/.pi/gentle-ai`,
  );
});

test('"~" and "~/..." are expanded against the supplied home directory', () => {
  assert.equal(
    resolveConfigHome({ env: { GENTLE_PI_CONFIG_HOME: "~" }, homeDir: HOME, cwd: CWD }),
    HOME,
  );
  assert.equal(
    resolveConfigHome({ env: { GENTLE_PI_CONFIG_HOME: "~/cfg/gentle" }, homeDir: HOME, cwd: CWD }),
    `${HOME}/cfg/gentle`,
  );
});

test('only a bare "~" or a leading "~/" is tilde-expanded', () => {
  // "~name" is another user's home; we do not invent a lookup, so the value stays literal and
  // then falls into the relative-path rule below.
  assert.equal(
    resolveConfigHome({ env: { GENTLE_PI_CONFIG_HOME: "~weird/cfg" }, homeDir: HOME, cwd: CWD }),
    `${CWD}/~weird/cfg`,
  );
});

test("a relative override is resolved to an absolute path against cwd", () => {
  assert.equal(
    resolveConfigHome({ env: { GENTLE_PI_CONFIG_HOME: "cfg/gentle" }, homeDir: HOME, cwd: CWD }),
    `${CWD}/cfg/gentle`,
  );
});

test("redundant separators and dot segments are normalized", () => {
  assert.equal(
    resolveConfigHome({
      env: { GENTLE_PI_CONFIG_HOME: "/srv/./gentle//../gentle/" },
      homeDir: HOME,
      cwd: CWD,
    }),
    "/srv/gentle",
  );
});

test("the bridge directory is <config home>/gentle-shell-bridge", () => {
  assert.equal(resolveBridgeConfigHome("/srv/gentle"), "/srv/gentle/gentle-shell-bridge");
  assert.equal(
    resolveBridgeConfigHome("/srv/gentle/"),
    "/srv/gentle/gentle-shell-bridge",
    "a trailing separator must not produce a doubled separator",
  );
});

test("getConfigHome reads the process environment; getBridgeConfigHome appends the bridge dir", () => {
  const restore = process.env.GENTLE_PI_CONFIG_HOME;
  try {
    process.env.GENTLE_PI_CONFIG_HOME = "/srv/from-env";
    assert.equal(getConfigHome(), "/srv/from-env");
    assert.equal(getBridgeConfigHome(), "/srv/from-env/gentle-shell-bridge");
    delete process.env.GENTLE_PI_CONFIG_HOME;
    assert.equal(getConfigHome(), `${homedir()}/.pi/gentle-ai`);
    assert.equal(getBridgeConfigHome(), `${homedir()}/.pi/gentle-ai/gentle-shell-bridge`);
  } finally {
    if (restore === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
    else process.env.GENTLE_PI_CONFIG_HOME = restore;
  }
});
