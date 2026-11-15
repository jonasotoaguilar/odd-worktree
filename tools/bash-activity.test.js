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
		// counts it as one, so its mark ends in the one space that keeps a column of
		// its own: the heading's counted width must match what the terminal paints.
		preparing: { glyph: '⚒ ', titleRole: 'syntaxFunction' },
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
		assert.equal([...glyph].length, activity === 'preparing' ? 2 : 1, `${activity}: one mark, plus its own gap`);
		assert.equal(glyph.trimStart(), glyph, `${activity}: a mark never starts with its gap`);
	}
});

test('the host measures every mark at the width the heading assumes', { skip: visibleWidth ? false : 'requires @earendil-works/pi-tui' }, () => {
	for (const activity of SHELL_ACTIVITIES) {
		const { glyph } = SHELL_ACTIVITY_IDENTITY[activity];
		assert.equal(visibleWidth(glyph), activity === 'preparing' ? 2 : 1, `${activity}: one counted column plus its own gap`);
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

// A watchdog bounds how long a check may run without changing what it does, so a
// runner behind `timeout` still names the call. Anything else behind one is not a
// check and is not inspection either.
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
	for (const command of ['timeout 5 node scripts/release.mjs', 'timeout 5 git status', 'timeout 300 unknown-script --watch', 'timeout 5']) {
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

// `gh api` writes whenever it is given a method, a field, or an input body, so only
// the plain GET form is a query — and every writing form is a name this classifier
// will not guess at, which leaves the card generic rather than claiming an identity.
test('a gh api call that writes names nothing while the plain GET inspects', () => {
	for (const command of [
		'gh api repos/owner/name/pulls',
		'gh api --paginate repos/owner/name/commits',
	]) {
		assert.equal(inferBashActivity(command), 'exploring', command);
	}
	for (const command of [
		'gh api repos/o/n -X POST',
		'gh api repos/o/n --method POST',
		'gh api repos/o/n/issues -f title=x',
		'gh api repos/o/n/issues --raw-field title=x',
		'gh api graphql -F query=@q.graphql',
		'gh api repos/o/n/issues --input body.json',
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
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
		'codegraph callers X',
		'codegraph init > build.log',
		'codegraph init && ./script',
		// A launcher that runs what it names runs the program: only an explicit
		// execution counts, never `npm run codegraph`, which is a script of that name.
		'npx codegraph init',
		'pnpx codegraph explore -- alpha',
		'bunx codegraph status',
		'pnpm exec codegraph status',
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
	// A segment outside the payload is still unnamed, so the whole call stays generic:
	// the deletion is proven, but the card never hides the work it cannot name.
	for (const command of [
		`psql -c 'DROP TABLE t' && ./scripts/unknown.sh`,
		`echo 'DROP TABLE t' | psql && ./scripts/unknown.sh`,
		"psql <<'SQL'\nDROP TABLE t;\nSQL\n./scripts/unknown.sh",
	]) {
		assert.equal(inferBashActivity(command), undefined, command);
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
	assert.equal(inferBashActivity('psql --help'), undefined);
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
	for (const command of ['constructor -rf dist', '__proto__ -rf dist', '__proto__ rm -rf dist', 'constructor --help']) {
		assert.equal(inferBashActivity(command), undefined, command);
	}
});

// ---- the precedence ladder ----

// A check outranks a remote write, a history change, a rewrite and a build-up; a
// remote write outranks a history change, a rewrite outranks a build-up, and
// CodeGraph sits just above plain inspection. Every rung is stated with the two
// families it separates, so a moved rung fails here.
test('the strongest named segment decides the card', () => {
	assert.equal(inferBashActivity('pnpm test | tail -20'), 'checking');
	assert.equal(inferBashActivity('git status && pnpm test'), 'checking');
	assert.equal(inferBashActivity('git push && git commit -m x'), 'publishing');
	assert.equal(inferBashActivity('git commit -m x && prettier --write .'), 'versioning');
	assert.equal(inferBashActivity('pnpm install && git config user.name x'), 'preparing');
	assert.equal(inferBashActivity('prettier --write . && pnpm install'), 'formatting');
	assert.equal(inferBashActivity('git status && pnpm install'), 'preparing');
	for (const command of ['pnpm install && pnpm test', 'git push && pnpm test', 'git commit -m x && make test']) {
		assert.equal(inferBashActivity(command), 'checking', command);
	}
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
		'pnpm test && echo ok > out.txt',
		'pnpm test && echo done | tee log.txt',
		'pnpm test && ./scripts/deploy.sh',
		"pnpm test && bash -c 'unknown-tool --flag'",
		'curl https://example.com',
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
	for (const command of ['git commit -m x > out.txt', 'cat src/a > out', "echo 'a > b' > out.txt"]) {
		assert.equal(inferBashActivity(command), undefined, command);
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
	// An unknown program's help flag is a guess, and a payload flag can swallow the
	// help flag, so neither is a query.
	for (const command of [
		'unknown-tool --help',
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
		['git commit -m "a; b" && pnpm test', 'checking'],
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
