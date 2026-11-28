import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";

import {
  getShellApiConfigHome,
  getConfigHome,
  resolveShellApiConfigHome,
  resolveConfigHome,
  LEGACY_PERSISTENCE_DIR_NAME,
} from "../../lib/shell-api/config.ts";
import { LEGACY_CARD_STYLE_STORE_ID } from "../../lib/shell-api/card-styles.ts";
import { LEGACY_MESSAGE_DESIGN_STORE_ID } from "../../lib/shell-api/message-designs.ts";
import { LEGACY_TOOL_DESIGN_STORE_ID } from "../../lib/shell-api/tool-designs.ts";
import { LEGACY_SECTIONS_STORE_ID } from "../../lib/shell-api/visibility.ts";

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

test("the shell API directory is <config home>/gentle-shell-bridge", () => {
  assert.equal(resolveShellApiConfigHome("/srv/gentle"), "/srv/gentle/gentle-shell-bridge");
  assert.equal(
    resolveShellApiConfigHome("/srv/gentle/"),
    "/srv/gentle/gentle-shell-bridge",
    "a trailing separator must not produce a doubled separator",
  );
});

test("getConfigHome reads the process environment; getShellApiConfigHome appends the shell API dir", () => {
  const restore = process.env.GENTLE_PI_CONFIG_HOME;
  try {
    process.env.GENTLE_PI_CONFIG_HOME = "/srv/from-env";
    assert.equal(getConfigHome(), "/srv/from-env");
    assert.equal(getShellApiConfigHome(), "/srv/from-env/gentle-shell-bridge");
    delete process.env.GENTLE_PI_CONFIG_HOME;
    assert.equal(getConfigHome(), `${homedir()}/.pi/gentle-ai`);
    assert.equal(getShellApiConfigHome(), `${homedir()}/.pi/gentle-ai/gentle-shell-bridge`);
  } finally {
    if (restore === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
    else process.env.GENTLE_PI_CONFIG_HOME = restore;
  }
});

// The names below are spelled out on purpose: they are where saved choices already live on disk, so
// they are written as literals and not read from the constants, which would follow a rename.
test("the persistence directory and the four store ids keep the names saved choices live under", () => {
  assert.equal(LEGACY_PERSISTENCE_DIR_NAME, "gentle-shell-bridge");
  assert.equal(LEGACY_CARD_STYLE_STORE_ID, "bridge-card-style");
  assert.equal(LEGACY_MESSAGE_DESIGN_STORE_ID, "bridge-message-designs");
  assert.equal(LEGACY_TOOL_DESIGN_STORE_ID, "bridge-tool-designs");
  assert.equal(LEGACY_SECTIONS_STORE_ID, "bridge-sections");
});
