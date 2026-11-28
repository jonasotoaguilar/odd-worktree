import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The shell API is odd-worktree's own code: there is no nested package manifest any more (T5), so
// what is left to hold here is the ONE manifest Pi reads — this package's root `package.json`.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

test("keywords contains pi-package", () => {
  assert.ok(Array.isArray(manifest.keywords), "keywords must be an array");
  assert.ok(
    manifest.keywords.includes("pi-package"),
    `keywords must contain "pi-package", got ${JSON.stringify(manifest.keywords)}`,
  );
});

test("pi.extensions is a non-empty array of package-root-relative paths", () => {
  const extensions = manifest.pi?.extensions;
  assert.ok(Array.isArray(extensions), "pi.extensions must be an array");
  assert.ok(extensions.length > 0, "pi.extensions must not be empty");
  for (const entry of extensions) {
    assert.equal(typeof entry, "string", `pi.extensions entry must be a string: ${entry}`);
    assert.ok(entry.length > 0, "pi.extensions entry must not be empty");
    assert.ok(!isAbsolute(entry), `pi.extensions entry must be package-root relative: ${entry}`);
  }
});

test("every declared extension path resolves to an existing file inside the package", () => {
  for (const entry of manifest.pi.extensions) {
    const resolved = resolve(packageRoot, entry);
    const relativeToRoot = relative(packageRoot, resolved);
    assert.ok(
      relativeToRoot.length > 0 &&
        !relativeToRoot.startsWith("..") &&
        !isAbsolute(relativeToRoot),
      `extension path escapes the package root: ${entry}`,
    );
    assert.ok(existsSync(resolved), `extension path does not exist: ${entry} -> ${resolved}`);
    assert.ok(
      statSync(resolved).isFile(),
      `extension path is not a file: ${entry} -> ${resolved}`,
    );
  }
});
