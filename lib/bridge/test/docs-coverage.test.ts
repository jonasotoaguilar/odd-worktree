import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

/** The markdown a plugin author is expected to read before their first registration. */
const DOC_FILES = ["README.md", "PRD.md", "docs/contract.md", "docs/architecture.md", "docs/state.md"];

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

/** npm `files` semantics for the shapes this manifest uses: exact files and directory prefixes. */
const isShipped = (path: string): boolean =>
  (manifest.files as string[]).some((entry) => {
    const bare = entry.replace(/^\.\//, "").replace(/\/$/, "");
    return path === bare || path.startsWith(`${bare}/`);
  });

test("AGENTS.md indexes every project skill and every link in it resolves", () => {
  const path = "AGENTS.md";
  assert.ok(
    existsSync(resolve(packageRoot, path)),
    "AGENTS.md must tell an agent which skill and which document governs the work",
  );
  const text = readFileSync(resolve(packageRoot, path), "utf8");

  const dirs = readdirSync(resolve(packageRoot, "skills"), { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort();

  for (const dir of dirs) {
    assert.ok(
      text.includes(`skills/${dir}/SKILL.md`),
      `AGENTS.md does not index skills/${dir}/SKILL.md`,
    );
  }

  // A row for a skill that no longer exists sends an agent to a path it cannot read.
  const indexed = [...text.matchAll(/skills\/([^/`)\]]+)\/SKILL\.md/g)].map((match) => match[1]);
  for (const name of new Set(indexed)) {
    assert.ok(dirs.includes(name), `AGENTS.md indexes a skill that does not exist: ${name}`);
  }

  for (const { target, line } of localTargets(path)) {
    assert.ok(
      existsSync(resolve(packageRoot, dirname(path), target)),
      `${path}:${line} links a path that does not exist: ${target}`,
    );
  }
});

/** Every shipped skill document, the same files the skill test below walks. */
const skillDocs = (): string[] => {
  const skillsRoot = resolve(packageRoot, "skills");
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => `skills/${dirent.name}/SKILL.md`)
    .filter((path) => existsSync(resolve(packageRoot, path)));
};

test("every path in files resolves to an existing file or directory", () => {
  for (const entry of manifest.files as string[]) {
    const resolved = resolve(packageRoot, entry);
    assert.ok(
      existsSync(resolved),
      `files entry does not exist: ${entry} -> ${resolved}`,
    );
    assert.ok(
      !entry.includes(".."),
      `files entry must not escape the package root: ${entry}`,
    );
  }
});

test("every documented file ships in the published tarball", () => {
  for (const file of DOC_FILES) {
    assert.ok(existsSync(resolve(packageRoot, file)), `documented file is missing: ${file}`);
    assert.ok(
      isShipped(file),
      `${file} is linked from the docs but not shipped: add it to package.json "files"`,
    );
  }
});

test("every local link in the docs resolves and ships", () => {
  for (const file of DOC_FILES) {
    for (const { target, line } of localTargets(file)) {
      const resolved = resolve(packageRoot, dirname(file), target);
      const path = relative(packageRoot, resolved).split(sep).join("/");
      assert.ok(
        !path.startsWith(".."),
        `${file}:${line} links outside the package: ${target}`,
      );
      assert.ok(
        existsSync(resolved),
        `${file}:${line} links a path that does not exist: ${target}`,
      );
      assert.ok(
        isShipped(path),
        `${file}:${line} links ${path}, which the published tarball does not ship`,
      );
    }
  }
});

test("every fenced block in the docs is closed by a bare fence", () => {
  // CommonMark: a closing fence may be followed only by spaces. `​```text` opens a block instead of
  // closing one, so a doc that closes every block that way renders as one code block from the first
  // fence onward — which is what docs/contract.md did before this test existed.
  for (const file of [...DOC_FILES, ...skillDocs()]) {
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

test("every project skill ships, with valid frontmatter and the style-guide section order", () => {
  const skillsRoot = resolve(packageRoot, "skills");
  assert.ok(existsSync(skillsRoot), "the package must ship a skills/ directory");

  const dirs = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort();
  assert.ok(dirs.length > 0, "skills/ must hold at least one skill");

  const SECTIONS = [
    "## Activation Contract",
    "## Hard Rules",
    "## Decision Gates",
    "## Execution Steps",
    "## Output Contract",
    "## References",
  ];

  for (const dir of dirs) {
    const path = `skills/${dir}/SKILL.md`;
    assert.ok(existsSync(resolve(packageRoot, path)), `${dir}/ must hold a SKILL.md`);
    assert.ok(
      isShipped(path),
      `${path} is not shipped: add skills/ to package.json "files" and "pi.skills"`,
    );

    const text = readFileSync(resolve(packageRoot, path), "utf8");
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter, `${path} must open with YAML frontmatter`);
    const fields = frontmatter[1];
    assert.equal(
      fields.match(/^name: (.*)$/m)?.[1],
      dir,
      `${path}: frontmatter name must match the directory name`,
    );
    const description = fields.match(/^description: (.*)$/m)?.[1] ?? "";
    assert.match(
      description,
      /^".*"$/,
      `${path}: description must be one quoted physical line`,
    );
    assert.match(description, /Trigger:/, `${path}: description must open with "Trigger:"`);
    assert.match(fields, /^license: /m, `${path}: frontmatter must declare a license`);

    let cursor = 0;
    for (const section of SECTIONS) {
      const at = text.indexOf(section, cursor);
      assert.ok(at >= 0, `${path}: missing "${section}" in the style-guide order`);
      cursor = at + section.length;
    }

    // Style guide: target 180-450 tokens, hard max 1000. A word is a cheap stand-in for a token.
    const words = text.trim().split(/\s+/).length;
    assert.ok(words <= 1000, `${path}: ${words} words exceeds the hard budget of 1000`);
  }
});

test("the manifest loads the shipped skills", () => {
  const skills = manifest.pi?.skills;
  assert.ok(Array.isArray(skills) && skills.length > 0, "pi.skills must declare the skills root");
  for (const entry of skills as string[]) {
    const resolved = resolve(packageRoot, entry);
    assert.ok(existsSync(resolved), `pi.skills entry does not resolve: ${entry}`);
    assert.ok(statSync(resolved).isDirectory(), `pi.skills entry must be a directory: ${entry}`);
  }
});
