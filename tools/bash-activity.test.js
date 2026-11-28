'use strict';
// S2 / S3 / S4 (T2): the bash ACTIVITY classifier — which named family one `bash`
// call belongs to, and the quote-aware segmenter every family is decided with.
//
// The rules are the user's own gentle-shell branch (`cards-bash-v2`,
// `lib/odd-phase-inference.ts` and `tests/odd-phase-inference.test.ts`, read
// read-only): the eight families this classifier names, their marks and theme roles,
// the segmenter, and the reference's conservatism. What this suite pins is the shell
// classification ONLY — the reference's ODD *phase* inference (what phase a tool
// implies) is out of scope here, so no case reads a phase label.
//
// The classifier's whole value is that it never guesses: an unknown program, an
// ambiguous composition, a command hidden in a substitution the segmenter cannot
// follow, or a redirect the call would write, all answer `undefined` and the card
// stays generic. That conservatism is what most of this suite states.
//
// Public surface only: `SHELL_ACTIVITIES`, `SHELL_ACTIVITY_IDENTITY`,
// `shellCommandSegments`, `inferBashActivity`, `isCodegraphCommand`. Nothing here
// reads module internals, spawns a process, reaches the network or touches a file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
	SHELL_ACTIVITIES,
	SHELL_ACTIVITY_IDENTITY,
	inferBashActivity,
	isCodegraphCommand,
	shellCommandSegments,
} = require('../lib/bash-activity.js');
const { codegraphCallFromCommand } = require('../lib/codegraph-card-preview.js');

// The host TUI is a peer dependency this package does not install, so the width
// assertion below is the only one that needs it: it runs where the host is present
// and states the mark's own counted column, exactly as the reference does.
let visibleWidth;
try {
	({ visibleWidth } = require('@earendil-works/pi-tui'));
} catch {
	visibleWidth = undefined;
}

// ---- the vocabulary ----

// A card names one identity per activity, so the vocabulary is a closed list: an
// activity without a mark and a theme role could not be drawn, and one the table
// forgot would silently fall back to the generic card. The order is the reference's
// precedence order, and `destructive` heads it: a deletion is the one consequence a
// reader cannot undo, so it outranks every identity beside it.
test('the activity vocabulary is the named families, in the reference order', () => {
	assert.deepEqual([...SHELL_ACTIVITIES], [
		'destructive',
		'checking',
		'formatting',
		'preparing',
		'publishing',
		'versioning',
		'codegraph',
		'exploring',
	]);
	assert.deepEqual(Object.keys(SHELL_ACTIVITY_IDENTITY).sort(), [...SHELL_ACTIVITIES].sort());
});

