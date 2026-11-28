import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The shell API is odd-worktree's own code, so its docs live in this repository's `docs/shell-api/`
// (T5 flattened `lib/bridge/docs/` into it). The package root stays the one this suite runs in.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The markdown a plugin author is expected to read before their first registration. */
const DOC_FILES = [
  "docs/shell-api/README.md",
  "docs/shell-api/contract.md",
  "docs/shell-api/architecture.md",
  "docs/shell-api/state.md",
];

/** Every `[text](target)` target in one markdown file, excluding anchors and absolute URLs. */
const localTargets = (file: string): { target: string; line: number }[] => {
  const text = readFileSync(resolve(packageRoot, file), "utf8");
  const targets: { target: string; line: number }[] = [];
  text.split("\n").forEach((line, index) => {
    const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
    for (const match of line.matchAll(pattern)) {
      const target = match[1];
      if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#")) {
        continue;
      }
      targets.push({ target: target.split("#")[0], line: index + 1 });
    }
  });
  return targets;
};

test("the shell API's documented files exist in the repository", () => {
  for (const file of DOC_FILES) {
    assert.ok(existsSync(resolve(packageRoot, file)), `documented file is missing: ${file}`);
  }
});

test("every local link in the shell API's docs resolves", () => {
  for (const file of DOC_FILES) {
    for (const { target, line } of localTargets(file)) {
      const resolved = resolve(packageRoot, dirname(file), target);
      assert.ok(
        existsSync(resolved),
        `${file}:${line} links a path that does not exist: ${target}`,
      );
    }
  }
});

test("every fenced block in the shell API's docs is closed by a bare fence", () => {
  // CommonMark: a closing fence may be followed only by spaces. `​```text` opens a block instead of
  // closing one, so a doc that closes every block that way renders as one code block from the first
  // fence onward — which is what the contract did before this test existed.
  for (const file of DOC_FILES) {
    const lines = readFileSync(resolve(packageRoot, file), "utf8").split("\n");
    let openAt: number | undefined;
    lines.forEach((line, index) => {
      if (!line.startsWith("```")) return;
      if (openAt === undefined) {
        openAt = index + 1;
        return;
      }
      if (line.trim() === "```") {
        openAt = undefined;
        return;
      }
      assert.fail(
        `${file}:${index + 1} opens a nested block instead of closing the one opened at ${openAt}: ` +
          `a closing fence carries no info string`,
      );
    });
    assert.equal(
      openAt,
      undefined,
      `${file}:${String(openAt)} opens a code block the file never closes`,
    );
  }
});
