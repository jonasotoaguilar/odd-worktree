import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

/**
 * The same containment rule the extension paths are held to: a package-root-relative path that
 * exists, is a file, and cannot escape the package root.
 */
const assertResolvesInsidePackage = (entry: unknown, label: string): void => {
  assert.equal(typeof entry, "string", `${label} must be a string: ${String(entry)}`);
  assert.ok((entry as string).length > 0, `${label} must not be empty`);
  assert.ok(!isAbsolute(entry as string), `${label} must be package-root relative: ${String(entry)}`);
  const resolved = resolve(packageRoot, entry as string);
  const relativeToRoot = relative(packageRoot, resolved);
  assert.ok(
    relativeToRoot.length > 0 && !relativeToRoot.startsWith("..") && !isAbsolute(relativeToRoot),
    `${label} escapes the package root: ${String(entry)}`,
  );
  assert.ok(existsSync(resolved), `${label} does not exist: ${String(entry)} -> ${resolved}`);
  assert.ok(statSync(resolved).isFile(), `${label} is not a file: ${String(entry)} -> ${resolved}`);
};

test("types points at an existing file inside the package", () => {
  assertResolvesInsidePackage(manifest.types, "types");
});

test("exports maps the package root to existing files inside the package", () => {
  const rootExports = manifest.exports?.["."];
  assert.ok(rootExports !== undefined, 'exports must expose the package root as "."');

  if (typeof rootExports === "string") {
    assertResolvesInsidePackage(rootExports, 'exports["."]');
    return;
  }

  assertResolvesInsidePackage(rootExports.types, 'exports["."].types');
  assertResolvesInsidePackage(rootExports.default, 'exports["."].default');
  assert.equal(
    rootExports.types,
    manifest.types,
    "the root export's types target must be the same file as the types field",
  );
});

test("test and typecheck scripts are declared", () => {
  assert.equal(manifest.scripts?.test, "node --test");
  assert.equal(manifest.scripts?.typecheck, "tsc --noEmit");
});

test("the released version and the public VERSION agree", async () => {
  const entry = await import("../src/index.ts");
  assert.equal(typeof manifest.version, "string");
  assert.match(
    manifest.version,
    /^\d+\.\d+\.\d+$/u,
    `the manifest version must be a plain release version, got ${String(manifest.version)}`,
  );
  assert.equal(
    entry.VERSION,
    manifest.version,
    "package.json and src/index.ts must never drift: one of them is what a consumer reads",
  );
});