// The roles are the theme's own slots, never a palette: a light theme, a neon theme
// or a design pack repaints the heading with everything else. The mark is what
// tells two identities apart in one slot — `preparing` and `formatting` share the
// code palette, so their word and their mark are all the reader has.
test('every activity wears its own mark and a theme role', () => {
	assert.deepEqual(SHELL_ACTIVITY_IDENTITY, {
		// The one family whose warning a reader must see before expanding the row.
		destructive: { glyph: '⚠', titleRole: 'error' },
		checking: { glyph: '✓', titleRole: 'mdHeading' },
		formatting: { glyph: '≋', titleRole: 'syntaxFunction' },
		// U+2692 is painted two cells wide by an emoji-fallback font while the host
		// counts it as one, and that font eats the space right after it: two gaps are
		// what leaves one VISIBLE column (`⚒  preparing`) while the counted width still
		// matches what the terminal paints.
		preparing: { glyph: '⚒  ', titleRole: 'syntaxFunction' },
		publishing: { glyph: '↑', titleRole: 'success' },
		versioning: { glyph: '⎇', titleRole: 'warning' },
		// The native tool's own mark, so the shell call and the tool read as one card.
		codegraph: { glyph: '\u{F01BC}', titleRole: 'mdCode' },
		exploring: { glyph: '⌕', titleRole: 'mdLink' },
	});
	const marks = SHELL_ACTIVITIES.map((activity) => SHELL_ACTIVITY_IDENTITY[activity].glyph);
	assert.equal(new Set(marks.map((mark) => mark.trim())).size, marks.length, 'no two activities share a mark');
	// No role is a colour this package invented: every one names a slot of the host's
	// theme, so nothing here writes a hex value, a palette entry or an escape.
	const roles = new Set(['mdHeading', 'mdLink', 'mdCode', 'success', 'warning', 'syntaxFunction', 'error']);
	for (const activity of SHELL_ACTIVITIES) {
		const { glyph, titleRole } = SHELL_ACTIVITY_IDENTITY[activity];
		assert.ok(roles.has(titleRole), `${activity}: ${titleRole} is a theme slot`);
		assert.equal(/\u001b|#[0-9a-fA-F]{3,8}\b/.test(glyph), false, `${activity}: the mark is plain text`);
	}
});

// A heading's width is the host's own count, so a mark must cost exactly one column
// — plus the declared gap `preparing` keeps for the font that paints it wide. The
// statement is made twice: once in code points, so it holds with no host installed,
// and once through the host's own measurement, which is the number that wraps.
test('a mark costs one counted column, plus preparing\'s declared gap', () => {
	for (const activity of SHELL_ACTIVITIES) {
		const { glyph } = SHELL_ACTIVITY_IDENTITY[activity];
		assert.equal([...glyph].length, activity === 'preparing' ? 3 : 1, `${activity}: one mark, plus its own gaps`);
		assert.equal(glyph.trimStart(), glyph, `${activity}: a mark never starts with its gap`);
	}
});

test('the host measures every mark at the width the heading assumes', { skip: visibleWidth ? false : 'requires @earendil-works/pi-tui' }, () => {
	for (const activity of SHELL_ACTIVITIES) {
		const { glyph } = SHELL_ACTIVITY_IDENTITY[activity];
		assert.equal(visibleWidth(glyph), activity === 'preparing' ? 3 : 1, `${activity}: one counted column plus its own gaps`);
	}
});

// ---- one rule per family ----

// Read-only inspection is the one family the ODD protocol also names as a phase, and
// the card reads the same segments the reference reads.
test('a read-only composition names the exploring activity', () => {
	for (const command of [
		'git status',
		'git log --oneline -5',
		'git diff --stat',
		'git show HEAD',
		'git branch -a',
		'ls -la',
		'cat package.json',
		'head -20 README.md',
		'tail -n 5 log.txt',
		'grep -rn foo lib',
		'rg oddActivity',
		"find . -name '*.ts'",
		'wc -l lib/bash-activity.js',
		'pwd',
		'gh pr view 12',
		'cat package.json && git diff',
	]) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
});

// A verification runner is the check it is; the family reads the runner, not a
// script name a repository happened to choose, and a namespaced `test:unit` keeps
// the base family it is namespaced under.
test('a verification runner names the checking activity', () => {
	for (const command of [
		'pnpm test',
		'npm test',
		'npm run test -- --watch=false',
		'node --experimental-strip-types --test tests/activity.test.js',
		'node scripts/check-types.mjs',
		'npx vitest run a.test.js',
		'jest --ci',
		'go test ./...',
		'go build ./...',
		'cargo test',
		'cargo nextest run --workspace',
		'python -m pytest -q',
		'pytest tests/',
		'tsc --noEmit',
		'pnpm typecheck',
		'pnpm lint',
		'eslint .',
		'npm run build',
		'make',
		'make test',
		'cd sub && make check',
		'deno test -A tests/',
		'deno check mod.ts',
		'ruff check .',
	]) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
});

// The runners the table did not read yet: each ecosystem names its verification with a
// subcommand, and that subcommand is the check whatever builds the project.
test('the remaining ecosystem runners name the checking activity', () => {
	for (const command of [
		'mix test',
		'mix test test/app_test.exs',
		'dotnet test',
		'./gradlew test',
		'gradlew test',
		'gradle test',
		'mvn test',
	]) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
	// The neighbours beside them build or prepare, and `mix format` rewrites, so none of
	// them is a check.
	for (const command of ['dotnet build', 'gradle build', 'mvn package']) {
		assert.notEqual(inferBashActivity(command), 'checking', command);
	}
	assert.equal(inferBashActivity('mix format'), 'formatting');
});

// A test recipe must be a whole argument: `gradle test-fixtures:publish` runs a recipe whose
// name merely starts with `test`, and a prefix is not the check.
test('a recipe whose name starts with test is not the test recipe', () => {
	for (const command of ['gradle test-fixtures:publish', 'mvn test-report:publish', 'mix test-helper', 'dotnet test-tools:run']) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// A project runner hands the segment to the tool it names after supplying the
// environment, so a checker behind `uv run` or `poetry run` is the check the bare
// checker already is; a program the tables never called a check still names nothing.
test('a project runner naming a checker names the checking activity', () => {
	for (const command of [
		'uv run pytest',
		'uv run pytest -q tests/',
		'uv run vitest run',
		'uv run jest',
		'uv run ruff check .',
		'uv run mypy src',
		'uv run tsc --noEmit',
		'uv run eslint .',
		'poetry run pytest',
		'poetry run mypy .',
		// `ruff format --check` reports, so the wrapped form verifies like the bare one.
		'uv run ruff format --check .',
	]) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
	for (const command of ['uv run python x.py', 'poetry run python x.py', 'uv run ruff format .']) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// The wrapped checker must be a whole argument too: `uv run pytest-deploy` runs a program
// whose name starts with a checker's, so it names nothing.
test('a program whose name starts with a checker is not the checker', () => {
	for (const command of ['uv run pytest-deploy', 'poetry run jest-reporter', 'uv run mypy-extensions', 'poetry run tsc-watch']) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// A monorepo flags the workspace before the script, and every value option's value
// must be read as the value it is, or `npm --prefix pkg test` would look like the
// script `pkg`.
test('workspace flags and namespaced scripts still name the checking activity', () => {
	for (const command of [
		'pnpm -C pkg test',
		'pnpm -C packages/app run test',
		'pnpm --filter app test',
		'pnpm --filter=app build',
		'pnpm -w typecheck',
		'pnpm run test:unit',
		'npm run test:e2e',
		'pnpm run check:runtime-modules',
		'pnpm check:provider-contract',
		'yarn test:ci',
		'npm --prefix pkg run test:e2e',
		'npm --prefix pkg test',
		'yarn --cwd pkg test',
		'python -m unittest',
		'python3.12 -m pytest -q',
	]) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
});

// `ruff check --fix` and `deno lint --fix` repair code, so a fix flag turns the
// check into the rewrite it performs. eslint still verifies whatever write flag it
// carries, and `--fix-dry-run` writes nothing, so those stay checks.
test('a fix flag turns a check into the rewrite it performs', () => {
	for (const command of ['ruff check --fix .', 'ruff check --fix-only .', 'deno lint --fix', `ruff check '--fix-only' .`]) {
		assert.equal(inferBashActivity(command), 'formatting', command);
	}
	for (const command of ['ruff check .', 'deno lint', 'eslint --fix .', 'eslint src --fix --max-warnings 0', 'eslint --fix-dry-run src/app.ts']) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
});

// A formatter verifies only when it is told to report, and the report flag belongs
// to the tool that defines it: `-l` lists files for gofmt, gofumpt and shfmt but is
// the line length for black, and a write flag beside a report flag rewrites anyway.
test('a formatter reports a check only in its own report mode', () => {
	for (const command of [
		'gofmt -l .',
		'gofmt -d cmd/app',
		'gofumpt -l .',
		'shfmt -l scripts',
		'shfmt -d scripts/build.sh',
		'black --check .',
		'black --diff src/app.py',
		'black --line-length=100 --check .',
		'prettier --check .',
		'prettier -l src/app.ts',
		'clang-format --dry-run src/app.c',
		'swiftformat --lint .',
		'npx prettier -l src/app.ts',
		'pnpm exec prettier --check .',
		'cargo fmt --check',
		'cargo fmt -- --check',
		'deno fmt --check',
		'ruff format --check .',
		'timeout 60 gofmt -l .',
	]) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
	// A write flag outranks a report flag, and a formatter that rewrites in place by
	// default names the rewrite even when its flags say nothing about it.
	for (const command of [
		'gofmt -l -w .',
		'gofmt -w -l .',
		'gofumpt -w -l .',
		'shfmt -w -l scripts',
		'gofmt -w .',
		'prettier --write .',
		'prettier -w src/app.ts',
		'npx prettier --write src/app.ts',
		'black -l 100 .',
		'black --line-length 100 src/app.py',
		'clang-format -i src/app.c',
		'cargo fmt',
		'go fmt ./...',
		'ruff format .',
		'deno fmt',
		'biome format --write .',
		"stylelint --fix '**/*.css'",
		'rustfmt src/main.rs',
	]) {
		assert.equal(inferBashActivity(command), 'formatting', command);
	}
	// A formatter whose flags this classifier cannot read names nothing at all rather
	// than claiming a rewrite that never happened.
	assert.equal(inferBashActivity("prettier 'a --write b.ts'"), undefined);
});

// A flag keeps its meaning when it is quoted, while quoted text that merely contains
// one is a file name: `black "--check" .` asks black to report, and
// `prettier --check "a --write b.ts"` names a file whose text says `--write`.
test('a quoted flag keeps its mode while quoted text never becomes one', () => {
	for (const command of [
		'black "--check" .',
		"black '--check' .",
		'black "--diff" src/app.py',
		'prettier "--check" .',
		'gofmt "-l" .',
		'black "--line-length=100" --check .',
		'prettier --check "a --write b.ts"',
		`eslint "--fix" .`,
		"pnpm exec eslint '--fix' src",
		'ruff check "src/--fix.py"',
		'deno lint "src/--fix.ts"',
	]) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
	for (const command of ['black "--line-length=100" .', 'gofmt "-w" main.go', 'ruff check "--fix" .', `deno lint '--fix' .`]) {
		assert.equal(inferBashActivity(command), 'formatting', command);
	}
	assert.equal(inferBashActivity('prettier "a --check b.ts"'), undefined);
});

// make reads its options before the recipe, so an option that never changes which
// recipe runs must not hide the check — and every recipe named on the command line
// must be one this classifier can name: `make test install` is not a check.
test('make options keep a check while an unknown recipe names nothing', () => {
	for (const command of [
		'make -B test',
		'make -e -i -O test',
		'make --no-print-directory check',
		'make --always-make -j4 test',
		'make -B -j 4 test',
		'make -rR build',
		'make -s -k check',
		'make -C pkg -B test',
		'make -f Makefile.ci --no-print-directory test',
		'make VAR=1 check',
	]) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
	for (const command of [
		'make install',
		'make deploy',
		'make clean',
		'make release',
		'make test install',
		'make ci',
		// `-j` takes an optional job count, so it must never swallow the recipe.
		'make -j install',
		'make -j2 deploy',
		'make -B install',
		'make -e test install',
		'make -O install',
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// A watchdog bounds how long a command may run without changing what it does, so the
// command behind `timeout` names the call exactly as it would alone (every other family
// is pinned in 'timeout names the command it bounds'). What no table names stays unnamed.
test('a verification runner behind timeout still names the checking activity', () => {
	for (const command of [
		'timeout 900 pnpm typecheck 2>&1 | tail -20',
		'timeout 900 pnpm typecheck',
		'timeout 30 pnpm test',
		'timeout 5 npx vitest run',
		'timeout 60 pnpm -C packages/app run test',
		'timeout 30 make test',
		'timeout -k 5 60 pnpm test',
		'timeout --foreground 900 make check',
		'timeout --signal=KILL 30 cargo test',
	]) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
	for (const command of ['timeout 5 node scripts/release.mjs', 'timeout 300 unknown-script --watch', 'timeout 5']) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// Installing dependencies in any ecosystem, creating a directory, a file or a
// repository, and storing configuration are all the one build-up identity; only the
// forms that name themselves count, so an unknown script stays unnamed.
test('installations, scaffolding and stored configuration name the preparing activity', () => {
	for (const command of [
		'pnpm install',
		'pnpm install --frozen-lockfile',
		'npm ci',
		'npm install left-pad',
		'pnpm -C packages/app install',
		'yarn add left-pad',
		'bun install',
		'pip install -r requirements.txt',
		'python3 -m pip install -e .',
		'uv sync',
		'uv pip install pytest',
		'poetry install',
		'bundle install',
		'composer install',
		'brew install jq',
		'apt-get install -y jq',
		'apk add jq',
		'pacman -S jq',
		'go mod download',
		'go install ./cmd/tool',
		'cargo install cargo-nextest',
		'dotnet restore',
		'git init',
		'git clone https://example.com/repo.git',
		'cargo new crate',
		'mkdir -p tmp/scratch',
		'touch tmp/scratch/file',
		'cp package.json package.json.bak',
		'ln -s ../lib/bash-activity.js bash-activity.js',
		"git config user.name 'A B'",
		'npm config set fund false',
		'go env -w GOFLAGS=-mod=mod',
	]) {
		assert.equal(inferBashActivity(command), 'preparing', command);
	}
});

// A container image the call builds is one this machine now has, the build-up `docker`
// shares with the installers; running, pulling or just looking at one names nothing.
test('a container image build prepares the machine', () => {
	for (const command of ['docker build .', 'docker build -t app:dev .', 'docker build --file Dockerfile.dev .']) {
		assert.equal(inferBashActivity(command), 'preparing', command);
	}
	for (const command of ['docker ps', 'docker images', 'docker version']) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
	for (const command of ['docker run app:dev', 'docker pull app:dev']) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// An installer told to report prepares nothing: `cargo install --list` lists what is
// already installed and `--dry-run` resolves a tree without writing it, so neither
// names an identity — and a report-shaped argument never hides the writing form.
test('an installer told to list or dry-run prepares nothing', () => {
	for (const command of [
		'cargo install --list',
		'cargo install --list --quiet',
		'npm install --dry-run',
		'npm install --dry-run left-pad',
		'npm ci --dry-run',
		'npm install --dry-run=true',
		'pip install --dry-run .',
		'pip install -e . --dry-run',
		'uv pip install --dry-run pytest',
		'brew install --dry-run jq',
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
	for (const command of ['npm install', 'npm install --save-dev left-pad', 'cargo install cargo-nextest', 'pip install --no-deps .', 'brew install jq']) {
		assert.equal(inferBashActivity(command), 'preparing', command);
	}
});

// Local history changes this machine only: the index, a commit (an `--amend`
// included), a rebase and a cherry-pick. `git -C <dir>` names the directory it runs
// in, never a different command.
test('local history changes name the versioning activity', () => {
	for (const command of [
		'git add -A',
		'git add lib/bash-activity.js',
		'git -C /repo add .',
		"git commit -m 'feat: x'",
		'git commit --amend --no-edit',
		'git commit -m "$(cat msg.txt)"',
		'git commit -m x && git log --oneline -3',
		'git rebase main',
		'git rebase -i origin/main',
		'git rebase --continue',
		'git rebase --abort',
		'git cherry-pick abc1234',
		'git cherry-pick --continue',
		'git cherry-pick --abort',
		'git add -A && git commit -m x',
		'gh stack init',
		'gh stack init --base feat/tracker feat/one feat/two',
		'gh stack add feat/three',
		'gh stack rebase --upstack',
	]) {
		assert.equal(inferBashActivity(command), 'versioning', command);
	}
});

// A remote write creates or moves something on GitHub — a push, a PR or issue
// mutation, a label, a release, a repository, a stack's remote half.
test('remote writes name the publishing activity', () => {
	for (const command of [
		'git push',
		'git push -u origin HEAD',
		'git push origin feat/x',
		'gh pr create --title x --body y',
		'gh pr edit 12 --add-label bug --add-assignee octocat',
		'gh pr close 12',
		'gh pr reopen 12',
		'gh pr merge 12 --squash',
		'gh pr ready 12',
		'gh pr review 12 --approve',
		'gh pr update-branch 12',
		'gh pr comment 12 --body hi',
		'gh issue create --title x --label bug --assignee octocat',
		'gh issue edit 7 --add-label bug --remove-label wip --add-assignee octocat',
		'gh issue close 7',
		'gh issue reopen 7',
		'gh issue comment 7 --body hi',
		'gh issue pin 7',
		'gh issue transfer 7 owner/other',
		'gh label create bug --color ff0000',
		'gh label edit bug --new-name defect',
		'gh label delete bug --yes',
		'gh label clone owner/other',
		'gh release create v1.0.0 --generate-notes',
		'gh release edit v1.0.0 --draft=false',
		'gh release upload v1.0.0 dist/app.tgz',
		'gh stack submit',
		'gh stack submit --auto --open',
		'gh stack push',
		'gh stack sync',
		'gh stack merge',
		'gh stack link',
		'gh stack unstack',
	]) {
		assert.equal(inferBashActivity(command), 'publishing', command);
	}
});

// A package manager's `version` subcommand does two different things: given a bump or a
// version it rewrites the manifest and the tag, while the bare form and `--version`
// only print. Only the rewriting form is local history.
test('a package version bump names the versioning activity while the printing forms inspect', () => {
	for (const command of [
		'npm version patch',
		'npm version minor',
		'npm version major',
		'npm version 1.2.3',
		'npm version patch --no-git-tag-version',
		'pnpm version patch',
		'yarn version minor',
		'bun version 1.2.3',
	]) {
		assert.equal(inferBashActivity(command), 'versioning', command);
	}
	for (const command of ['npm version', 'pnpm version', 'yarn version', 'bun version', 'npm version --version', 'pnpm version --version']) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
});

// Publishing a package uploads it to a registry: a remote write from the package
// manager's own subcommand position, whatever flags the registry needs. Installing
// and testing beside it keep the families they already wear.
test('a package publish names the publishing activity', () => {
	for (const command of ['npm publish', 'pnpm publish', 'yarn publish', 'bun publish', 'npm publish --access public', 'yarn publish --tag next']) {
		assert.equal(inferBashActivity(command), 'publishing', command);
	}
	for (const command of ['npm install', 'npm test']) {
		assert.notEqual(inferBashActivity(command), 'publishing', command);
	}
});

// Moving between branches, aliasing a command and the rest of the stack subcommands
// publish nothing and read nothing, so they name no activity at all; viewing a stack
// is inspection.
test('a stack view is inspection and the rest of the stack subcommands name nothing', () => {
	for (const command of ['gh stack view', 'gh stack view --json', 'gh stack view | jq -r .name']) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
	for (const command of [
		'gh stack checkout',
		'gh stack bottom',
		'gh stack top',
		'gh stack up',
		'gh stack down',
		'gh stack trunk',
		'gh stack switch',
		'gh stack modify',
		'gh stack alias co',
		'gh stack feedback',
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// ---- gh: a CI read verifies work, a plain GET inspects, a write publishes ----

// Waiting on or reading CI results verifies work; it is not exploration, and a
// `sleep` or a `tail` beside it only bounds how long the wait takes.
test('reading or waiting on CI results names the checking activity', () => {
	for (const command of [
		'gh pr checks 1511',
		'gh pr checks 1511 --repo owner/name --watch --interval 20',
		'sleep 30; gh pr checks 1511 --watch 2>&1 | tail -10',
		'gh run watch 123',
		'gh run view 123 --log-failed',
		'gh run list --branch main',
	]) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
	for (const command of ['gh pr view 1511', 'gh pr diff 1511', 'gh issue list']) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
});

// `gh api` writes whenever it is given a writing method, a field, or an input body, so
// only the plain GET form is a query: the writing forms are the remote write they
// perform, and the GET the call spells out with `-X` reads nothing either way.
test('a gh api call that writes names the publishing activity while the plain GET inspects', () => {
	for (const command of [
		'gh api repos/owner/name/pulls',
		'gh api --paginate repos/owner/name/commits',
		'gh api repos/o/n --jq .state',
	]) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
	for (const command of [
		'gh api repos/o/n -X POST',
		'gh api repos/o/n --method POST',
		'gh api --method=PUT repos/o/n/merge',
		'gh api repos/o/n -X DELETE',
		'gh api repos/o/n/issues -f title=x',
		'gh api repos/o/n/issues --raw-field title=x',
		'gh api graphql -F query=@q.graphql',
		'gh api repos/o/n/issues --input body.json',
	]) {
		assert.equal(inferBashActivity(command), 'publishing', command);
	}
});

// A `gh api` argument that proves no payload is not a write: a method that reads, spelled
// with quotes or with an `=`; a field flag with no value; and a header VALUE that merely
// looks like the `-f` flag. None of them may claim the remote write.
test('a gh api argument that proves no payload stays unnamed', () => {
	for (const command of [
		'gh api repos/x/y -X "GET"',
		"gh api repos/x/y --method='HEAD'",
		'gh api repos/x/y -X GET -f per_page=1',
		'gh api repos/x/y -H "X-Custom: -filename"',
		'gh api repos/x/y -f',
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// Running a workflow, or enabling and disabling one, moves work on the remote; listing
// and viewing one only reads it.
test('a workflow run or toggle names the publishing activity', () => {
	for (const command of ['gh workflow run ci.yml', 'gh workflow run ci.yml --ref main', 'gh workflow enable ci.yml', 'gh workflow disable ci.yml']) {
		assert.equal(inferBashActivity(command), 'publishing', command);
	}
	for (const command of ['gh workflow list', 'gh workflow view ci.yml']) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
});

// Metadata probes answer "what is here?" without resolving, building or mutating
// anything; `go env` writes its configuration with `-w` and `-u`, so those are no
// probe, and the writing form is the build-up the next family names.
test('read-only metadata probes inspect while go env writes prepare', () => {
	for (const command of [
		'locale',
		'locale -a',
		'locale | head -4',
		'cargo tree',
		'cargo tree -e normal --depth 1',
		'go env',
		'go env GOPATH',
		'go version',
		'gh auth status',
		'gh search prs --repo owner/name login',
		'gh label list',
		'gh workflow list',
		'gh workflow view ci.yml',
	]) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
	// `-w` stores a value in the Go env config file, which is the build-up the next
	// family names; `-u` unsets one, a form no family here claims, so it stays unnamed
	// rather than being filed as the inspection its sibling `go env` is.
	for (const command of ['go env -w GOPATH=/tmp/go', 'go env -w GOFLAGS=-mod=mod GOPATH=/tmp/go']) {
		assert.equal(inferBashActivity(command), 'preparing', command);
	}
	assert.equal(inferBashActivity('go env -u GOPATH'), undefined);
});

// ---- codegraph ----

// A shell call that runs the CodeGraph program wears the same identity the native
// tool wears, so one program reads as one card. Only a command-position program
// counts: prose that mentions the tool, a flag-only invocation and an unknown
// program that happens to take `codegraph` as an argument claim nothing.
test('a codegraph call names its own card identity', () => {
	for (const command of [
		'codegraph init',
		'codegraph init /tmp/ws',
		'codegraph query --path . -- alpha',
		'codegraph explore --path . -- alpha',
		'cd /tmp/ws && codegraph init',
		'/usr/local/bin/codegraph init',
	]) {
		assert.equal(inferBashActivity(command), 'codegraph', command);
		assert.equal(isCodegraphCommand(command), true, command);
	}
		// Every invocation of the program is its card, whatever subcommand it names: the
	// card's detail is the command itself, so no operation has to be readable.
	for (const command of [
		'codegraph',
		'codegraph --version',
		'codegraph --help',
		'codegraph status',
		'codegraph status .',
		'codegraph callers X',
		'codegraph init > build.log',
		'codegraph init && ./script',
		// A launcher that runs what it names runs the program: only an explicit
		// execution counts, never `npm run codegraph`, which is a script of that name.
		'npx codegraph init',
		'pnpx codegraph explore -- alpha',
		'bunx codegraph status',
		'pnpm exec codegraph status',
		'yarn codegraph status .',
		'yarn exec codegraph status .',
		'pnpm dlx codegraph init',
		'npm exec codegraph init',
	]) {
		assert.equal(inferBashActivity(command), 'codegraph', command);
		assert.equal(isCodegraphCommand(command), true, command);
	}
	// Prose that merely mentions the program, or a script named after it, claims nothing.
	for (const command of ['echo codegraph init', 'mytool codegraph init', 'npm run codegraph']) {
		assert.equal(inferBashActivity(command), undefined, command);
		assert.equal(isCodegraphCommand(command), false, command);
	}
	// A read of a file named after it is still the read it is, so the CodeGraph card
	// never claims it.
	for (const command of ['cat codegraph.json', 'grep -r codegraph src']) {
		assert.equal(inferBashActivity(command), 'exploring', command);
		assert.equal(isCodegraphCommand(command), false, command);
	}
	// A read that merely searches for the word is still the read it is.
	assert.equal(inferBashActivity('git log --grep codegraph'), 'exploring');
	// When a call also runs the program, the card is CodeGraph's: it names what the call
	// did to this project's graph, and a check beside it never takes the row.
	assert.equal(inferBashActivity('codegraph init && pnpm test'), 'codegraph');
	assert.equal(inferBashActivity('git status && codegraph init'), 'codegraph');
	// A deletion still outranks it: it is the one consequence a reader cannot undo.
	assert.equal(inferBashActivity('codegraph init && rm -rf dist'), 'destructive');
});

// Two readers answer the same question about one command: this classifier, and the
// CodeGraph card's own `codegraphCallFromCommand` (lib/codegraph-card-preview.js).
// They must not disagree, or a call would be drawn by one identity and read as
// another; whatever the card claims, this module calls a CodeGraph command.
test('the classifier agrees with the CodeGraph card\'s own reader', () => {
	for (const command of [
		'codegraph init',
		'codegraph query --path . -- alpha',
		'codegraph explore -- alpha',
		'/usr/local/bin/codegraph init',
		'codegraph',
		'codegraph --version',
		'echo codegraph init',
		'git status',
		'pnpm test',
	]) {
		const claimed = codegraphCallFromCommand(command) !== undefined;
		assert.equal(isCodegraphCommand(command), claimed, command);
	}
});

// ---- destructive ----

// A command-position program that deletes files, directories, history or a branch is
// the one consequence a reader cannot undo, so it names the destructive card. The
// evidence is the program's own arguments, read positionally: prose a program merely
// receives never names a deletion.
test('a deletion names the destructive card identity', () => {
	for (const command of [
		'rm dist/a.ts',
		'rm -f dist/a.ts',
		'rm -rf dist',
		'rm -f build/*.log',
		'rm -rf "tmp/my dir"',
		"rm -rf 'tmp/my dir'",
		'rm -rf -- -weird-name',
		'sudo rm -rf /usr/local/lib/tool',
		'timeout 30 rm -rf node_modules',
		'git clean -fd',
		'git clean -fdx',
		'git reset --hard',
		'git reset --hard HEAD~1',
		'git branch -D feat/x',
		'git stash drop',
		'git push --force',
		"find . -name '*.log' -delete",
		'find . -maxdepth 1 -exec rm -rf {} +',
		'dd if=/dev/zero of=disk.img bs=1M',
		'truncate -s 0 app.log',
		'shred -u secret.key',
	]) {
		assert.equal(inferBashActivity(command), 'destructive', command);
	}
});

// The evidence for a database client is the WHOLE command: a client is fed its
// statements through a pipe or a heredoc, so its own segment states none of them.
// Only the payload proves what it deletes, and only a statement that drops, truncates
// or deletes without a clause picking rows is a deletion at all.
test('a database client fed a deletion names the destructive card', () => {
	for (const command of [
		`psql -c 'DROP TABLE users'`,
		`psql -c 'DELETE FROM users'`,
		`mysql -e 'TRUNCATE TABLE logs'`,
		`sqlite3 app.db 'DROP TABLE t'`,
		`echo 'DROP TABLE t' | psql`,
		`printf '%s' 'TRUNCATE TABLE logs' | psql`,
		"psql <<'SQL'\nDROP TABLE t;\nSQL",
		"psql <<-SQL\nDELETE FROM t;\nSQL",
	]) {
		assert.equal(inferBashActivity(command), 'destructive', command);
	}
	// A read, and a delete whose clause picks the rows it removes, prove nothing: the
	// client names no family at all, and the card stays the generic one.
	for (const command of [
		`psql -c 'SELECT 1'`,
		`psql -c 'SELECT * FROM users ORDER BY id'`,
		`psql -c 'DELETE FROM users WHERE id = 1'`,
		`echo 'SELECT 1' | psql`,
		"psql <<'SQL'\nSELECT 1;\nSQL",
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
	// A segment outside the payload that nothing can name does not take the deletion away:
	// the deletion is proven, and the heading claims only what the call provably did.
	for (const command of [
		`psql -c 'DROP TABLE t' && ./scripts/unknown.sh`,
		`echo 'DROP TABLE t' | psql && ./scripts/unknown.sh`,
		"psql <<'SQL'\nDROP TABLE t;\nSQL\n./scripts/unknown.sh",
		'rm -rf dist && ./scripts/unknown.sh',
		'python3 tools/run.py && rm -f out.log',
	]) {
		assert.equal(inferBashActivity(command), 'destructive', command);
	}
});

// A deleting program asked for its usage page prints and stops, so it is the query
// every other family's help flag is — the reading this classifier already makes before
// a family reads the segment, and the reading the reference makes too. A program this
// classifier does not name leaves its `--help` unread (a guess), which keeps the
// segment unnamed rather than calling it a request.
test('a deleting program asked for its usage page is the query it is', () => {
	for (const command of [
		'rm --help',
		'rm -rf dist --help',
		'find --help',
		'dd --help',
		'truncate --help',
		'shred --help',
	]) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
	// An unknown program asked for its usage in the one plain shape (bare words and a final
	// `--help`) is the same query; any other shape of an unknown program stays unnamed.
	assert.equal(inferBashActivity('psql --help'), 'exploring');
	// A help flag directly after a flag-shaped word stays that word's value, the
	// reading this classifier already makes everywhere (T2): the flag is then not a
	// query, and the deletion it would have printed usage for removed nothing either,
	// so the segment names nothing at all rather than claiming either identity. The
	// reference's own order produces exactly this, because its help reading answers
	// "consumed" before the destructive reading declines the same flag.
	for (const command of ['git clean -fd --help', 'git reset --hard --help', "find . -name '*.log' -delete --help"]) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// The classifier runs synchronously on every bash row the host repaints, so a program
// whose name is an inherited member of a lookup table answers "no evidence" instead
// of throwing on the row it was asked to draw.
test('prototype-hazardous programs never throw and never name a deletion', () => {
	for (const command of ['constructor -rf dist', '__proto__ -rf dist', '__proto__ rm -rf dist']) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
	assert.equal(inferBashActivity('constructor --help'), 'exploring');
});

// ---- the precedence ladder ----

// What the call changed outranks what it verified: a remote write outranks a history
// change, a history change outranks a check, a check outranks a rewrite, a rewrite outranks
// a build-up, and CodeGraph sits just above plain inspection. Every rung is stated with the two
// families it separates, so a moved rung fails here.
test('the strongest named segment decides the card', () => {
	assert.equal(inferBashActivity('pnpm test | tail -20'), 'checking');
	assert.equal(inferBashActivity('git status && pnpm test'), 'checking');
	assert.equal(inferBashActivity('git push && git commit -m x'), 'publishing');
	assert.equal(inferBashActivity('git commit -m x && prettier --write .'), 'versioning');
	assert.equal(inferBashActivity('pnpm install && git config user.name x'), 'preparing');
	assert.equal(inferBashActivity('prettier --write . && pnpm install'), 'formatting');
	assert.equal(inferBashActivity('git status && pnpm install'), 'preparing');
	for (const command of ['pnpm install && pnpm test', 'prettier --write . && pnpm test', 'git status && make test']) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
	assert.equal(inferBashActivity('git push && pnpm test'), 'publishing');
	assert.equal(inferBashActivity('git commit -m x && make test'), 'versioning');
	assert.equal(inferBashActivity('pnpm test && git commit -m x'), 'versioning');
	// The top rung: a deletion outranks every identity beside it, because it is the
	// one consequence of the call a reader cannot undo. A check, an inspection or a
	// remote write in the same command never takes the card from it.
	for (const command of [
		'rm -rf dist && pnpm test',
		'pnpm test && git clean -fd',
		'git status && git reset --hard',
		'git push --force && git commit -m x',
		`echo 'DROP TABLE t' | psql && pnpm test`,
	]) {
		assert.equal(inferBashActivity(command), 'destructive', command);
	}
});

// ---- undefined: the card stays generic ----

// The strongest rule in the reference: beside a segment nothing can name, the whole
// call stays generic. The heading never claims a check — or any other identity — for
// work the call also did silently.
test('an unnamed segment anywhere keeps the whole call generic', () => {
	for (const command of [
		'pnpm test && node scripts/release.mjs',
		'pnpm test && ./scripts/deploy.sh',
		"pnpm test && bash -c 'unknown-tool --flag'",
		'curl -X POST https://example.com',
		'ls && unknown-tool --flag',
		// A program whose name is an inherited member of a lookup table is still just an
		// unknown program: the row it is drawn on must never throw.
		'constructor .',
		'__proto__ prettier --write .',
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// A call that changes nothing names no activity, and neither does one with no
// command at all: the card falls back to the tool's own identity.
test('a neutral or empty command names no activity', () => {
	for (const command of ['cd repo', 'echo ok', 'sleep 4', 'echo ===', 'cd /repo && echo done', 'true']) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
	for (const command of [undefined, '', '   ', null, 42]) {
		assert.equal(inferBashActivity(command), undefined, String(command));
	}
});

// A redirect puts the call's output in a file the classifier cannot name, and a
// substitution it cannot follow may hide any command at all — including a delete.
// Both keep the card generic rather than claiming a clean identity for the
// labelled half of the work.
test('a redirect or an unreadable substitution keeps the call generic', () => {
	for (const command of [
		'git push > out.txt',
		'npm install > install.log',
		'git commit -m `cat msg`',
		'git add <(cat list)',
		'git log --oneline `git rev-parse HEAD`',
		'rg foo `cat files.txt`',
		'cat <(touch marker)',
		'diff <(sort a) <(sort b)',
		'ls <(rm -rf dist)',
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// A quoted `>` is text the shell hands the program, never a redirect, so it must not
// turn a labelled call into a write; an unquoted one still does.
test('quoted text never turns a command into a write', () => {
	assert.equal(inferBashActivity('git commit -m "fix: a > b"'), 'versioning');
	assert.equal(inferBashActivity("git commit -m 'x > y' --amend"), 'versioning');
	assert.equal(inferBashActivity('gh issue comment 7 --body "before > after"'), 'publishing');
	assert.equal(inferBashActivity('git log --format="%h > %s" -3'), 'exploring');
	assert.equal(inferBashActivity("printf '%s\\n' \"a > b\" | cat"), 'exploring');
	assert.equal(inferBashActivity('git commit -m x > out.txt'), undefined);
	// The unquoted redirect is a file the call creates; the quoted `>` stays text.
	for (const command of ['cat src/a > out', "echo 'a > b' > out.txt"]) {
		assert.equal(inferBashActivity(command), 'preparing', command);
	}
});

// ---- --help: a query on any family, and never a guess ----

test('a genuine help flag on a known command is inspection', () => {
	for (const command of [
		'git --help',
		'git push --help',
		'git commit --help',
		'git add --help',
		'gh --help',
		'gh pr create --help',
		'gh issue edit --help',
		'gh stack submit --help',
		'pnpm test --help',
		'cargo clippy --help',
		'make install --help',
		'git push --help | head -40',
	]) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
});

test('help detection never masks a mutation or a payload it cannot read', () => {
	// The flag belongs to one segment; a neighbouring mutation still names the card.
	assert.equal(inferBashActivity('git add -A && git commit --help'), 'versioning');
	assert.equal(inferBashActivity('git commit -m x && gh pr create --help'), 'versioning');
	// A quoted flag is text, not a request, so the command keeps its own activity.
	assert.equal(inferBashActivity('git commit -m "--help"'), 'versioning');
	assert.equal(inferBashActivity("git commit -m 'docs: mention --help'"), 'versioning');
	assert.equal(inferBashActivity("printf 'git push --help'"), undefined);
	assert.equal(inferBashActivity('echo "--help"'), undefined);
	// An unknown program's help flag is a query only in the plain shape (bare words, a final
	// `--help`, no path, no runner); a script path, a shell and a payload flag can swallow
	// the help flag, so none of them is a query.
	for (const command of [
		'bash deploy.sh --help',
		'sudo --help',
		'./scripts/deploy.sh --help',
		"bash -c 'git status' --help",
		"node -e 'process.exit(0)' --help",
		"python -c 'print(1)' --help",
		'git commit --help > help.txt',
		'git push --help `date`',
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// `--help` right after an option may be that option's value: git commits a message
// spelled `--help` and gh posts it as a comment body, printing nothing. Which
// options take a value cannot be known here, so that reading only ever removes a
// query and never adds one — a mutation is never turned into exploration.
test('a help flag an option consumed as its value is not a query', () => {
	for (const [command, activity] of [
		['git commit -m --help', 'versioning'],
		['git commit --message --help', 'versioning'],
		['git commit -a -m --help', 'versioning'],
		['gh issue comment 7 --body --help', 'publishing'],
		['gh pr create --title --help', 'publishing'],
		['git push --force --help', 'publishing'],
		['git commit -m --help\\ foo', 'versioning'],
		['git commit -m $OPTS --help', 'versioning'],
		["git commit -m '--help' --help", 'versioning'],
	]) {
		assert.equal(inferBashActivity(command), activity, command);
	}
	// A value that holds escaped whitespace still leaves a real help flag after it.
	for (const command of [
		'git commit -m foo\\ bar --help',
		"git commit -m 'foo bar' --help",
		'git commit -m "x" --help',
		'git commit -m foo --help',
	]) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
});

test('an escaped space keeps a help flag inside the value it belongs to', () => {
	// The shell joins `foo\ --help` into one word, so git commits `foo --help` and no
	// usage page is printed.
	assert.equal(inferBashActivity('git commit -m foo\\ --help'), 'versioning');
	assert.equal(inferBashActivity('gh issue comment 7 --body foo\\ --help'), 'publishing');
	// An escaped backslash is a literal backslash, not a word boundary.
	assert.equal(inferBashActivity('git commit -m a\\\\b --help'), 'exploring');
	assert.equal(inferBashActivity('git commit -m a\\\\ --help'), 'exploring');
	assert.equal(inferBashActivity('git commit -m a\\\\b\\ --help'), 'versioning');
	// A line continuation joins the lines, so a help flag after it is its own argument.
	assert.equal(inferBashActivity('git commit -m foo \\\n--help'), 'exploring');
	assert.equal(inferBashActivity('git commit -m foo\\ \\\n--help'), 'versioning');
});

// ---- the segmenter ----

// The quote-aware splitter is the one segmenter, so a reader that needs the same
// split reads this one and never a second, quoting-blind copy: a separator inside
// quoted text is the program's argument, not a boundary between two commands.
test('the segmenter splits only where the shell would', () => {
	assert.deepEqual(shellCommandSegments('git commit -m "a && b"'), ['git commit -m "a && b"']);
	assert.deepEqual(shellCommandSegments('git log --format="%h; %s" -3'), ['git log --format="%h; %s" -3']);
	assert.deepEqual(shellCommandSegments('git status && git diff'), ['git status ', ' git diff']);
	assert.deepEqual(shellCommandSegments('pnpm test | tail -20'), ['pnpm test ', ' tail -20']);
	assert.deepEqual(shellCommandSegments('a; b'), ['a', ' b']);
	assert.deepEqual(shellCommandSegments('a\nb'), ['a', 'b']);
	// A substitution contributes its own commands and leaves a placeholder behind.
	assert.deepEqual(shellCommandSegments('echo $(git status && git diff)'), ['git status ', ' git diff', 'echo $_']);
	// `&` inside a redirection is part of the redirection, never a separator.
	assert.deepEqual(shellCommandSegments('make test 2>&1'), ['make test 2>&1']);
	assert.deepEqual(shellCommandSegments('make test &>/dev/null'), ['make test &>/dev/null']);
	assert.deepEqual(shellCommandSegments('a & b'), ['a ', ' b']);
});

// A table for the refusals the segmenter feeds the classifier with: what it cannot
// follow stays in one segment that names nothing, so the call is unclassified rather
// than split on a guess. Every row is a shape a real command takes.
test('the segmenter refuses to split what it cannot prove', () => {
	const refusals = [
		// Backticks are not followed, so the command inside is invisible.
		['git log --oneline `git rev-parse HEAD`', undefined],
		// Process substitution is not followed either, and `>(...)` is a write.
		['diff <(sort a) <(sort b)', undefined],
		['cat > >(tee log.txt)', undefined],
		// An unterminated `$(` abandons the split and keeps the whole remainder as ONE
		// segment, so the hidden half is never a command of its own: only the visible
		// prefix is read, and the call wears what that prefix names.
		['git status $(git diff', 'exploring'],
		// An unterminated quote keeps its separator inside the text, so the second half is
		// never a command of its own either — the call keeps the identity its one visible
		// command names rather than claiming the check that was only written down.
		['git commit -m "unterminated && pnpm test', 'versioning'],
		// A quoted separator is one argument, and the call keeps the identity its own
		// command names.
		['git commit -m "a; b" && pnpm test', 'versioning'],
		// A quoted `$(...)` still contributes its own commands, so a check hidden in a
		// commit message is a check this card names.
		['git commit -m "$(printf x)"', 'versioning'],
	];
	for (const [command, activity] of refusals) {
		assert.equal(inferBashActivity(command), activity, command);
	}
});

// Classification runs synchronously on every bash row the transcript repaints, so a
// pathological command must never backtrack exponentially and freeze the host.
test('adversarial assignment runs classify in bounded time', () => {
	for (const command of ['a='.repeat(26) + '"', 'a='.repeat(26) + '\\"', 'a='.repeat(26) + "'"]) {
		const start = performance.now();
		assert.equal(inferBashActivity(command), undefined, command);
		const elapsed = performance.now() - start;
		assert.ok(elapsed < 250, `${command} took ${elapsed}ms`);
	}
});

// The user's own transcripts: a read-only call must not fall to the generic card just because
// the program is a modern replacement for one the table already names.
test('read-only inspection programs beyond the classic ones are exploring', () => {
	const exploring = [
		'fd -e js lib', 'fdfind --type f src', 'fd . lib | head',
		'bat README.md', 'batcat -n lib/a.js', 'eza -la', 'exa --tree', 'lsd -l',
		'ag needle src', 'ack needle', 'zgrep x a.gz', 'fgrep -n x a',
		'less README.md', 'man ls', 'id', 'hostname', 'uptime', 'free -h', 'printenv PATH', 'nproc',
		'comm -12 a b', 'paste a b', 'rev a', 'tac a', 'seq 1 5',
		'git stash show -p', 'git diff-tree --stat HEAD', 'git show-ref', 'git symbolic-ref HEAD', 'git cherry -v',
		'gh cache list', 'gh secret list', 'gh variable list',
		'docker ps -a', 'docker images', 'docker logs web', 'docker inspect web', 'kubectl get pods', 'kubectl describe pod x', 'kubectl logs x',
		'npm ls', 'npm view react version', 'npm outdated', 'npm explain x', 'pnpm ls', 'pnpm why x', 'yarn why x', 'pip list', 'pip show x', 'pip freeze',
	];
	for (const command of exploring) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
});

test('a CI run listing stays a check, as it was', () => {
	for (const command of ['gh run list', 'gh run view 123']) assert.equal(inferBashActivity(command), 'checking', command);
});

test('fd names exploring only while it executes nothing', () => {
	for (const command of ['fd -x rm {}', 'fd --exec rm {}', 'fd -X rm', 'fd --exec-batch rm', 'fd . -x sh -c "echo x"']) {
		assert.notEqual(inferBashActivity(command), 'exploring', command);
	}
});

test('a composition of reads with neutral separators is exploring, and one unnamed segment still keeps it generic', () => {
	assert.equal(inferBashActivity('fd -e js lib; echo ---; bat lib/a.js && pwd'), 'exploring');
	assert.equal(inferBashActivity('cd /tmp && fd x && echo done'), 'exploring');
	assert.equal(inferBashActivity('fd -e js lib; frobnicate --now'), undefined);
});

// ---- T7: the census rules ----
//
// A census of the user's own 6000 most recent distinct calls left 32.3% of them on the
// generic `$ bash`, and most of that residue was not ambiguity: it was a command this
// classifier could read if it stripped the same prefix the shell does. Every rule below
// was judged against one standard — a heading must never claim work the call did not
// do — so the payloads nobody can read still stay generic on purpose.

// A git or gh global option names how the tool runs, never what it does, and it stands
// between the program and the subcommand that names the card. `-C <dir>`, `-c <k=v>`,
// `--git-dir`, `--work-tree`, `--no-pager`, `-P`, `--no-optional-locks` and
// `--paginate` are stripped in one place, so no family has to know about them.
test('git and gh global options never hide the subcommand', () => {
	for (const command of [
		'git -C /repo status',
		'git -C /repo --no-pager log -1',
		'git -c core.pager=cat log -1',
		'git --no-pager log -1',
		'git -P status',
		'git --no-optional-locks status',
		'git --git-dir=/repo/.git status',
		'git --git-dir /repo/.git status',
		'git --work-tree=/repo status',
		'gh --paginate pr list',
		'gh -R owner/name pr view 12',
	]) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
	assert.equal(inferBashActivity('git -C /repo add .'), 'versioning');
	assert.equal(inferBashActivity('git --no-pager fetch origin'), 'versioning');
	assert.equal(inferBashActivity('git -C /repo push'), 'publishing');
	assert.equal(inferBashActivity('git -C /repo --no-pager log -1 | head -3'), 'exploring');
	// An option this list does not know is not guessed at: the card stays generic.
	assert.equal(inferBashActivity('git --unknown-option status'), undefined);
});

// A program named by a path is the program the path resolves to, so a virtualenv's
// pytest and a project's own vitest are the checks they are — while a path to a program
// this classifier does not name still matches nothing.
test('a program named by a path classifies as its basename', () => {
	for (const [command, activity] of [
		['/usr/bin/git status', 'exploring'],
		['/opt/homebrew/bin/git -C /repo log -1', 'exploring'],
		['./node_modules/.bin/vitest run a.test.js', 'checking'],
		['.venv/bin/pytest -q', 'checking'],
		['~/.local/bin/ruff check .', 'checking'],
		['./scripts/deploy.sh', undefined],
		['/opt/tools/unknown-tool --flag', undefined],
	]) {
		assert.equal(inferBashActivity(command), activity, command);
	}
});

// A wrapper changes how the command runs, not what it does, so the command behind it
// names the card. `sudo` is deliberately absent: it runs the command as another user,
// and no heading may file a privileged action as the read it resembles. `timeout` only
// bounds the time, so it is unwrapped like the rest.
test('a wrapper names the command it runs, and sudo never names anything', () => {
	for (const [command, activity] of [
		['env FOO=1 git status', 'exploring'],
		['env -i FOO=1 git status', 'exploring'],
		['env --unset=FOO git status', 'exploring'],
		['nice -n 10 git status', 'exploring'],
		['nice -10 git status', 'exploring'],
		['nohup git status', 'exploring'],
		['stdbuf -oL git status', 'exploring'],
		['stdbuf -i0 -o0 git status', 'exploring'],
		['command git status', 'exploring'],
		['exec git status', 'exploring'],
		['ionice -c2 -n7 git status', 'exploring'],
		['time -p pnpm test', 'checking'],
		['nohup npm test', 'checking'],
		['env CI=1 pnpm test', 'checking'],
		['nice -n 5 git -C /repo fetch', 'versioning'],
		['command -v git', 'exploring'],
		['sudo git status', undefined],
		['sudo -u root pnpm test', undefined],
		['env -S "git status"', undefined],
		['env', 'exploring'],
		['timeout 5 git status', 'exploring'],
	]) {
		assert.equal(inferBashActivity(command), activity, command);
	}
});

// Moving between branches, fetching, merging, staging a patch and rewriting local
// history all move work inside this machine and publish nothing: they are the one
// versioning identity. A deletion the destructive table already names keeps its warning.
test('the git verbs that move work name the versioning activity', () => {
	for (const command of [
		'git fetch origin',
		'git fetch --all --prune',
		'git pull',
		'git pull --rebase',
		'git merge main',
		'git merge --no-ff feat/x',
		'git checkout main',
		'git checkout -b feat/x',
		'git switch main',
		'git switch -c feat/y',
		'git restore --staged .',
		'git reset',
		'git reset HEAD~1',
		'git revert abc1234',
		'git apply fix.patch',
		'git am 0001-a.patch',
		'git mv old.ts new.ts',
		'git rm --cached a.txt',
		'git branch feat/x',
		'git branch -m old new',
		'git branch -d old',
		'git tag v1.0.0',
		'git tag -a v1 -m x',
		'git tag -d v1.0.0',
		'git remote add origin /tmp/repo.git',
		'git remote set-url origin /tmp/other.git',
		'git remote rename a b',
		'git stash',
		'git stash push -m wip',
		'git stash pop',
		'git stash apply',
		'git stash save wip',
		'gh pr checkout 12',
	]) {
		assert.equal(inferBashActivity(command), 'versioning', command);
	}
	// A deletion the destructive table already names keeps its warning, and a listing
	// stays the inspection it is.
	for (const command of ['git branch -D feat/x', 'git stash drop', 'git rm a.txt', 'git reset --hard']) {
		assert.equal(inferBashActivity(command), 'destructive', command);
	}
	for (const command of ['git branch', 'git branch -a', 'git tag', 'git tag -l "v*"', 'git stash list', 'git worktree list', 'git remote -v']) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
});

// A subshell's opening `(` stands before the program without a space, and a CI rerun is
// work this machine sent to the remote: neither may hide the command it names.
test('a subshell prefix and a CI rerun name the command they carry', () => {
	assert.equal(inferBashActivity('(git status)'), 'exploring');
	assert.equal(inferBashActivity('(cd /repo && git fetch)'), 'versioning');
	assert.equal(inferBashActivity('(gh pr create --title x --body y)'), 'publishing');
	assert.equal(inferBashActivity('gh run rerun 123'), 'publishing');
	assert.equal(inferBashActivity('gh run cancel 123 --force'), 'publishing');
});

// A worktree the call creates is a checkout this machine did not have, so it is the
// build-up identity; the lock files beside it are local git metadata like the index.
test('a worktree the call creates prepares the machine', () => {
	for (const command of [
		'git worktree add ../x main',
		'git worktree add -b feat/x ../x main',
	]) {
		assert.equal(inferBashActivity(command), 'preparing', command);
	}
	for (const command of ['git worktree lock ../x', 'git worktree unlock ../x']) {
		assert.equal(inferBashActivity(command), 'versioning', command);
	}
	assert.equal(inferBashActivity('git worktree list'), 'exploring');
});

// Programs the transcripts read with name inspection: the journal, the kernel log, the
// unit state, a package's own query verbs, and a tool's read-only words. The noun before
// the read word is transparent, so `herdr plugin list` is the list it is while
// `herdr plugin install` still names nothing.
test('the read-only programs of the census name the exploring activity', () => {
	for (const command of [
		'journalctl -u pi -n 50',
		'journalctl --since today',
		'dmesg -T',
		'systemctl status pi',
		'systemctl is-active herdr',
		'systemctl --user list-units',
		'systemctl show -p MainPID pi',
		'systemctl cat pi.service',
		'pacman -Qo /usr/bin/git',
		'pacman -Qi git',
		'pacman -Qe',
		'pacman -Ss ripgrep',
		'pacman -Si git',
		'brew list',
		'brew info jq',
		'brew search jq',
		'brew outdated',
		'apt list --installed',
		'apt show jq',
		'apt search jq',
		'apt policy jq',
		'mise ls',
		'mise current',
		'mise which node',
		'mise where node',
		'mise doctor',
		'mise ls-remote node',
		'nvim --version',
		'tmux list-sessions',
		'tmux show-options -g',
		'tmux display-message -p x',
		'herdr --version',
		'herdr plugin list',
		'herdr config show',
		'pi --version',
		'pi mcp list',
		'gentle-ai version',
		'gentle-shell --version',
		'odd-worktree list',
		// These tools print their usage page like every other known program.
		'pi --help',
		'herdr plugin --help',
	]) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
	// Only a read word is a read: the same tools' other verbs name nothing.
	for (const command of ['herdr plugin install x', 'pi install x', 'herdr server', 'systemctl restart pi', 'pacman -Syu', 'pacman -Sc', 'apt install jq']) {
		assert.notEqual(inferBashActivity(command), 'exploring', command);
	}
});

// A script names a check only while its name is one. `verify` and a namespaced
// `test:unit` are the same family, while a name that carries a fix, a write, a format, a
// watch, a dev server or a start is not a check at all — and a bare `npm ci` still
// installs, because `ci` is a script only when the package manager runs it as one.
test('a package script names a check only while its name is a check', () => {
	for (const command of [
		'npm run verify',
		'pnpm verify',
		'npm run ci',
		'pnpm run ci',
		'pnpm run test:unit',
		'npm run lint:ci',
		'npm run check:runtime-modules',
		'npm run build',
	]) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
	for (const command of [
		'npm run test:watch',
		'npm run lint:fix',
		'npm run build:watch',
		'npm run format',
		'npm run dev',
		'npm run start',
		'npm run serve',
		'npm run fix:lint',
		'npm run write:docs',
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
	assert.equal(inferBashActivity('npm ci'), 'preparing');
});

// Creating a temporary path, changing a mode or an owner and renaming a file are the
// build-up identity, exactly as `cp` and `mkdir` already are: none of them deletes
// anything a reader could not rename back.
test('temporary paths, modes, owners and renames prepare the machine', () => {
	for (const command of ['mktemp -d', 'mktemp', 'chmod +x scripts/run.sh', 'chmod -R 755 build', 'chown me tmp/file', 'mv old.txt new.txt', 'mise install node@20', 'mise use -g node@20']) {
		assert.equal(inferBashActivity(command), 'preparing', command);
	}
});

// `exit`, `umask`, `unset`, `local`, `read`, `wait`, `return` and `:` change the shell
// the call runs in and nothing else, so the named work beside them still decides the
// card — and each on its own names nothing.
test('shell bookkeeping builtins are neutral', () => {
	for (const [command, activity] of [
		['git status && exit 0', 'exploring'],
		['git commit -m x && umask 022', 'versioning'],
		['git status; unset FOO', 'exploring'],
		['pnpm test && :', 'checking'],
		['pnpm test && wait', 'checking'],
		['exit 1', undefined],
		['umask 022', undefined],
		['local x=1', undefined],
		['read -r answer', undefined],
		['wait', undefined],
		['return 0', undefined],
		[':', undefined],
		// A bare assignment keeps its value whole: the path inside it is a value, never the
		// program the segment runs, so the neutral reading survives a path with spaces.
		['LOG="/var/log/my app.log"', undefined],
		['LOG="/var/log/my app.log" && wc -l app.log', 'exploring'],
		// A comment line is prose the shell never runs, so it keeps no card generic.
		['# a note', undefined],
		['git status;\n# a note\ngit diff', 'exploring'],
		['git add -A\n# stage it all\ngit commit -m x', 'versioning'],
	]) {
		assert.equal(inferBashActivity(command), activity, command);
	}
});

// Ending a process removes no file and rewrites no history, and no family here names
// it: `kill` and `pkill` stay generic rather than wearing the deletion warning.
test('ending a process names no family, so kill and pkill stay generic', () => {
	for (const command of ['kill 1234', 'kill -9 1234', 'pkill -f node', 'killall node']) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// A heredoc body is the text the command reads, never a command of its own: folding it
// into the segment that opens it is what keeps a multi-line commit message from leaking
// its words into the list of commands the classifier reads.
test('a heredoc body belongs to the command that reads it', () => {
	assert.deepEqual(shellCommandSegments("cat <<'EOF'\nhello world\nEOF"), ["cat <<'EOF'\nhello world\nEOF"]);
	assert.deepEqual(shellCommandSegments('a <<-X\n\tbody\n\tX\nb'), ['a <<-X\n\tbody\n\tX', 'b']);
	// The words of a commit message are that message, so the call is the commit it is.
	assert.equal(inferBashActivity("git commit -F - <<'EOF'\nMerge branch 'main' of example\nEOF"), 'versioning');
	assert.equal(inferBashActivity("gh pr create --title x --body \"$(cat <<'EOF'\nsome body\nEOF\n)\""), 'publishing');
	assert.equal(inferBashActivity("git commit -m \"$(cat <<'EOF'\nMerge branch 'main'\n\nbody\nEOF\n)\""), 'versioning');
	// A heredoc that writes a file creates it, and a script that only prints is read.
	assert.equal(inferBashActivity("cat > notes.txt <<'EOF'\nhello\nEOF"), 'preparing');
	assert.equal(inferBashActivity("python3 - <<'PY'\nprint(1)\nPY"), 'exploring');
});

// The payloads nobody can read stay generic on purpose: an inline script, an interpreter
// handed a file to run, an in-place editor, a command that writes its output into a
// file, a privileged invocation, a shell fed by a pipe, and `eval`.
test('the payloads this classifier cannot read stay generic on purpose', () => {
	for (const command of [
		"bash -c 'echo hi'",
		'node scripts/build.mjs',
		'python3 tools/run.py --fast',
		'bash scripts/deploy.sh',
		'echo hi | sh',
		'eval "$(cat setup.sh)"',
		'xargs rm -rf',
		'unknown-tool --flag',
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// Every rule above runs on each repainted bash row, so a long adversarial command must
// still classify in bounded time.
test('a long adversarial command classifies in bounded time', () => {
	for (const command of [
		'git -C /x '.repeat(40) + 'status',
		'env A=1 '.repeat(250) + 'git status',
		"cat <<'EOF'\n".repeat(160) + 'x',
		'herdr '.repeat(50) + 'list',
		'git -C ' + 'a'.repeat(500) + ' status',
	]) {
		const start = performance.now();
		inferBashActivity(command);
		const elapsed = performance.now() - start;
		assert.ok(elapsed < 250, `${command.slice(0, 20)}… took ${elapsed}ms`);
	}
});

// The family the card wears for a checkout the call removes, beside the ones it only
// creates: the censused removal rows were the last silent gap in the table.
test('a removed checkout wears the destructive family, a created one prepares', () => {
	assert.equal(inferBashActivity('git worktree remove ../old'), 'destructive');
	assert.equal(inferBashActivity('git worktree prune'), 'destructive');
	assert.equal(inferBashActivity('git worktree add ../new -b feat/x'), 'preparing');
	assert.equal(inferBashActivity('git worktree list'), 'exploring');
});

// ---- coverage: the shapes real transcripts left generic ----
//
// Mined from the user's own sessions (19k bash calls, ~29% generic): the largest honest
// share was not an unknown program but a SHAPE the reader misread — a heredoc body that
// carries backticks or an arrow, a redirect that only creates a file, a bare `do`/`break`
// line, a `timeout` around an inspection. Each case below names what the call does and
// nothing it did not.

// A heredoc whose delimiter is quoted hands its body to the program as plain data: a
// backtick or an `->` in a commit message is that message, not a hidden command and not
// a redirect. Only an expanding body (unquoted delimiter) can still run something.
test('a quoted heredoc body is data, whatever characters it carries', () => {
	assert.equal(inferBashActivity("git commit -q -F - <<'MSG'\nfix(cards): repaint `Card activity` a -> b\n\nbody > more\nMSG"), 'versioning');
	assert.equal(
		inferBashActivity("cd /repo && set -e\ngit add a b\ngit commit -q -F - <<'MSG'\nfix: x `y`\nMSG\ngit log --oneline -5; git status --short | wc -l"),
		'versioning',
	);
	assert.equal(inferBashActivity("cat <<'EOF'\nhello `x` --help -> y\nEOF"), 'exploring');
	assert.equal(inferBashActivity('git commit -F - <<"MSG"\nfix `x`\nMSG'), 'versioning');
	assert.equal(inferBashActivity('git commit -F - <<\\MSG\nfix `x`\nMSG'), 'versioning');
	// An unquoted delimiter expands its body, so a substitution there may run anything.
	for (const command of ['git commit -F - <<MSG\nfix `date`\nMSG', 'git commit -F - <<MSG\nfix $(date)\nMSG']) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
	// What follows the delimiter on the header line is still the command's own text.
	assert.equal(inferBashActivity("git commit -F - <<'MSG' > out.txt\nfix\nMSG"), undefined);
});

// A `--body` written from a quoted heredoc hands the program the body as data: the
// backticks inside it are the prose the PR carries, never a substitution this reader has
// to follow, so the call is the remote write it performs.
test('a PR body written from a quoted heredoc names the publishing activity', () => {
	const command = `gh pr create --base main --head feat/jobs-activity-card --title "feat(cards): draw background-job tools in the active card style" --body "$(cat <<'EOF'\n## What\n- \`bash_background\`, \`monitor\`, \`job_stop\` and \`job_list\` are now drawn on the card.\nEOF\n)" 2>&1 | tail -3`;
	assert.equal(inferBashActivity(command), 'publishing');
});

// The audit's own real command (a session's `gh pr create` with a 20-line body): the body of
// a quoted heredoc nested inside `$( … )` is data, and an apostrophe in it is not the shell's
// own quote. The scan that finds the end of a substitution reads quotes but not heredoc
// bodies, so an ODD number of body apostrophes left it inside a quote and it never found the
// `)` that closes the substitution: the gh segment stayed one piece of text with the body
// (backticks and all) still in it, and the hidden-substitution veto made the call generic.
test('the audit\'s real PR command names the publishing activity', () => {
	const command = `cd /home/jona/dev/projects/odd-worktree-worktrees/jobs-activity-card && git push -q origin feat/jobs-activity-card 2>&1 | tail -3; gh pr create --base main --head feat/jobs-activity-card --title "feat(cards): draw background-job tools in the active card style" --body "$(cat <<'EOF'
## What

\`bash_background\`, \`monitor\`, \`job_stop\` and \`job_list\` are registered with no renderer of their own, so Pi draws them in a plain box and neither \`neon\` nor \`float\` ever reaches them. While the shell API's \`Card activity\` line answers with this package's \`activity\` design for the tool, they are now drawn on the card substrate in the shell's chosen style.

- Call: the tool's mark and word (\`⧗ background\`, \`◉ monitor\`, \`■ stop\`, \`≡ jobs\`) plus the job's label, else the first line of its command; the whole command when expanded.
- Result: the job's own answer, first rows collapsed and everything expanded, closing the frame with the call's duration.
- \`minimal\`: the call alone while collapsed; a failure still says why.
- Any other answer on \`Card activity\` — \`native\`, \`not-covered\`, \`missing\`, another plugin's design, no shell API, a shell API older than the reader — leaves Pi's own drawing untouched.

The four tools are declared on the \`tags\` line so the shell API can answer for them; the activity design itself returns their rows exactly as drawn.

## Repaint

The gate is read on every paint, inside the component the host already mounted, so flipping \`Card activity\` between \`default\` and \`activity\` repaints the job cards already on screen. Off, the card draws the host's own fallback row and box, reproduced, because these tools have no host renderer to hand the row back to.

## Tests

\`node --test tools/*.test.js\` → 2561 pass, 0 fail (2547 before, 14 new).

\`chore(release): 3.4.0\` is in this PR, as the release commit the tag will be cut from.
EOF
)" 2>&1 | tail -3`;
	assert.equal(inferBashActivity(command), 'publishing');
	// The same call as the card reads it when only the `gh` side is replayed, which is how
	// the audit found it: one segment, body included.
	assert.equal(inferBashActivity(command.slice(command.indexOf('gh pr create'))), 'publishing');
});

// `<<<` is a herestring, not a heredoc: its second `<` opens no header, so nothing after it
// is a body this reader may skip. Reading it as one ate the `)` that closes the `$( … )`,
// left the call unsplit and named the write it only wrapped.
test('a herestring is not a heredoc header', () => {
	const command = 'gh pr create --body "$(cat <<<date)" && ./unclassified.sh\ndate';
	assert.equal(inferBashActivity(command), undefined);
	assert.equal(inferBashActivity('gh pr create --body "$(cat <<<date)"'), 'publishing');
});

// A heredoc's header line is still text the shell acts on: the `)` that closes the inner
// subshell sits on it, and only the body after the newline is data. Skipping to the body's
// end ate that `)` and left the substitution unclosed, so the whole call was named after
// the text it could not split.
test('a heredoc header line is text the shell acts on', () => {
	const command = "gh pr create --body \"$( (cat <<'X')\nplain\nX\n)\" && ./unclassified.sh";
	assert.equal(inferBashActivity(command), undefined);
	assert.equal(inferBashActivity("gh pr create --body \"$( (cat <<'X')\nplain\nX\n)\""), 'publishing');
});

// The substitution veto is not weakened: a command hidden where this reader cannot follow
// it — a backtick in the text the shell acts on, a `<(...)` process substitution, a heredoc
// whose delimiter is UNQUOTED and therefore expands its body — still keeps the whole card
// generic. A `$(...)` is a different shape: the segmenter DOES follow it, so
// `--body "$(git log --oneline -1)"` is read as the `git log` it runs beside the
// `gh pr create` write, and names that write.
test('a substitution the reader cannot follow still keeps the call generic', () => {
	for (const command of [
		'gh pr create --body "see `date` now"',
		'gh pr create --body <(date)',
		'gh pr create --title "`git rev-parse HEAD`" --body x',
		// A real backtick beside a named write still leaves the whole call unnamed.
		'git push && cat `ls`',
		'echo "a `b` c"',
		// An unquoted delimiter expands its body, so a substitution there may run anything.
		"gh pr create --body \"$(cat <<EOF\nsee `date`\nEOF\n)\"",
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
	assert.equal(inferBashActivity('gh pr create --body "$(git log --oneline -1)"'), 'publishing');
});

// A redirect that only CREATES a file from a read or from text is the build-up the
// `preparing` family already names for `mkdir`, `touch` and `cp`; it is never a mutation
// of anything else, so a mutating command beside a redirect stays generic.
test('a redirect that writes a file from a read or from text prepares', () => {
	for (const command of [
		"cat > \"$B\" <<'EOF'\n## What\nEOF",
		"cat >> notes.md <<'EOF'\nmore\nEOF",
		'echo ok > out.txt',
		"printf '%s\\n' a b > list.txt",
		'git show HEAD:a.css > build/a.css',
		'gh pr view 12 --json body -q .body > body.md',
		'git log --oneline 2>&1 > log.txt',
		'echo done | tee log.txt',
		'ls -la | tee -a listing.txt',
	]) {
		assert.equal(inferBashActivity(command), 'preparing', command);
	}
	assert.equal(inferBashActivity('pnpm test && echo ok > out.txt'), 'checking');
	assert.equal(inferBashActivity('git push -q && echo ok > out.txt'), 'publishing');
	assert.equal(
		inferBashActivity("B=$(mktemp /tmp/b.XXXXXX)\ncat > \"$B\" <<'EOF'\nx\nEOF\ngh pr create --title t --body-file \"$B\" 2>&1 | tail -1"),
		'publishing',
	);
	// The deletion beside it still outranks everything.
	assert.equal(
		inferBashActivity("B=$(mktemp /tmp/b.XXXXXX)\ncat > \"$B\" <<'EOF'\nx\nEOF\ngh pr create --title t --body-file \"$B\"\nrm -f \"$B\""),
		'destructive',
	);
	for (const command of [
		'git push > out.txt',
		'npm install > install.log',
		'git commit -m x > out.txt',
		'unknown-tool > out.txt',
		'python3 script.py > out.txt',
		'echo x > >(tee f)',
		'cat <(touch marker)',
		'sed -i s/a/b/ f > out',
		'echo x >',
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// The lines of a script the shell reads as keywords carry no work of their own.
test('loop keywords and declarations are neutral beside the commands they frame', () => {
	assert.equal(inferBashActivity('for f in a b; do\n  git add "$f"\ndone'), 'versioning');
	assert.equal(inferBashActivity('for x in a b; do git status; break; done'), 'exploring');
	assert.equal(inferBashActivity('while read -r l; do\n  git status\n  continue\ndone < list.txt'), 'exploring');
	assert.equal(inferBashActivity('declare -A m=( [1]=2 )\ngit status'), 'exploring');
	assert.equal(inferBashActivity('if true; then\n  git status\nelse\n  git log\nfi'), 'exploring');
	for (const command of ['do', 'done < list.txt', 'break', 'declare -A m=( [1]=2 )']) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// A watchdog changes how long a command may run, never what it does, so the command
// behind it names the call exactly as it would alone.
test('timeout names the command it bounds', () => {
	for (const [command, activity] of [
		['timeout 5 git status', 'exploring'],
		['timeout -k 5 60 git fetch', 'versioning'],
		['timeout --foreground 30 git push', 'publishing'],
		['timeout 30 rm -rf node_modules', 'destructive'],
		['timeout 25 grep -rIl -i foo /tmp', 'exploring'],
		['timeout 5', undefined],
		['timeout 5 unknown-tool --watch', undefined],
		['timeout 5 node scripts/release.mjs', undefined],
	]) {
		assert.equal(inferBashActivity(command), activity, command);
	}
});

test('version probes, environment listings and read-only host probes are exploring', () => {
	for (const command of [
		'node -v',
		'node --version',
		'python3 --version',
		'git --version',
		'cargo -V',
		'go version',
		'env',
		'mount',
		'ss -ltnp',
		'lsblk -f',
		'findmnt /',
		'ip addr show',
		'ip -br link',
		'dconf dump /',
		'gsettings get org.gnome.desktop.interface gtk-theme',
		'niri msg outputs',
		'niri msg focused-window',
		'pactl info',
		'wpctl status',
		'fc-list',
		'adb devices',
		'adb -s emulator-5556 shell getprop sys.boot_completed',
		'herdr pane read wC5:p1 --source visible --lines 60',
		'herdr plugin config-dir worktree-hooks',
		'gentle-ai review mode status',
		'git archive HEAD',
		'git hash-object lib/a.js',
		'npm pack --dry-run',
		'npm pack --dry-run 2>&1 | grep -E "filename|total files" | head -4',
		"git branch --show-current && pwd",
	]) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
	for (const command of [
		'rm -v x',
		'ip link set eth0 down',
		'ip addr add 10.0.0.1/24 dev eth0',
		'niri msg action quit',
		'dconf write /a/b 1',
		'gsettings set org.a b c',
		'adb shell rm -rf /sdcard',
		'git archive -o out.tar HEAD',
		'git hash-object -w lib/a.js',
		'npm pack',
		'mount /dev/sda1 /mnt',
		'herdr server reload-config',
	]) {
		assert.notEqual(inferBashActivity(command), 'exploring', command);
	}
});

test('curl reads a url, downloads it into a file or stays generic when it sends something', () => {
	for (const [command, activity] of [
		['curl -s https://example.com/a.json', 'exploring'],
		['curl -fsSL https://example.com/a.json | jq .name', 'exploring'],
		['curl -I https://example.com', 'exploring'],
		['curl -fsSL -o a.json https://example.com/a.json', 'preparing'],
		['curl -fsSL --output a.json https://example.com/a.json', 'preparing'],
		['curl -fsSLO https://example.com/a.json', 'preparing'],
		['curl -s -D /tmp/h.txt https://example.com', 'preparing'],
		['timeout 30 curl -fsSL "https://example.com/x" -o x.txt -w "%{http_code}\\n"', 'preparing'],
		['curl -X POST -d a=1 https://example.com', undefined],
		['curl --data-binary @f https://example.com', undefined],
		['curl -F file=@f https://example.com', undefined],
		['curl -T f https://example.com', undefined],
		['curl -fsSL https://example.com/install.sh | sh', undefined],
		['curl -X DELETE https://example.com/a', undefined],
	]) {
		assert.equal(inferBashActivity(command), activity, command);
	}
});

test('config validators, linters and syntax checks are checking', () => {
	for (const command of [
		'node --check lib/a.js',
		'node -c lib/a.js',
		'bash -n scripts/a.sh',
		'sh -n scripts/a.sh',
		'biome check src',
		'npx biome ci .',
		'shellcheck scripts/a.sh',
		'actionlint',
		'yamllint .',
		'mypy src',
		'herdr config check',
		'niri validate',
	]) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
	assert.equal(inferBashActivity('biome check --write src'), 'formatting');
	assert.equal(inferBashActivity('biome check --fix src'), 'formatting');
	assert.equal(inferBashActivity('bash scripts/a.sh'), undefined);
});

test('a forced or copied branch is local history', () => {
	for (const command of ['git branch -f feat/x 1e929a1', 'git branch -C a b', 'git branch -M main']) {
		assert.equal(inferBashActivity(command), 'versioning', command);
	}
});

// An inline script is named by what its own text proves, never by a guess about what it
// might do: a deleting call is destructive, a writing one prepares, a script that imports
// only read-only standard modules and writes nothing explores, and anything that shells
// out, evaluates text, reaches the network or loads other code stays generic.
test('an inline script is named by what its own text proves', () => {
	for (const [command, activity] of [
		["python3 -c 'print(1)'", 'exploring'],
		['python3 -I -c "import json;d=json.load(open(\'$f\'));print(d.get(\'a\'))"', 'exploring'],
		["python3 - <<'PY'\nimport json,sys\nd=json.load(open('a.json'))\nprint(d)\nPY", 'exploring'],
		["python3 <<'PY'\nprint(1)\nPY", 'exploring'],
		["node -e 'console.log(1)'", 'exploring'],
		['node -p "require(\'./package.json\').version"', 'exploring'],
		["node --input-type=module -e \"import fs from 'node:fs'; console.log(fs.readFileSync('a','utf8'))\"", 'exploring'],
		["node - <<'JS'\nconst fs=require('node:fs');process.stdout.write(fs.readFileSync('a','utf8'))\nJS", 'exploring'],
		["python3 - <<'PY'\nimport pathlib\npathlib.Path('a').write_text('x')\nPY", 'preparing'],
		["python3 -c \"open('a','w').write('x')\"", 'preparing'],
		["node -e \"require('fs').writeFileSync('a','x')\"", 'preparing'],
		["python3 -c \"import os; os.remove('a')\"", 'destructive'],
		["python3 - <<'PY'\nimport shutil\nshutil.rmtree('d')\nPY", 'destructive'],
		["node -e \"require('fs').rmSync('d',{recursive:true})\"", 'destructive'],
		['python3 -c "print(1)" > out.txt', 'preparing'],
		// Not readable: another program, text run as code, the network, code loaded by name.
		["python3 -c \"import subprocess; subprocess.run(['ls'])\"", undefined],
		['python3 -c "import os; os.system(\'ls\')"', undefined],
		['python3 -c "eval(input())"', undefined],
		['python3 -c "import requests"', undefined],
		['python3 -c "import mymodule"', undefined],
		["node -e \"require('child_process').execSync('ls')\"", undefined],
		["node -e \"import('file://$PWD/x.js')\"", undefined],
		["node -e \"require('./x.js')\"", undefined],
		["node -e \"fetch('https://example.com')\"", undefined],
		// A file or a module to run is not an inline script.
		['python3 tools/run.py', undefined],
		['python3 -m http.server', undefined],
		['node scripts/build.mjs', undefined],
		['node -r ./hook.js -e "1"', undefined],
	]) {
		assert.equal(inferBashActivity(command), activity, command);
	}
});

test('a shell or ssh handed a command line is named by that command line', () => {
	for (const [command, activity] of [
		["bash -c 'git status'", 'exploring'],
		["sh -c 'git push'", 'publishing'],
		["bash -c 'rm -rf dist'", 'destructive'],
		["ssh sv-home 'cat ~/.config/herdr/config.toml'", 'exploring'],
		["ssh -o BatchMode=yes -o ConnectTimeout=8 sv-home 'hostname; ls -la ~/x'", 'exploring'],
		["ssh sv-home 'rm -rf /tmp/x'", 'destructive'],
		["bash -c 'echo hi'", undefined],
		["bash -c 'unknown-tool'", undefined],
		['bash scripts/deploy.sh', undefined],
		['ssh sv-home', undefined],
		["ssh -L 8080:localhost:80 sv-home 'ls'", undefined],
	]) {
		assert.equal(inferBashActivity(command), activity, command);
	}
});

// Single quotes expand nothing, so a backtick inside them hides no command.
test('a backtick inside single quotes is text', () => {
	assert.equal(inferBashActivity("git commit -m 'fix `Card activity` row'"), 'versioning');
	assert.equal(inferBashActivity('git commit -m "fix `date`"'), undefined);
});

// An unknown program's usage page, and an in-place edit, are named by what they do.
test('plain usage requests and in-place edits are named', () => {
	for (const command of ['unknown-tool --help', 'dms ipc --help', 'voxtype transcribe --help']) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
	for (const command of ['./scripts/deploy.sh --help', 'bash deploy.sh --help', 'tool --help extra', 'tool -x --help']) {
		assert.notEqual(inferBashActivity(command), 'exploring', command);
	}
	for (const command of ["sed -i 's/a/b/' file.txt", "sed -i '49,60d' AGENTS.md", "perl -pi -e 's/a/b/' file.txt", "sed -n -i.bak 1p f"]) {
		assert.equal(inferBashActivity(command), 'preparing', command);
	}
	assert.equal(inferBashActivity("sed -n '1,5p' file.txt"), 'exploring');
});

// ---- regressions an independent verification found ----

// A script that only PRINTS a deleting word does not delete; a script that mutates through a
// spelling a pattern list could miss is never filed as a read.
test('inline script text: strings are not calls, and a mutation is never a read', () => {
	assert.equal(inferBashActivity(`python3 -c 'print("os.remove")'`), 'exploring');
	assert.equal(inferBashActivity(`node -e 'console.log("rmSync")'`), 'exploring');
	assert.equal(inferBashActivity(`codegraph status && python3 -c 'print("os.remove")'`), 'codegraph');
	for (const command of [
		`python3 -c 'from os import unlink; unlink("a")'`,
		`python3 -c 'import os as o; o.remove("a")'`,
		`python3 -c 'from pathlib import Path; open(Path("a"), "w").close()'`,
		`python3 -c 'open("a", mode="w").close()'`,
		`node -e 'const {rm}=require("node:fs/promises"); rm("a")'`,
		`node -e 'const stdout=new (require("fs").WriteStream)("out"); stdout.write("x")'`,
		`node -e 'require("fs").openSync("a","w")'`,
	]) {
		assert.notEqual(inferBashActivity(command), 'exploring', command);
	}
	assert.equal(inferBashActivity(`python3 -c 'from pathlib import Path; open(Path("a")).read()'`), 'exploring');
	assert.equal(inferBashActivity(`node -e 'const {readFileSync}=require("fs"); console.log(readFileSync("a","utf8"))'`), 'exploring');
});

test('curl: what it sends, what it keeps in a file, and stdout', () => {
	for (const args of ['-dfoo=bar', '-T./payload', '-sXMERGE', '--config request.txt', '-X POST', '--request=PUT']) {
		assert.equal(inferBashActivity(`curl ${args} https://example.test`), undefined, args);
	}
	assert.equal(inferBashActivity('curl -oout.txt https://example.test'), 'preparing');
	assert.equal(inferBashActivity('curl -o - https://example.test'), 'exploring');
	assert.equal(inferBashActivity('curl -sSLf --max-time 5 https://example.test'), 'exploring');
	assert.equal(inferBashActivity('curl -X GET https://example.test'), 'exploring');
});

test('wrappers: positional arguments, redirects and a bounded depth', () => {
	assert.equal(inferBashActivity(`bash -c 'rm -f "$1"' _ out`), 'destructive');
	assert.equal(inferBashActivity(`bash -c 'git push' > out`), undefined);
	assert.equal(inferBashActivity(`bash -c 'git status' > out`), 'preparing');
	const started = Date.now();
	assert.doesNotThrow(() => inferBashActivity('ssh host '.repeat(4000) + 'true'));
	assert.ok(Date.now() - started < 2000, 'a pile of ssh wrappers is read in bounded time');
});

test('tee and sed -i need a real file and a real flag', () => {
	assert.equal(inferBashActivity('tee --append'), undefined);
	assert.equal(inferBashActivity('tee -a log.txt'), 'preparing');
	assert.notEqual(inferBashActivity('sed -n "1p" "report -i backup.txt"'), 'preparing');
});

// What follows a heredoc's header on its own line is still the shell's text: a pipe or an
// `&&` there starts a command of its own, and the body stays with the command that opened it.
test('a command after a heredoc header on the same line is read', () => {
	assert.deepEqual(shellCommandSegments("cat <<'EOF' | head x\nbody\nEOF"), ["cat <<'EOF' \nbody\nEOF", ' head x']);
	assert.equal(inferBashActivity("cat <<'EOF' | rm -f a\nbody\nEOF"), 'destructive');
	assert.equal(inferBashActivity("cat <<'EOF' | head -3\nbody\nEOF"), 'exploring');
	// An escaped substitution in an expanding body is text.
	assert.equal(inferBashActivity('git commit -F - <<MSG\nfix \\$(date)\nMSG'), 'versioning');
	assert.equal(inferBashActivity('git commit -F - <<MSG\nfix $(date)\nMSG'), undefined);
});

// ---- second verification: a word is a call only when it is called ----
test('inline scripts, curl, comments and stacked heredocs name only what they perform', () => {
	for (const [command, expected] of [
		[`python3 -c 'unlink = 4; print(unlink)'`, 'exploring'],
		[`node -e 'const rmSync=3; console.log(rmSync)'`, 'exploring'],
		[`node -e 'console.log(/rmSync/.test("xyz"))'`, 'exploring'],
		[`python3 -c 'print("open(x, mode=w)")'`, 'exploring'],
		[`python3 -c 'from pathlib import Path; Path("out").open(mode="w").close()'`, 'preparing'],
		[`python3 -c 'from pathlib import Path; Path("out").open("w").close()'`, 'preparing'],
		[`node -e 'console.log(1)' -r ./helper.cjs`, undefined],
		['curl --etag-save etag.txt file:///tmp/input.txt', 'preparing'],
		['curl --output-dir here file:///tmp/input.txt', 'exploring'],
		["cat <<'ONE' <<'TWO'\nfirst\nONE\nrm -f a\nTWO", 'exploring'],
		['echo hello # && rm -rf x', undefined],
		['git status # && rm -rf x', 'exploring'],
		['git commit -m "a # b"', 'versioning'],
	]) {
		assert.equal(inferBashActivity(command), expected, command);
	}
});
