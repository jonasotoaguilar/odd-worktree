import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { API_SCHEMA, SHELL_API_KEY, SHELL_READY_EVENT } from "../../lib/shell-api/api.ts";

// Two consumers read the slot by its own spelling instead of importing it: the card resolver is
// plain CommonJS and cannot import a `.ts` file, and the extension stubs that import in its plain-JS
// copy. If `api.ts` moved to another spelling and they did not follow, every card gate would answer
// "no shell API" and cards would silently stop painting, so this pins that they agree.
const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const names = (source: string, literal: string): boolean =>
  source.includes(`"${literal}"`) || source.includes(`'${literal}'`);

test("the card resolver and the extension read the slot the API publishes", () => {
  const slot = Symbol.keyFor(SHELL_API_KEY);
  assert.ok(slot !== undefined, "the slot key is a registered symbol");

  for (const path of ["lib/file-card-resolver.js", "extensions/odd-worktree-tools.ts"]) {
    const source = read(path);
    assert.ok(names(source, slot), `${path} names the slot ${slot}`);
    assert.ok(names(source, API_SCHEMA), `${path} gates on the schema ${API_SCHEMA}`);
  }
  assert.ok(
    names(read("extensions/odd-worktree-tools.ts"), SHELL_READY_EVENT),
    `the extension listens for ${SHELL_READY_EVENT}`,
  );
});
