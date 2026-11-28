// Coexistence with an older copy of the API (an older copy of it still loaded).
// Two regressions the independent verification reproduced:
// 1. the plugin-lines cache is a shared `Symbol.for` slot: an older copy caches `{ kind: "shell-api" }`
//    for a module it owns, and a reader that only knows another kind dereferences `identity` and throws;
// 2. describing a foreign object on the API slot must never throw: it is another plugin's object and
//    its schema/version may be accessors.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { shellApi, isShellApi, publishShellApi } from "../../lib/shell-api/api.ts";
import { registerSection } from "../../lib/shell-api/index.ts";
import { getPluginLineReport } from "../../lib/shell-api/plugin-lines.ts";

test("an attribution an older copy cached does not break a registration here", (t) => {
  getPluginLineReport();
  const { modules } = globalThis[Symbol.for("odd-worktree.plugin-lines.v1")];
  const caller = fileURLToPath(import.meta.url);
  modules.set(caller, { kind: "shell-api" });
  t.after(() => modules.delete(caller));

  const dispose = registerSection({
    id: "verification.legacy-attribution",
    title: "Verification",
    lines: () => ["probe"],
  });
  assert.equal(typeof dispose, "function");
  dispose();
});

test("a rejected foreign slot cannot throw while it is described", (t) => {
  const key = Symbol.for("odd-worktree/shell-api/v1");
  const warned = Symbol.for("odd-worktree/shell-api/v1.warned");
  const previous = globalThis[key];
  const previousWarning = globalThis[warned];
  t.after(() => {
    globalThis[key] = previous;
    if (previousWarning === undefined) delete globalThis[warned];
    else globalThis[warned] = previousWarning;
  });
  delete globalThis[warned];

  const foreign = {
    schema: "third-party/v2",
    get version() {
      throw new Error("verification: unavailable version");
    },
  };
  globalThis[key] = foreign;
  assert.doesNotThrow(() => publishShellApi());
  assert.equal(shellApi(), undefined);
  assert.equal(globalThis[key], foreign, "the foreign object is never replaced");
});

test("the shape gate treats an object whose members throw as not this API", () => {
  const throwing = {
    schema: "odd-worktree/shell-api",
    get version() {
      throw new Error("verification: unreadable version");
    },
  };
  assert.doesNotThrow(() => isShellApi(throwing));
  assert.equal(isShellApi(throwing), false);
});
