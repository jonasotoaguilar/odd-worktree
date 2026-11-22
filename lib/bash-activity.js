'use strict';
// S2 / S3 / S4 (T2): which named ACTIVITY a `bash` call is, decided from its command
// alone — the classifier the bash card's heading wears.
//
// Ported from the user's own gentle-shell branch (`cards-bash-v2`,
// `lib/odd-phase-inference.ts`, read read-only): the shell families, the mark and
// theme role each one wears, the quote-aware segmenter every family is decided with,
// and the reference's conservatism. What is NOT ported is that module's ODD *phase*
// inference — "which step of the protocol does this tool imply" — because this
// package answers one question only: which activity family does this command name,
// or none at all.
//
// The whole module is one rule: never guess. An unknown program, a composition with
// a segment nothing can name, a command hidden in a substitution the segmenter
// cannot follow, a redirect that would put the call's output in a file, or a family
// whose own flags say it is not the thing it looks like — all answer `undefined`,
// which is what the card draws as its generic `$ bash` fallback. A guess would paint
// a heading that claims work the call did not do, and a heading is the one part of a
// collapsed card a reader trusts without expanding it.
//
// The rules the module obeys:
//   * pure: no Pi, no theme, no colour, no filesystem, no process, no clock. It
//     reads a string and returns a family name.
//   * colour is a THEME ROLE, never a palette. `SHELL_ACTIVITY_IDENTITY` holds the
//     host's own slot names (`mdHeading`, `mdLink`, `mdCode`, `success`, `warning`,
//     `syntaxFunction`, `error`), so a light theme, a neon theme or a design pack
//     repaints the heading with everything else. A hex value here would survive a
//     theme change and read as the only unstyled row on screen.
//   * it is the ONE segmenter. A second, quoting-blind splitter would read a
//     separator inside a commit message as a command boundary and disagree with the
//     identity the same call wears.
//
// Plain CommonJS and Node builtins only: this package ships no dependency, and the
// reference's classifier carries no Node API either.

// The two readings a family alone cannot decide: a database client's statements, which
// arrive through a pipe or a heredoc, and the segment that deletes something. The
// evidence module is presentation only — it is read here to decide a heading and
// nothing else in this package may read it.
const { isDestructiveCommand, isDestructiveSegment, isSqlClientSegment } = require('./bash-destructive.js');
// The family an inline interpreter script proves from its own text (`python3 -c`, `node -e`).
const { inlineScriptActivity } = require('./bash-inline-script.js');

/**
 * The activity families, in the reference's precedence order. A family is a card
 * identity, not an ODD phase: none of these reaches the working label or the
 * exploration budget.
 *
 * The destructive family heads this list because a deletion is the one consequence a
 * reader cannot undo, so it outranks every identity beside it. It is decided from two
 * readings the other families do not need: the segment that names a deleting program,
 * and the whole command whose pipe or heredoc feeds a database client its statements.
 */
const SHELL_ACTIVITIES = ['destructive', 'checking', 'formatting', 'preparing', 'publishing', 'versioning', 'codegraph', 'exploring'];

/**
 * The mark and theme role each activity wears. The classifier families are separate
 * from this table; it changes no classification.
 *
 * `mdLink` and `mdHeading` paint the two identities the ODD protocol also names,
 * `warning` is the warm role a local history change wears, `success` the green one a
 * remote write wears, and `syntaxFunction` is the code palette — the one slot
 * `preparing` and `formatting` share, because the shipped themes define six colours a
 * heading can wear and the two maintenance identities are told apart by their mark and
 * their word rather than by a colour no theme has. `mdCode` is the one slot a CodeGraph
 * call wears on either of its cards, whose mark is the tool's own.
 *
 * A mark carries its own gap where a font may paint it wider than the host counts:
 * U+2692 is drawn two cells wide by an emoji-fallback font while the host's width
 * function counts it as one, and that font paints a single space after it inside the
 * glyph's own second cell, so a heading with one gap reads `⚒preparing` — the gap is
 * swallowed. Preparing's mark therefore ends in TWO spaces: the first is the one the
 * wide glyph eats, the second is the column the reader sees. Counted and painted width
 * still agree (the host counts the glyph as one column plus two, the terminal paints
 * two columns of glyph plus one visible space).
 */
const SHELL_ACTIVITY_IDENTITY = {
  // The error role is the one slot that reads as a warning in every shipped theme,
  // and U+26A0 is the mark a reader recognizes before expanding the row.
  destructive: { glyph: '⚠', titleRole: 'error' },
  checking: { glyph: '✓', titleRole: 'mdHeading' },
  formatting: { glyph: '≋', titleRole: 'syntaxFunction' },
  preparing: { glyph: '⚒  ', titleRole: 'syntaxFunction' },
  publishing: { glyph: '↑', titleRole: 'success' },
  versioning: { glyph: '⎇', titleRole: 'warning' },
  codegraph: { glyph: '\u{F01BC}', titleRole: 'mdCode' },
  exploring: { glyph: '⌕', titleRole: 'mdLink' },
};

// Test, typecheck, lint and build runners. Matched per shell segment.
const CHECKING_COMMANDS = [
  /^node\b.*\s--test\b/,
  /^node\s+\S*(test|check|lint|typecheck)[\w-]*\.m?[jt]s\b/,
  /^((npx|pnpx|bunx)\s+|(pnpm|yarn)\s+exec\s+)?(vitest|jest|mocha|tsc|pytest)\b/,
  /^python(3(\.\d+)?)?\s+-m\s+(pytest|unittest)\b/,
  // Every ecosystem names its verification with a subcommand, and that recipe is the check
  // whatever toolchain builds the project. The recipe is a whole argument: `gradle
  // test-fixtures:publish` runs a recipe that only starts with the word `test`.
  /^(mix|dotnet)\s+test(?=\s|$)/,
  /^(gradlew|gradle|mvn|mvnw)\s+test(?=\s|$)/,
  /^go\s+(test|build|vet)\b/,
  /^cargo\s+(test|build|check|clippy|nextest)\b/,
  // `cargo fmt` rewrites code, so only the check form verifies anything.
  /^cargo\s+fmt\b.*\s--check\b/,
  /^ruff\s+format\s+--check\b/,
  // `ruff format` rewrites unless told to report, and the runner's form reads the same.
  /^(uv|poetry)\s+run\s+ruff\s+format\s+--check\b/,
  /^deno\s+(test|check)\b/,
  /^deno\s+fmt\s+--check\b/,
  /^deno\s+task\s+(test|typecheck|lint|build|check)\b/,
  // eslint verifies work whatever write flag it carries, quoted or not.
  /^((npx|pnpx|bunx)\s+|(pnpm|yarn|npm)\s+(exec|run)\s+)?eslint\b/,
  // A project runner supplies the environment and then hands the segment to the program it
  // names, so a checker behind `uv run`/`poetry run` is the check the bare checker already
  // is. Only a checker is read: `uv run python x.py` names nothing, and `ruff format` is a
  // rewrite no check form covers.
  /^(uv|poetry)\s+run\s+(pytest|vitest|jest|mypy|tsc|eslint)(?=\s|$)/,
  // Waiting on or reading CI results verifies work; it is not exploration.
  /^gh\s+pr\s+checks\b/,
  /^gh\s+run\s+(view|watch|list)\b/,
  // A syntax check parses the file and reports; it runs none of it.
  /^node\s+(--check|-c)\b/,
  /^(bash|sh|dash|zsh)\s+-n\b/,
  // The validators of a tool's own config report and change nothing.
  /^(herdr\s+config\s+check|niri\s+validate)\b/,
  /^(qmllint|maestro\s+test)\b/,
];

// These runners verify only when they are not asked to rewrite files: `ruff check
// --fix` and `deno lint --fix` repair code, so they are not checks. The flag is the
// one the shell passes, so a quoted `--fix` counts too, while `--fix-dry-run` writes
// nothing and stays a check. `biome` writes with `--write` as well as `--fix`; the
// linters beside it only report.
const FIXABLE_CHECKING_COMMANDS = [
  /^ruff\s+check\b/,
  /^(uv|poetry)\s+run\s+ruff\s+check(?=\s|$)/,
  /^deno\s+lint\b/,
  /^((npx|pnpx|bunx)\s+)?biome\s+(check|ci|lint)\b/,
  /^((npx|pnpx|bunx)\s+)?(shellcheck|actionlint|yamllint|hadolint|tflint|mypy|pyright|flake8|pylint)\b/,
];
const FIX_FLAGS = new Set(['--fix', '--fix-only', '--unsafe-fixes', '--write']);

// A formatter verifies only when it is told to report. The report flag is the tool's
// own: `-l` lists files for gofmt, gofumpt and shfmt but is the line length for black,
// and a write flag rewrites what a report flag would only name, so `gofmt -l -w .`
// reforms code instead of verifying it.
const FORMATTER_FLAGS = {
  prettier: { report: ['--check', '-l', '--list-different'], write: ['--write', '-w'] },
  black: { report: ['--check', '--diff'], write: [] },
  rustfmt: { report: ['--check'], write: [] },
  gofmt: { report: ['-l', '-d'], write: ['-w'] },
  gofumpt: { report: ['-l', '-d'], write: ['-w'] },
  shfmt: { report: ['-l', '-d'], write: ['-w'] },
  'clang-format': { report: ['--dry-run', '-n'], write: ['-i', '--in-place'] },
  swiftformat: { report: ['--lint', '--dryrun'], write: [] },
};
// `timeout` options that take the word after them; every other flag stands alone.
const TIMEOUT_VALUE_OPTIONS = new Set(['-s', '--signal', '-k', '--kill-after']);

// Package managers that run a script by name, and the scripts that verify work.
// `install`, `deploy`, `publish`, `start` and a dev server are not checks, and an
// unlisted script leaves the call unnamed.
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);
const CHECK_SCRIPTS = new Set(['test', 'typecheck', 'lint', 'build', 'check', 'verify']);
// A script named `ci` is a check only where the package manager runs it AS a script
// (`pnpm run ci`): a bare `npm ci` installs from the lockfile, which is the build-up the
// preparing family already names.
const CHECK_RUN_SCRIPTS = new Set(['ci']);
// A script whose name promises a repair, a reformat, a watch or a server is not a check,
// whatever family it is namespaced under: `test:watch` never ends, `lint:fix` rewrites
// what it reads, and `dev`/`start`/`serve` hold a process open.
const NON_CHECK_SCRIPT = /(fix|write|format|watch|dev|start|serve)/;
// Options that take the token after them, so `pnpm -C pkg test` names its script after
// the workspace directory instead of reading that directory as the script.
const PACKAGE_MANAGER_VALUE_OPTIONS = new Set(['-C', '--dir', '--prefix', '-F', '--filter', '--cwd']);
// Options that take no value and change nothing about which script runs.
const PACKAGE_MANAGER_FLAGS = new Set(['-w', '--workspace-root', '-r', '--recursive', '-s', '--silent']);

// `make` targets that verify work. Any other target — `install`, `deploy`, `clean`,
// `release`, an unknown recipe — changes the machine or does something this classifier
// cannot name, so it leaves the call unnamed.
const MAKE_CHECK_TARGETS = new Set(['test', 'tests', 'check', 'checks', 'build']);
// Options that take their value as the next word.
const MAKE_VALUE_OPTIONS = new Set([
  '-C', '--directory', '-f', '--file', '--makefile', '-I', '--include-dir',
  '-o', '--old-file', '--assume-old', '-W', '--what-if', '--new-file', '--assume-new',
]);
// Options whose value is attached (`-j4`, `-Oline`) or, for the job and load limits,
// may also be the next word when it is a bare count (`-j 4`).
const MAKE_COUNTED_OPTIONS = new Set(['-j', '--jobs', '-l', '--load-average', '-O', '--output-sync']);

// `gh api` writes whenever it is given a method, a field, or an input body, so only
// the plain GET form is a query.
const GH_API_WRITE_FLAGS = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '--input']);

// Formatters and lint fixers rewrite the files they read, so they are not checks. The
// read-only forms — `--check`, `--diff`, `-l`, `--list-different` — are the checks the
// families above already read, and a segment carrying one is never a rewrite. A flag
// named inside quoted text is not a flag the call passes.
const FORMATTING_COMMANDS = [
  /^((npx|pnpx|bunx)\s+|(pnpm|yarn|npm)\s+(exec|run)\s+)?(prettier|biome|stylelint|oxlint|standard|markdownlint)\b.*\s(--write|--fix|-w)(?=\s|=|$)/,
  /^((npx|pnpx|bunx)\s+)?dprint\s+fmt\b/,
  // Formatters that rewrite in place by default; the read-only forms are excluded
  // above, so `black --check` and `rustfmt --check` stay the checks they are.
  /^((npx|pnpx|bunx)\s+)?(black|rustfmt|swiftformat)\b/,
  /^clang-format\b.*\s-i(?=\s|$)/,
  /^(cargo\s+fmt|go\s+fmt)\b/,
  // These print the formatted text unless told to write it.
  /^(gofmt|gofumpt|shfmt)\b.*\s-w(?=\s|$)/,
  /^ruff\s+(check|format)\b/,
  /^deno\s+(fmt|lint)\b/,
  /^(mix|dart|terraform)\s+(format|fmt)\b/,
];
// A formatter told to report instead of rewrite is the check it really is, or nothing
// at all when this classifier cannot read its flags.
const FORMAT_READ_ONLY_FLAGS = new Set(['--check', '--diff', '--list-different', '--dry-run', '-l']);

// Preparing the environment: installing dependencies in any ecosystem, creating a
// directory, file or repository, and storing configuration in a tool's own file. Only
// the forms that name themselves count: an unknown script, an unlisted `make` recipe
// and a bare `git config --unset` stay unnamed.
const PREPARING_COMMANDS = [
  /^(pip|pip3)\s+install\b/,
  /^python(3(\.\d+)?)?\s+-m\s+pip\s+install\b/,
  /^uv\s+(pip\s+install|sync|add|init)\b/,
  /^poetry\s+(install|add)\b/,
  /^(bundle\s+install|gem\s+install|composer\s+install)\b/,
  // A container image the call builds is one this machine now has, the same build-up a
  // dependency install is; running, pulling or just listing one names nothing here.
  /^docker\s+build\b/,
  /^(brew|port)\s+install\b/,
  /^(apt|apt-get|dnf|yum|zypper)\s+(install|add)\b/,
  /^apk\s+add\b/,
  /^pacman\s+-S\b/,
  /^go\s+(get|install|mod\s+download)\b/,
  /^cargo\s+(install|fetch|new|init)\b/,
  /^dotnet\s+(restore|add)\b/,
  // A repository the call creates.
  /^git\s+(init|clone)\b/,
  // A worktree the call creates is a checkout this machine did not have; moving or
  // repairing one writes the same git metadata. `remove`/`prune` delete and stay unnamed
  // because no table here names them.
  /^git\s+worktree\s+(add|move|repair)\b/,
  // A temporary path, a mode, an owner and a rename build the machine up the way `cp`
  // and `mkdir` already do: none of them removes what a reader could not rename back.
  /^(mkdir|touch|cp|ln|mv|mktemp|chmod|chown)\b/,
  // The version manager installs and pins a toolchain like the other installers.
  /^mise\s+(install|use|add)\b/,
  // Configuration the call stores on this machine. A read is inspection and is matched
  // before this family; a key deletion is not preparation either.
  /^git\s+config\s+[^-\s]+\s+\S/,
  /^(pip|pip3)\s+config\s+set\b/,
  /^go\s+env\s+-w\b/,
  // `tee file` writes its input into the file; `tar` extracting or creating builds files up.
  /^tee\s+(?:-\S+\s+)*[^-\s]/,
  // Installing, linking or updating the harness's own packages and plugins builds the machine up.
  /^(pi\s+(install|update)|herdr\s+plugin\s+(install|link|unlink|update)|flatpak\s+install|snap\s+install)\b/,
  /^tar\s+-?[a-zA-Z]*[xc]/,
];
// The package managers install, scaffold and store configuration through the same
// subcommand position, so one reader serves every ecosystem.
const PREPARING_SCRIPTS = new Set(['install', 'i', 'ci', 'add', 'init']);
// The flags that ask an installer to report instead of change the machine:
// `cargo install --list` lists what is already installed and `--dry-run` resolves a
// tree without writing it, so neither prepares the environment.
const PREPARING_READ_ONLY_FLAGS = new Set(['--list', '--dry-run']);

// Local history. The index, a commit (`--amend` included), a rebase and a cherry-pick
// (each with its `--continue`/`--abort`) change this machine only.
const VERSIONING_COMMANDS = [
  /^git\s+(add|commit|rebase|cherry-pick)\b/,
  // Moving work inside this machine: fetching and pulling bring history here, a merge,
  // a checkout, a switch and a restore move the working tree, a patch (and `revert`, its
  // inverse) rewrites history, and `mv`/`rm` stage a rename or a removal. A deletion the
  // destructive table names — a discarded checkout, `rm` without `--cached` — is read
  // before this family.
  /^git\s+(fetch|pull|merge|checkout|switch|restore|revert|apply|am|mv|rm)\b/,
  // `reset` moves the index unless it is told to throw the worktree away: that form is the
  // deletion the destructive reading already names, and a segment whose own `--hard --help`
  // leaves both readings declined stays unnamed.
  /^git\s+reset\b(?!.*\s--hard\b)/,
  // A branch or a tag the call creates, deletes or renames. The listing forms are
  // inspection and are matched before this family, so what is left moves a ref.
  /^git\s+branch\s+(-[dDmMcCfuU]\w*|--(delete|move|copy|set-upstream-to|unset-upstream|edit-description|create-reflog)\b)/,
  /^git\s+branch\s+[^-\s]/,
  /^git\s+tag\s+(-[adfsuv]\w*|--(annotate|delete|sign|force|local-user|message|file|cleanup|verify)\b)/,
  /^git\s+tag\s+[^-\s]/,
  /^git\s+remote\s+(add|remove|rm|rename|set-url|set-head|prune|update)\b/,
  // The local stash holds work this machine keeps; dropping or clearing it is destructive
  // and is read before this family.
  /^git\s+stash\b/,
  // Plumbing that writes objects, the index or a ref without touching the worktree.
  /^git\s+(hash-object\s+-w|update-index|update-ref|write-tree|commit-tree|read-tree|mktree)\b/,
  // A lock is a file in the worktree's own git directory, like the index.
  /^git\s+worktree\s+(lock|unlock)\b/,
  // Checking a PR out brings its branch here and publishes nothing.
  /^gh\s+pr\s+checkout\b/,
  // A stack's local half creates and rebases branches; it publishes nothing.
  /^gh\s+stack\s+(init|add|rebase)\b/,
  // A package manager's own version bump rewrites the manifest and the tag this machine
  // keeps. The bare form and `--version` only print, and the version probes read them first.
  /^(npm|pnpm|yarn|bun)\s+version\s+[^-\s]/,
];

// Remote writes: they create or move something on GitHub, including the label,
// assignment and review mutations that ride on `edit` and its siblings.
const PUBLISHING_COMMANDS = [
  /^git\s+push\b/,
  /^gh\s+(pr|issue)\s+(create|edit|close|reopen|delete|merge|ready|review|comment|update-branch|pin|unpin|lock|unlock|transfer)\b/,
  /^gh\s+label\s+(create|edit|delete|clone)\b/,
  /^gh\s+release\s+(create|edit|delete|upload)\b/,
  /^gh\s+repo\s+(create|edit|delete|archive|rename|fork)\b/,
  // A stack's remote half pushes its branches and rewrites its PRs.
  /^gh\s+stack\s+(submit|push|merge|link|unstack|sync)\b/,
  // Rerunning or cancelling a CI run moves work on the remote, beside `gh pr` and
  // `gh workflow`, which already name their own writes.
  /^gh\s+run\s+(rerun|cancel)\b/,
  // Running a workflow, or enabling and disabling one, moves work on the remote the same
  // way; listing and viewing a workflow are the reads the exploring table names.
  /^gh\s+workflow\s+(run|enable|disable)\b/,
  // A package manager's `publish` uploads the package to a registry.
  /^(npm|pnpm|yarn|bun)\s+publish\b/,
];

// `--help` prints a program's usage and stops, so it is a query on any command family.
// Only a program this classifier already names is asked: an unknown program's flag is
// a guess, and a runner that executes the rest of the segment can swallow the flag as
// an argument to the code it runs.
//
// The deleting programs are listed with the rest because their usage page is the same
// query, even though their own family arrives with T3: `rm --help` prints help and
// removes nothing, and the destructive seam below reads only what is left after this
// reading. No other table here resolves a destructive program.
const HELP_AWARE_COMMANDS = new Set([
  'git', 'gh',
  'node', 'npx', 'pnpx', 'bunx', 'pnpm', 'npm', 'yarn', 'bun', 'deno',
  'go', 'cargo', 'ruff', 'python', 'python3', 'pytest', 'vitest', 'jest',
  'mocha', 'tsc', 'eslint', 'make',
  // The families that delete or rewrite files print their usage the same way.
  'rm', 'find', 'shred', 'truncate', 'dd',
  'prettier', 'biome', 'dprint', 'stylelint', 'oxlint', 'standard', 'markdownlint',
  'black', 'rustfmt', 'swiftformat', 'clang-format', 'gofmt', 'gofumpt', 'shfmt',
  'mix', 'dart', 'terraform', 'uv', 'poetry', 'pip', 'pip3',
  // The harness tools print their usage the same way every other known program does.
  'herdr', 'pi', 'gentle-ai', 'gentle-shell', 'odd-worktree',
  // Containers and clusters print their usage the same way.
  'docker', 'kubectl',
]);
// Programs that run the code they are handed. Only for these does a payload flag make
// the rest of the segment unreadable.
const SCRIPT_RUNNERS = new Set(['node', 'deno', 'bun', 'python', 'python3']);
const PAYLOAD_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);

// Git listing flags that may take one non-flag argument (`--contains <rev>`) without
// turning `git branch`/`git tag` into a create.
const GIT_LIST_FLAG = String.raw`(\s+(-a|-r|-l|-v|-vv|-n\d*|--all|--remotes|--list|--show-current|--contains|--merged|--no-merged|--points-at|--sort=\S+)(\s+[^-\s]\S*)?)*$`;

// Read-only inspection. Matched per shell segment.
const EXPLORING_COMMANDS = [
  /^git\s+(status|log|diff|show|blame|rev-parse|rev-list|merge-base|ls-files|ls-remote|ls-tree|cat-file|describe|shortlog|reflog|grep|check-ignore|for-each-ref|name-rev|count-objects)\b/,
  new RegExp(String.raw`^git\s+(branch|tag)${GIT_LIST_FLAG}`),
  /^git\s+remote(\s+(-v|--verbose|show|get-url)\b.*)?$/,
  // `git branch` listing with patterns: a list flag and no flag that creates, moves or deletes.
  /^git\s+branch\b(?=.*\s(--list|-l|-v|-vv|-a|-r|--show-current|--contains|--merged|--no-merged)(\s|$))(?!.*\s(-[dDmMcCfuU]\w*|--delete|--move|--copy|--set-upstream-to|--unset-upstream)(\s|=|$))/,
  /^git\s+(worktree|stash)\s+list\b/,
  /^git\s+config\s+(--get|--get-all|--get-regexp|-l|--list)\b/,
  // `git config <key>` without a value reports what is stored.
  /^git\s+config\s+[^-\s]+\s*$/,
  /^gh\s+(pr|issue|repo|release)\s+(view|list|diff|status)\b/,
  /^gh\s+(auth\s+status|search\s+\w+|label\s+list|workflow\s+(list|view))\b/,
  // Viewing a stack reads the local stack and its PRs.
  /^gh\s+stack\s+view\b/,
  // Metadata probes: what is installed, configured, or resolved here.
  /^locale\b/,
  /^cargo\s+tree\b/,
  /^go\s+version\b/,
  /^(ls|cat|head|tail|grep|egrep|rg|wc|pwd|tree|stat|file|which|type|readlink|realpath|dirname|basename|cut|uniq|tr|nl|column|strings|diff|cmp|od|xxd|hexdump|shasum|sha256sum|md5|md5sum|du|df|date|uname|whoami|ps|pgrep|lsof|jq|awk|bat|batcat|eza|exa|lsd|ag|ack|zgrep|fgrep|less|more|man|id|hostname|uptime|free|printenv|nproc|comm|paste|rev|tac|seq)\b/,
  /^command\s+-v\b/,
  /^(\[\[?|test)\s/,
  /^sort\b(?!.*\s(-o|--output)\b)/,
  /^sed\b(?!.*\s(-[a-zA-Z]*i|--in-place)\b)/,
  /^find\b(?!.*\s-(delete|exec|execdir|ok|okdir|fprint\w*)\b)/,
  // `fd` is `find`: it only reads unless it is handed a command to run for each match.
  /^(fd|fdfind)\b(?!.*\s(-x|-X|--exec|--exec-batch)\b)/,
  // More read-only git: the plumbing and stash views that change no ref.
  /^git\s+(diff-tree|diff-index|show-ref|show-branch|symbolic-ref|cherry|range-diff|whatchanged|var|verify-commit|verify-tag)(?=\s|$)/,
  /^git\s+stash\s+show\b/,
  /^gh\s+(cache|secret|variable)\s+list\b/,
  // The journal, the kernel log and the unit state answer "what happened here?" without
  // changing it. `systemctl`'s own options (`--user`, `-H host`) come before its verb.
  /^(journalctl|dmesg)\b/,
  /^systemctl\s+(-{1,2}[\w-]+\s+)*(status|is-active|is-enabled|is-failed|list-units|list-unit-files|list-timers|list-dependencies|show|cat)\b/,
  // A package manager's own query verbs: what is installed, what a package is and what a
  // repository offers. A sync, an install or a cache clean writes and is not one of them.
  /^pacman\s+(-Q\w*|-F\w*|-S[isgl]{1,3})\b/,
  /^brew\s+(list|ls|info|search|outdated)\b/,
  /^apt\s+(list|show|search|policy)\b/,
  // The version manager reports what is resolved where without installing anything.
  /^mise\s+(ls|list|current|which|where|doctor|ls-remote)\b/,
  /^nvim\s+--version\b/,
  /^tmux\s+(list-[\w-]+|show-[\w-]+|display-message)\b/,
  // The harness tools the transcripts call: only a read-only word names the card, and the
  // noun before it is transparent, so `herdr plugin list` is the list it is while
  // `herdr plugin install` still names nothing.
  /^(herdr|pi|gentle-ai|gentle-shell|odd-worktree)\s+([\w-]+\s+){0,2}(version|list|ls|status|doctor|show|info|--version|--help|--status|-v|-h)(?=\s|$)/,
  /^herdr\s+pane\s+(read|list|get|process-info)\b/,
  /^herdr\s+api\s+(snapshot|get|list)\b/,
  /^voxtype\s+config\s+show\b/,
  /^gh\s+stack\s+status\b/,
  /^gh\s+(extension|ext|alias|gpg-key|ssh-key|codespace)\s+list\b/,
  /^(flatpak|snap)\s+(list|info|search)\b/,
  /^herdr\s+plugin\s+config-dir\b/,
  // Version probes: the universal `--version`/`-V`, and each runtime's own `-v`/`version`.
  /^[\w./+-]+\s+(--version|-V)\s*$/,
  /^(node|python3?(\.\d+)?|ruby|php|java|npm|pnpm|yarn|bun|deno|rustc|cargo|go|gcc|clang|make|git|docker|uv|pip3?|ffmpeg|jq|nvim|tmux)\s+(-v|version)\s*$/,
  // `npm version --version` asks the tool for its own version and bumps nothing; the form
  // that takes a non-flag argument is the history change the versioning table names.
  /^(npm|pnpm|yarn|bun)\s+version\s+--version\s*$/,
  // What the shell hands its children, and the state the kernel and the daemons report.
  /^env\s*$/,
  /^ss\b(?!.*\s(-\w*K\w*|--kill)\b)/,
  /^(lsblk|findmnt|lscpu|lspci|lsusb|lsmod|fc-list|fc-match|ffprobe)\b/,
  /^mount(\s+-l)?\s*$/,
  /^ip\s+(-\w+\s+)*(a|addr|address|l|link|r|route|n|neigh|neighbor|rule)(\s+(show|list|ls)(\s+(dev\s+)?[\w.-]+)?)?\s*$/,
  /^dconf\s+(dump|read|list)\b/,
  /^gsettings\s+(get|list-\w+|range|describe)\b/,
  /^niri\s+msg\s+(--json\s+)?(outputs|windows|workspaces|focused-window|focused-output|layers|version|keyboard-layouts|overview-state)\b/,
  /^pactl\s+(-\S+\s+)*(info|list|get-[\w-]+)\b/,
  /^wpctl\s+(status|inspect|get-volume)\b/,
  /^(hostnamectl|timedatectl)(\s+status)?\s*$/,
  /^loginctl\s+(list-\w+|show-\w+|status|show)\b/,
  /^adb\s+(-s\s+\S+\s+)?(devices|get-state|shell\s+getprop(\s+\S+)?)\s*$/,
  // Reading a repository out as an archive or an object id writes nothing unless told to.
  /^git\s+archive\b(?!.*\s(-o|--output)\b)/,
  /^git\s+hash-object\b(?!.*\s-w\b)/,
  // A packing dry run resolves the file list without writing the tarball.
  /^(npm|pnpm|yarn|bun)\s+pack\b.*\s--dry-run\b/,
  // Listing an archive reads it.
  /^tar\s+-?[a-zA-Z]*t/,
  // Containers, clusters and package managers print state without changing it.
  /^docker\s+(ps|images|logs|inspect|version|info|stats|top|port|diff|history|(image|container|volume|network)\s+(ls|inspect|logs)|compose\s+(ps|logs|config|images|top))\b/,
  /^kubectl\s+(get|describe|logs|version|top|explain|api-resources|config\s+(view|get-contexts|current-context))\b/,
  /^(npm|pnpm)\s+(ls|list|ll|la|view|info|show|outdated|explain|why|root|prefix|bin|licenses|search)\b/,
  /^(npm|pnpm|yarn)\s+config\s+(get|list)\b/,
  /^yarn\s+(list|why|info|outdated|licenses)\b/,
  /^(pip|pip3)\s+(list|show|freeze|check|inspect|config\s+list)\b/,
];

// Segments that neither inspect nor change anything worth labeling: shell control
// words, no-op builtins, and bare variable assignments (their command substitutions
// are classified as commands of their own).
const NEUTRAL_COMMANDS = [
  /^(cd|pushd|popd|echo|printf|sleep|true|false|export|set|unset|local|read|wait|return|exit|umask|declare|typeset|readonly|shift)\b/,
  // The lines of a loop or a branch that carry no command of their own.
  /^(do|then|else|break|continue)(\s|$)/,
  /^done(\s+<\s*\S+)?$/,
  // `:` is the shell's own no-op, and it is not a word, so it needs its own boundary.
  /^:(\s|$)/,
  // A line that starts with `#` is a comment the shell never runs, so a script's prose
  // never keeps the work beside it generic.
  /^#/,
  /^(done|fi|esac|\}|\))$/,
  /^for\s+\w+(\s+in\b.*)?$/,
  // Each assignment must end at whitespace or the end: an optional separator would let
  // `a=a=a=…` split anywhere and backtrack exponentially.
  /^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s"'])*(\s+|$))+$/,
];

// Shell keywords that prefix the command they introduce (`do grep x`), and the opening
// `(` of a subshell, which the program follows directly in `(git status; ...)`. `time`
// is not one of them: it is a wrapper that may carry options, and `stripWrapper` reads
// it.
const LEADING_KEYWORDS = /^((do|then|else|elif|if|while|until|!|\{)\s+|\(\s*)/;

/**
 * The family a shell command names for its own card, or `undefined` when any segment
 * carries no reliable signal and the call must keep the generic card.
 *
 * A deletion outranks everything, and so does a call that runs CodeGraph: the directory
 * is the project's graph and the command is the card's own detail. Beside those, a
 * segment nothing can name keeps the card generic: the heading never claims a check —
 * or any other identity — for work the call also did silently. Among the rest the
 * strongest wins: a check, a remote write, a history change, a rewrite, a build-up.
 */
function inferBashActivity(command) {
  const segments = shellSegments(command);
  if (segments.length === 0) return undefined;
  const activities = segments.map(segmentActivity);
  // A database client runs the statements a pipe or a heredoc hands it, so its own
  // segment states none of them: the WHOLE command proves that deletion, and the
  // client with the payload it reads is what the proof names. Those segments already
  // count as named; a segment outside the payload still keeps the whole card generic,
  // because the call also did work no heading may hide.
  const deletesData = isDestructiveCommand(command);
  const sqlPayload = deletesData ? sqlPayloadCoverage(segments) : [];
  const runsCodeGraph = activities.includes('codegraph');
  // A deletion outranks every other identity on the same call: it is the one
  // consequence a reader cannot undo, so nothing beside it takes the card — not a check,
  // not a segment nothing can name. The heading claims only what the call provably did,
  // and a call that provably deletes did.
  if (activities.includes('destructive') || deletesData) return 'destructive';
  // Below a deletion, a segment nothing can name keeps the whole card generic, so the
  // heading never hides the work the call also did silently — unless the call runs
  // CodeGraph, whose card names the command itself whichever company it keeps.
  if (!runsCodeGraph && activities.some((activity, index) => activity === undefined && sqlPayload[index] !== true)) return undefined;
  // A call that also runs CodeGraph is CodeGraph's card: the command is its detail, so
  // a check or a build beside it never takes the row.
  if (runsCodeGraph) return 'codegraph';
  // What the call changed outranks what it verified: a remote write, then a history
  // change, then a check, then a rewrite and a build-up, with inspection the base.
  if (activities.includes('publishing')) return 'publishing';
  if (activities.includes('versioning')) return 'versioning';
  if (activities.includes('checking')) return 'checking';
  if (activities.includes('formatting')) return 'formatting';
  if (activities.includes('preparing')) return 'preparing';
  return 'exploring';
}

/**
 * Whether this command is a CodeGraph call, as this classifier reads it: the shell
 * half of the one identity `lib/codegraph-card.js` already draws. The card's own
 * reader (`codegraphCallFromCommand` in `lib/codegraph-card-preview.js`) answers the
 * same question for the words it needs; the two must never disagree, so a call is
 * handed to the CodeGraph card only when both name it.
 */
function isCodegraphCommand(command) {
  return inferBashActivity(command) === 'codegraph';
}

/**
 * Which segments a deletion the whole command proves already names: the database client
 * that runs the statements. The heredoc body it reads is folded into its own segment as
 * the data it is, so the statements are never commands of their own — nothing could name
 * them anyway — and nothing else may be excused from the undefined scan.
 */
function sqlPayloadCoverage(segments) {
  return segments.map(isSqlClientSegment);
}

/** The command split into the simple commands the classifier reads, with the ones that do nothing dropped. */
function shellSegments(command) {
  if (command === undefined || command === null) return [];
  if (typeof command !== 'string') return [];
  return shellCommandSegments(command)
    .map(stripSegment)
    .filter((segment) => segment.length > 0 && !isNeutral(segment));
}

/**
 * What one simple command does. A help flag outranks the verb it qualifies —
 * `git push --help` prints usage — a help flag an option consumed leaves the verb to
 * name the segment, and a help flag this classifier cannot read as a query leaves the
 * segment unnamed rather than naming the verb beside it.
 */
function segmentActivity(segment) {
  // The command position decides first: a call that runs the program is its card
  // whatever it passes it, so `codegraph --help` is the program's own usage page and
  // not the generic inspection a help flag beside another program would name.
  if (codeGraphCommandWords(segment) !== undefined) return 'codegraph';
  const help = helpFlag(segment);
  if (help === 'request') return 'exploring';
  if (help === 'unreadable') return undefined;
  // A command-position word naming a deleting program decides the segment before any
  // other family reads it, so a deletion is never filed as the check or the inspection
  // its verb resembles.
  if (isDestructiveSegment(segment)) return 'destructive';
  // Every family below reads the text the shell acts on: a heredoc body is the data the
  // program is handed, so its words are never flags, redirects or substitutions.
  const split = splitHeredocs(segment);
  const text = split.text;
  const hidden = hasHiddenSubstitution(segment);
  if (isCheckingSegment(text)) return 'checking';
  if (isFormattingSegment(text)) return 'formatting';
  if (isReadOnlyInspection(text, hidden)) return 'exploring';
  // A segment whose payload this classifier cannot read is a write it cannot name.
  if (hidden) return undefined;
  // A redirect into a file creates it. What feeds it must be a read or plain text, so
  // the heading claims only that: a mutation beside a redirect stays unnamed.
  const redirected = writesFile(text);
  const base = redirected ? withoutFileRedirects(text) : text;
  if (base === undefined || writesFile(base)) return undefined;
  const curl = curlReading(shellWords(base));
  if (curl !== undefined) {
    if (curl === 'unnamed') return undefined;
    return redirected ? 'preparing' : curl;
  }
  // An inline script is named by what its own text proves; a shell handed a command line
  // (`bash -c`, `ssh host '…'`) is named by that command line.
  const words = shellWords(base);
  const firstBody = split.bodies[0] === undefined ? undefined : split.bodies[0].text.replace(/^\n/, '');
  const inline = inlineScriptActivity(words.filter((word) => !word.startsWith('<')), firstBody);
  if (inline !== undefined) return redirected && inline === 'exploring' ? 'preparing' : inline;
  const payload = shellPayload(words);
  if (payload !== undefined) {
    // A shell inside a shell is read two levels deep and no further, so a pile of wrappers
    // costs a bounded amount of work and stays unnamed.
    if (payloadDepth >= 2) return undefined;
    payloadDepth += 1;
    let inner;
    try {
      inner = inferBashActivity(payload);
    } finally {
      payloadDepth -= 1;
    }
    // A redirect keeps the answer in a file: a read becomes the file it creates, a deletion
    // is still the deletion, and anything else stays unnamed like `git push > out`.
    if (!redirected) return inner;
    return inner === 'exploring' ? 'preparing' : inner === 'destructive' ? 'destructive' : undefined;
  }
  if (redirected) return TEXT_PRODUCER.test(base) || isReadOnlyInspection(base, false) ? 'preparing' : undefined;
  // An in-place edit rewrites the file it names, as `cat >> file` does. The flag is one the
  // shell hands the program, so a `-i` inside quoted text is never one.
  if (isInPlaceEdit(words)) return 'preparing';
  if (isPreparingSegment(text)) return 'preparing';
  if (matchesAny(VERSIONING_COMMANDS, text)) return 'versioning';
  // `gh api` names its write from the words it passes — a method, a field, an input body —
  // so a pattern in the table cannot read it; the plain GET is the read above.
  if (matchesAny(PUBLISHING_COMMANDS, text) || isGhApiWrite(text)) return 'publishing';
  return undefined;
}

// How many `bash -c` / `ssh host` command lines deep the classifier is reading right now.
let payloadDepth = 0;

// `ssh` options that take the word after them, and the ones that stand alone; any other
// option (a forwarded port, a jump of its own) leaves the command unread.
const SSH_VALUE_OPTIONS = new Set(['-o', '-p', '-i', '-l', '-F', '-J', '-S', '-b', '-c', '-E']);
const SSH_PLAIN_OPTIONS = new Set(['-T', '-t', '-tt', '-n', '-q', '-v', '-4', '-6', '-A', '-a', '-x', '-C']);

/** The command line a shell or an `ssh` call is handed, or `undefined` when it runs a file or none. */
function shellPayload(words) {
  const program = words[0];
  if (program === 'bash' || program === 'sh' || program === 'zsh' || program === 'dash') {
    return words[1] === '-c' && words[2] !== undefined ? words[2] : undefined;
  }
  if (program !== 'ssh') return undefined;
  let index = 1;
  for (; index < words.length; index += 1) {
    const word = words[index] === undefined ? '' : words[index];
    if (SSH_VALUE_OPTIONS.has(word)) index += 1;
    else if (!SSH_PLAIN_OPTIONS.has(word)) break;
  }
  const rest = words.slice(index + 1);
  if (words[index] === undefined || words[index].startsWith('-') || rest.length === 0) return undefined;
  return rest.join(' ');
}

/** Whether the words are `sed` or `perl` asked to edit a file in place. */
function isInPlaceEdit(words) {
  if (words[0] === 'sed') return words.slice(1).some((word) => /^-[a-zA-Z]*i[a-zA-Z.]*$/.test(word) || /^--in-place(=|$)/.test(word));
  if (words[0] === 'perl') return words.slice(1).some((word) => /^-[a-zA-Z]*i[a-zA-Z.]*$/.test(word));
  return false;
}

// What a redirect can honestly be said to create: the text a program prints.
const TEXT_PRODUCER = /^(cat|echo|printf|tee)\b/;

// `curl` reads a URL, and `-o`/`-O`/a redirect keep the answer in a file; anything it
// sends (a body, a form, an upload, a method other than GET or HEAD) is a write to a
// server this classifier cannot read, so it stays unnamed.
const CURL_SENDING_FLAGS = new Set(['--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--form', '--form-string', '--upload-file', '--json', '--config']);
// Long options that keep the answer in a file named by their value (`-` is stdout), and the
// ones that only imply a file.
const CURL_FILE_VALUE_FLAGS = new Set(['--output', '--dump-header', '--cookie-jar', '--trace', '--trace-ascii', '--etag-save', '--libcurl', '--stderr', '--hsts', '--alt-svc']);
const CURL_FILE_FLAGS = new Set(['--remote-name', '--remote-name-all']);
// Options that take a value and keep nothing in a file by themselves.
const CURL_VALUE_ONLY_FLAGS = new Set(['--output-dir']);
// Short options that take a value, glued on (`-oout.txt`) or as the next word.
const CURL_SHORT_VALUE_FLAGS = new Set(['A', 'b', 'c', 'C', 'd', 'D', 'e', 'E', 'F', 'H', 'K', 'm', 'o', 'P', 'Q', 'r', 'T', 'u', 'U', 'w', 'x', 'X', 'y', 'Y', 'z']);

/** `undefined` when the words are not a curl call, else `exploring`, `preparing` or `unnamed`. */
function curlReading(words) {
  if (words[0] !== 'curl') return undefined;
  let toFile = false;
  const isReadMethod = (value) => /^(GET|HEAD)$/i.test(value === undefined ? '' : value);
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] === undefined ? '' : words[index];
    if (word.startsWith('--')) {
      const equals = word.indexOf('=');
      const name = equals < 0 ? word : word.slice(0, equals);
      const attached = equals < 0 ? undefined : word.slice(equals + 1);
      if (name === '--request') {
        const value = attached === undefined ? words[index + 1] : attached;
        if (attached === undefined) index += 1;
        if (!isReadMethod(value)) return 'unnamed';
      } else if (CURL_SENDING_FLAGS.has(name)) {
        return 'unnamed';
      } else if (CURL_FILE_VALUE_FLAGS.has(name)) {
        const value = attached === undefined ? words[index + 1] : attached;
        if (attached === undefined) index += 1;
        if (value !== '-') toFile = true;
      } else if (CURL_FILE_FLAGS.has(name)) {
        toFile = true;
      } else if (CURL_VALUE_ONLY_FLAGS.has(name) && attached === undefined) {
        index += 1;
      }
    } else if (word.length > 1 && word.startsWith('-')) {
      const chars = word.slice(1);
      for (let at = 0; at < chars.length; at += 1) {
        const flag = chars[at];
        if (flag === 'O') toFile = true;
        if (!CURL_SHORT_VALUE_FLAGS.has(flag)) continue;
        // The first value-taking flag ends the cluster: the rest of the word is its value.
        let value = chars.slice(at + 1);
        if (value === '') {
          value = words[index + 1];
          index += 1;
        }
        // A body, a form, an upload or a config this reader cannot see.
        if ('dFTK'.includes(flag)) return 'unnamed';
        if (flag === 'X' && !isReadMethod(value)) return 'unnamed';
        if ('oDc'.includes(flag) && value !== '-') toFile = true;
        break;
      }
    }
  }
  return toFile ? 'preparing' : 'exploring';
}

/**
 * Whether a segment asks a known program for its own usage page: a request, a flag the
 * segment's own text merely mentions or an option consumed, or an unreadable one this
 * classifier refuses to guess about.
 */
function helpFlag(segment) {
  const words = shellWordTokens(commandText(segment));
  const at = words.findIndex((word) => !word.quoted && word.text === '--help');
  if (at < 0) return 'absent';
  // An option may take the help flag as its own value: `git commit -m --help` commits a
  // message spelled `--help` and `gh issue comment --body --help` posts it, printing
  // nothing. Escaped whitespace keeps the two in one word — `git commit -m foo\ --help`
  // commits `foo --help` — and a word that may expand to an option (`$OPTS`) can
  // consume it too. Which options take a value cannot be known here, so a help flag
  // directly after such a word is read as that word's value and the segment keeps its
  // own verb's activity. The reading only ever removes a query, never adds one, so a
  // genuine usage page beside an option stays with the verb instead of turning a
  // mutation into exploration.
  const previous = words[at - 1];
  if (previous !== undefined && (previous.text.startsWith('-') || previous.text.startsWith('$'))) return 'absent';
  const program = (words[0] === undefined ? '' : words[0].text).split('/').pop();
  if (!HELP_AWARE_COMMANDS.has(program === undefined ? '' : program)) return isPlainUsageRequest(words, at) ? 'request' : 'unreadable';
  // `node -e '…' --help` runs the payload with `--help` as its own argument.
  if (SCRIPT_RUNNERS.has(program) && words.slice(1).some((word) => PAYLOAD_FLAGS.has(word.text))) return 'unreadable';
  if (writesFile(segment) || hasHiddenSubstitution(segment)) return 'unreadable';
  return 'request';
}

// Programs that run what they are handed, so a `--help` after them may reach code instead of
// asking for usage.
const HELP_RUNNERS = new Set([
  'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'python', 'python3', 'ruby', 'perl', 'php', 'lua', 'xargs',
  'env', 'sudo', 'doas', 'exec', 'nohup', 'watch', 'ssh', 'time', 'timeout', 'eval', 'source', 'sh', 'bunx', 'pnpx', 'npx',
]);

/**
 * An unknown program asked for its usage, in the one shape no program reads as anything
 * else: bare words (a program and its subcommands, no option, no path) and a final
 * `--help`. A program that runs code, or a path to a script, is never read this way.
 */
function isPlainUsageRequest(words, at) {
  if (at !== words.length - 1 || at < 1 || at > 4) return false;
  const program = words[0].text;
  if (HELP_RUNNERS.has(program) || /[/.]/.test(program)) return false;
  return words.slice(0, at).every((word) => !word.quoted && /^[A-Za-z][\w:-]*$/.test(word.text));
}

/**
 * Splits a segment into the words the program receives, dropping the quoting
 * characters the shell would drop. A quoted `--help` is text handed to the program, and
 * a quoted `-m` is still an option, so both the text and whether the word was quoted
 * are kept.
 */
function shellWordTokens(segment) {
  const words = [];
  let text = '';
  let quoted = false;
  let started = false;
  const push = () => {
    if (started) words.push({ text, quoted });
    text = '';
    quoted = false;
    started = false;
  };
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (char === '\\') {
      // `\X` is the literal X and `\<newline>` is a line continuation, so an escaped
      // space never ends a word: `foo\ --help` is one argument.
      const next = segment[i + 1];
      if (next === undefined) {
        text += char;
        started = true;
        continue;
      }
      i += 1;
      if (next !== '\n') text += next;
      started = true;
      continue;
    }
    if (char === "'") {
      // Nothing is escaped inside single quotes.
      const end = segment.indexOf("'", i + 1);
      text += segment.slice(i + 1, end < 0 ? segment.length : end);
      quoted = true;
      started = true;
      i = end < 0 ? segment.length : end;
      continue;
    }
    if (char === '"') {
      // A double-quoted span is one word whatever spaces it holds, and only `\X` and a
      // continuation escape; the quotes the shell would drop are dropped, so a
      // `--help` inside it stays text.
      let inner = '';
      let end = i + 1;
      while (end < segment.length && segment[end] !== '"') {
        const innerChar = segment[end];
        if (innerChar !== '\\') {
          inner += innerChar;
          end += 1;
          continue;
        }
        const next = segment[end + 1];
        if (next === undefined) {
          inner += innerChar;
          end += 1;
          continue;
        }
        end += 2;
        if (next !== '\n') inner += next;
      }
      text += inner;
      quoted = true;
      started = true;
      i = end;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    text += char;
    started = true;
  }
  push();
  return words;
}

/** A formatter or a lint fixer rewrites what it reads; its read-only form never does. */
function isFormattingSegment(segment) {
  // A flag named inside quoted text is not the flag the call passes, while a quoted
  // flag still is: the family match reads the text with quoted spans blanked, and the
  // flags come from the words the shell would hand the formatter.
  if (!matchesAny(FORMATTING_COMMANDS, unquotedSegment(segment))) return false;
  const invocation = formatterInvocation(segment);
  // A formatter whose flags this table knows rewrites unless it reports: `black -l 100
  // .` still rewrites, while `gofmt -l .` only lists what it would change.
  if (invocation === undefined) return !hasFlag(shellWords(segment), FORMAT_READ_ONLY_FLAGS);
  if (invocation.flags.some((flag) => invocation.formatter.write.includes(flag))) return true;
  return !invocation.flags.some((flag) => invocation.formatter.report.includes(flag));
}

/**
 * Whether a segment prepares the environment. A package manager is read through its
 * own subcommand position, so `pnpm -C pkg install` installs like `pnpm install` — the
 * workspace flags a monorepo needs never hide it.
 */
function isPreparingSegment(segment) {
  // An installer told to list or dry-run changes nothing, so it prepares nothing.
  if (hasFlag(shellWords(segment), PREPARING_READ_ONLY_FLAGS)) return false;
  const script = packageManagerCommand(segment);
  if (script !== undefined) {
    if (PREPARING_SCRIPTS.has(script)) return true;
    // `pnpm config set fund false` stores configuration in the tool's own file.
    return script === 'config' && /\sconfig\s+set\b/.test(segment);
  }
  return matchesAny(PREPARING_COMMANDS, segment);
}

/** A segment verifies work when it runs one of the check families below. */
function isCheckingSegment(segment) {
  if (matchesAny(CHECKING_COMMANDS, segment)) return true;
  if (matchesAny(FIXABLE_CHECKING_COMMANDS, segment)) return !hasFlag(shellWords(segment), FIX_FLAGS);
  if (isFormatterCheck(segment) || isPackageManagerCheck(segment) || isMakeCheck(segment)) return true;
  // A watchdog bounds how long a check may run without changing what it does, so a
  // runner behind `timeout` still checks. Only the check families are unwrapped:
  // `timeout 5 git status` is not a check and is not inspection either.
  const bounded = timeoutCommand(segment);
  return bounded !== undefined && isCheckingSegment(bounded);
}

/**
 * The command a segment's `timeout` wrapper bounds, or undefined when the segment is
 * not a timeout call. The wrapper's flags, their values and the duration it bounds all
 * precede the command that runs.
 */
function timeoutCommand(segment) {
  const words = segment.split(/\s+/);
  if (words[0] !== 'timeout') return undefined;
  let index = 1;
  while (index < words.length && (words[index] === undefined ? '' : words[index]).startsWith('-')) {
    const flag = words[index];
    index += 1;
    if (flag === '--') break;
    if (TIMEOUT_VALUE_OPTIONS.has(flag === undefined ? '' : flag)) index += 1;
  }
  // The duration is required and is not part of the command it bounds.
  index += 1;
  return index < words.length ? words.slice(index).join(' ') : undefined;
}

/**
 * The words a simple command passes, with each quoted span folded into the word that
 * carries it: `black "--check" .` passes the flag `--check`, while
 * `prettier 'a --write b.ts'` passes one file name whose text is that name.
 */
function shellWords(segment) {
  return shellWordTokens(segment).map((word) => word.text);
}

/**
 * The segment's text with every quoted span blanked, except a span that is a
 * flag-shaped word of its own: `black "--check" .` passes that flag, while
 * `prettier 'a --write b.ts'` names one file whose text only looks like one.
 */
function unquotedSegment(segment) {
  return segment.replace(/"[^"]*"|'[^']*'/g, (quoted) => (/^-\S+$/.test(quoted.slice(1, -1)) ? quoted.slice(1, -1) : ' '));
}

/** Whether any word is one of these flags, with an attached `=value` ignored. */
function hasFlag(words, flags) {
  return words.some((word) => flags.has(word.split('=')[0] === undefined ? '' : word.split('=')[0]));
}

/**
 * A formatter invocation and the flags it passes, behind an `npx`/`pnpx`/`bunx` or
 * `pnpm exec` style wrapper when it has one. A flag carries its name up to any attached
 * `=value`, and a separately written value (`black -l 100`) is never a flag of its own.
 */
function formatterInvocation(segment) {
  const words = shellWords(segment);
  let index = 0;
  if (['npx', 'pnpx', 'bunx'].includes(words[0])) index = 1;
  else if (PACKAGE_MANAGERS.has(words[0]) && /^(exec|run)$/.test(words[1] === undefined ? '' : words[1])) index = 2;
  const name = words[index] === undefined ? '' : words[index];
  // The table is a plain object, so a program literally named `constructor` or
  // `__proto__` would otherwise resolve to an inherited member and hand back a
  // "formatter" with no flag lists. A classifier that throws here would break the
  // transcript row it was asked to draw.
  const formatter = Object.hasOwn(FORMATTER_FLAGS, name) ? FORMATTER_FLAGS[name] : undefined;
  if (formatter === undefined) return undefined;
  return { formatter, flags: words.slice(index + 1).map((word) => (word.split('=')[0] === undefined ? word : word.split('=')[0])) };
}

/** A formatter verifies work only when its flags ask it to report. */
function isFormatterCheck(segment) {
  const invocation = formatterInvocation(segment);
  if (invocation === undefined) return false;
  if (invocation.flags.some((flag) => invocation.formatter.write.includes(flag))) return false;
  return invocation.flags.some((flag) => invocation.formatter.report.includes(flag));
}

/**
 * `pnpm -C pkg test` runs the same script as `pnpm test`, so the workspace flags a
 * monorepo needs must not hide it. Only a listed check script counts: `pnpm install`,
 * `pnpm deploy`, and an unlisted script stay unnamed.
 */
function isPackageManagerCheck(segment) {
  const script = packageManagerCommand(segment);
  if (script === undefined) return false;
  if (CHECK_RUN_SCRIPTS.has(script) && /(^|\s)run(\s|$)/.test(segment)) return true;
  return isCheckScript(script);
}

/** The package-manager subcommand the segment runs, after its workspace flags. */
function packageManagerCommand(segment) {
  const words = segment.split(/\s+/);
  if (!PACKAGE_MANAGERS.has(words[0] === undefined ? '' : words[0])) return undefined;
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] === undefined ? '' : words[i];
    if (PACKAGE_MANAGER_FLAGS.has(word) || word === 'run') continue;
    if (PACKAGE_MANAGER_VALUE_OPTIONS.has(word)) {
      i += 1;
      continue;
    }
    const option = /^(--[a-z-]+)=/.exec(word);
    if (option && PACKAGE_MANAGER_VALUE_OPTIONS.has(option[1])) continue;
    return word;
  }
  return undefined;
}

/**
 * `pnpm run test:unit` and `pnpm check:provider-contract` are the same check families
 * under a namespace, so a `:` suffix keeps its base script's meaning — unless the name
 * itself says the script repairs, reformats, watches or serves something, which is not
 * a check however it is namespaced.
 */
function isCheckScript(word) {
  if (NON_CHECK_SCRIPT.test(word)) return false;
  return CHECK_SCRIPTS.has(word.split(':')[0] === undefined ? '' : word.split(':')[0]);
}

/**
 * Only a check recipe counts. A bare `make`, and one whose options name no recipe,
 * builds the default target and stays a check, while every recipe named on the command
 * line must be one of them: `make install`, `make deploy` and `make test install` leave
 * the call unnamed.
 */
function isMakeCheck(segment) {
  const words = segment.split(/\s+/);
  if (words[0] !== 'make') return false;
  for (let i = 1; i < words.length; i += 1) {
    const word = words[i] === undefined ? '' : words[i];
    // `make VAR=1 test` passes a variable, not a recipe.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (MAKE_VALUE_OPTIONS.has(word)) {
      i += 1;
      continue;
    }
    // A job or load limit takes a count, never a recipe: `make -j 4 test` still names
    // `test`, while `make -j install` names `install`.
    if (MAKE_COUNTED_OPTIONS.has(word)) {
      if (/^\d+$/.test(words[i + 1] === undefined ? '' : words[i + 1])) i += 1;
      continue;
    }
    // Any other option changes how make runs rather than which recipe it runs, so it
    // names no recipe — including an option this list does not know, which is still an
    // option and never a recipe.
    if (word.startsWith('-')) continue;
    if (!MAKE_CHECK_TARGETS.has(word)) return false;
  }
  return true;
}

/**
 * Splits a shell command into simple commands. Top-level `&&`, `||`, `;`, `|`, `&`, and
 * newlines separate them; quoted text never does; and every `$(...)` substitution
 * contributes its own commands, leaving a `$_` placeholder behind. Not a full shell
 * parser: whatever it cannot follow lands in a segment that matches no pattern, so the
 * call stays unnamed.
 *
 * This is the one segmenter: the activity inference above reads it, and so does any
 * other reader that needs the same quote-aware split. A second splitter that ignored
 * quoting would read a separator inside a commit message as a segment boundary and
 * disagree with the card's own identity for the same call.
 */
function shellCommandSegments(command) {
  const commands = [];
  let current = '';
  let quote;
  // The heredoc opened on the line being read: its body begins at the next newline.
  let pending;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (pending !== undefined && i === pending.newline && quote === undefined) {
      // The body belongs to the segment that OPENED the heredoc, which may already be in
      // the list when a pipe or `&&` followed the header on the same line.
      const body = command.slice(pending.newline, pending.end);
      if (pending.owner === undefined) current += body;
      else commands[pending.owner] += body;
      i = pending.end - 1;
      pending = undefined;
      continue;
    }
    if (quote === "'") {
      current += char;
      if (char === "'") quote = undefined;
    } else if (char === '\\') {
      current += char + (command[i + 1] === undefined ? '' : command[i + 1]);
      i += 1;
    } else if (char === '$' && command[i + 1] === '(') {
      const end = findSubstitutionEnd(command, i + 2);
      if (end < 0) return [...commands, current + command.slice(i)];
      commands.push(...shellCommandSegments(command.slice(i + 2, end)));
      current += '$_';
      i = end;
    } else if (quote === '"') {
      current += char;
      if (char === '"') quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      // A heredoc hands its body to the command as data, so the body belongs to the
      // segment that opens it: its own newlines and separators are never commands of
      // their own. A body this reader cannot delimit is left in place, and the split below
      // reads it exactly as it always did.
      const end = heredocEnd(command, i);
      const header = HEREDOC_HEADER.exec(command.slice(i));
      const newline = header === null ? -1 : command.indexOf('\n', i + header[0].length);
      if (pending !== undefined && header !== null) {
        // A second heredoc on the same line stacks its body behind the first: this reader does
        // not follow that, so the rest is ONE segment it cannot name, never commands of its own.
        return [...commands, current + command.slice(i)];
      }
      if (end === undefined || header === null || newline < 0 || newline >= end) {
        current += char;
      } else {
        // What follows the header on its line (`| head x`, `&& rm y`) is still the shell's
        // own text and is read as commands; only the body after the newline is data.
        current += header[0];
        pending = { newline, end, owner: undefined };
        i += header[0].length - 1;
      }
    } else if (char === '#' && (current === '' || /[\s;&|(]$/.test(current))) {
      // A comment runs to the end of its line and is never a command.
      while (i + 1 < command.length && command[i + 1] !== '\n') i += 1;
    } else if (isSeparator(command, i)) {
      if (pending !== undefined && pending.owner === undefined) pending.owner = commands.length;
      commands.push(current);
      current = '';
      if ((char === '|' || char === '&') && command[i + 1] === char) i += 1;
    } else {
      current += char;
    }
  }
  commands.push(current);
  return commands;
}

/**
 * Where the heredoc that opens at `start` ends — the index just past its delimiter line —
 * or undefined when this reader cannot delimit it: a header it cannot read, or a delimiter
 * line that never comes.
 */
function heredocEnd(command, start) {
  const header = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_][\w.-]*))/.exec(command.slice(start));
  if (header === null) return undefined;
  const delimiter = header[2] ?? header[3] ?? header[4];
  if (delimiter === undefined || delimiter === '') return undefined;
  // `<<-` strips the leading tabs of every line of the body, the delimiter's own included.
  const stripTabs = header[1] === '-';
  let newline = command.indexOf('\n', start + header[0].length);
  while (newline >= 0) {
    const lineStart = newline + 1;
    const lineEnd = command.indexOf('\n', lineStart);
    const end = lineEnd < 0 ? command.length : lineEnd;
    const line = command.slice(lineStart, end);
    if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) return end;
    newline = lineEnd;
  }
  return undefined;
}

// `&` inside a redirection (`2>&1`, `&>/dev/null`) is not a separator.
function isSeparator(command, i) {
  const char = command[i];
  if (char === '&') return command[i - 1] !== '>' && command[i + 1] !== '>';
  return char === ';' || char === '|' || char === '\n';
}

// Index of the `)` closing a `$(` whose body starts at `start`, or -1.
function findSubstitutionEnd(command, start) {
  let depth = 1;
  let quote;
  for (let i = start; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"') i += 1;
    } else if (char === '\\') i += 1;
    else if (char === "'" || char === '"') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')' && (depth -= 1) === 0) return i;
  }
  return -1;
}

// Drops what the shell reads before the program it runs — harmless redirections
// (`2>&1`, `2>/dev/null`), leading shell keywords (`do grep x`), environment assignments
// (`CI=1 pnpm test`), a program named by a path (`/usr/bin/git`, `.venv/bin/pytest`), the
// global options git and gh accept before their subcommand (`git -C dir status`), a
// wrapper that only changes how the command runs (`nohup`, `env FOO=1`, `time -p`) — and
// whitespace. A bare assignment is left intact for NEUTRAL_COMMANDS.
//
// Each round removes one layer of that prefix and the loop stops as soon as a round
// changes nothing, so the work stays linear; a pathological pile of wrappers stops at the
// bound instead of walking it, which leaves the segment unnamed rather than reading it
// wrong.
function stripSegment(segment) {
  let stripped = segment.replace(HARMLESS_REDIRECTS, '').trim();
  for (let round = 0; round < 6; round += 1) {
    const before = stripped;
    while (LEADING_KEYWORDS.test(stripped)) stripped = stripped.replace(LEADING_KEYWORDS, '');
    stripped = stripAssignmentPrefix(stripped);
    stripped = stripProgramPath(stripped);
    stripped = stripToolGlobalOptions(stripped);
    stripped = stripWrapper(stripped);
    if (stripped === before) break;
  }
  return stripped;
}

// Each environment assignment must end at whitespace or the end: an optional separator
// would let `a=a=a=…` split anywhere and backtrack exponentially.
const ASSIGNMENT_PREFIX = /^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s"'])*\s+)+(?=\S)/;

function stripAssignmentPrefix(segment) {
  return segment.replace(ASSIGNMENT_PREFIX, '');
}

// A program the call names by a path is the program that path resolves to: `/usr/bin/git`
// and `.venv/bin/pytest` are the same inspection and the same check as their basenames.
// A path to a program no table names still matches nothing, so this reading never guesses.
function stripProgramPath(segment) {
  // An assignment's value is not the command the segment runs, and the neutral reading of a
  // bare assignment depends on leaving it whole.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(segment)) return segment;
  const word = /^((?:~|[^\s/]*)(?:\/[^\s/]*)+)(?=\s|$)/.exec(segment);
  if (word === null) return segment;
  const base = word[1].slice(word[1].lastIndexOf('/') + 1);
  if (base === '') return segment;
  return base + segment.slice(word[1].length);
}

// The options git and gh accept BEFORE their subcommand. Each takes the word after it or
// stands alone; none of them names what the tool does, so `git -C /repo status` is the
// inspection `git status` is, and a pager or pagination switch never hides a verb. An
// option neither table knows ends the reading, which leaves the segment unnamed.
const TOOL_GLOBAL_VALUE_OPTIONS = {
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']),
  gh: new Set(['-R', '--repo', '--hostname']),
};
const TOOL_GLOBAL_FLAGS = {
  git: new Set(['--no-pager', '-P', '--no-optional-locks', '--literal-pathspecs', '--no-replace-objects']),
  gh: new Set(['--paginate']),
};

function stripToolGlobalOptions(segment) {
  const tool = /^(git|gh)(?=\s)/.exec(segment);
  if (tool === null) return segment;
  const values = TOOL_GLOBAL_VALUE_OPTIONS[tool[1]];
  const flags = TOOL_GLOBAL_FLAGS[tool[1]];
  const words = shellWordSpans(segment);
  let index = 1;
  while (index < words.length) {
    const word = words[index].text;
    if (flags.has(word)) {
      index += 1;
      continue;
    }
    const name = word.split('=')[0];
    if (values.has(name === undefined ? '' : name)) {
      index += word.includes('=') ? 1 : 2;
      continue;
    }
    break;
  }
  const rest = words[index];
  return rest === undefined ? segment : `${tool[1]} ${segment.slice(rest.start)}`;
}

// The programs that run the command after them without changing what it does, and the
// options each one passes on its own. `sudo` is deliberately absent: it runs the command
// as another user, and a heading must never file a privileged action as the read it
// resembles. `timeout` is absent too, because this suite pins its reading: a watchdog is
// unwrapped for a check and for nothing else.
const WRAPPERS = new Set(['env', 'nice', 'ionice', 'nohup', 'stdbuf', 'command', 'exec', 'time', 'timeout']);
// Options that take their value as the next word (or attached with `=`) and change
// nothing about which command runs.
const WRAPPER_VALUE_OPTIONS = {
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '--class', '-n', '--classdata']),
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  time: new Set(['-f', '--format']),
  exec: new Set(['-a']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
};
// Options whose value is attached to the flag itself (`-c2`, `-oL`, `-10`).
const WRAPPER_ATTACHED_VALUES = { ionice: /^-[cn].+/, stdbuf: /^-[ioe].+/, nice: /^-\d+$/ };
// Options that make the command behind the wrapper unreadable: `env -S` splits one string
// into the command line, `command -v` asks where a program is instead of running it, and
// `ionice -p`/`time -o` name a process and a report file the call writes.
const WRAPPER_OPAQUE_OPTIONS = {
  env: new Set(['-S', '--split-string']),
  command: new Set(['-v', '-V']),
  ionice: new Set(['-p', '--pid']),
  time: new Set(['-o', '--output', '-a', '--append']),
};

/**
 * The segment's words as spans — where each one starts and ends — so a reader can drop the
 * prefix the shell reads before the program and keep the rest of the text exactly as it
 * was written. Rewriting the text would change what an escaped space or a quoted span
 * means, and `--help` is one reading that depends on it.
 */
const SHELL_WORD_SPAN = /(?:[^\s"'\\]|\\.|"[^"]*"|'[^']*')+/g;

function shellWordSpans(segment) {
  const spans = [];
  SHELL_WORD_SPAN.lastIndex = 0;
  let match = SHELL_WORD_SPAN.exec(segment);
  while (match !== null) {
    spans.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    match = SHELL_WORD_SPAN.exec(segment);
  }
  return spans;
}

/**
 * The command a wrapper segment runs, or the segment itself when it wraps nothing this
 * classifier can name — a wrapper with no command left, and one whose own options make
 * what follows unreadable.
 */
function stripWrapper(segment) {
  const words = shellWordSpans(segment);
  if (words.length === 0 || !WRAPPERS.has(words[0].text)) return segment;
  const program = words[0].text;
  const values = WRAPPER_VALUE_OPTIONS[program];
  const opaque = WRAPPER_OPAQUE_OPTIONS[program];
  const attached = WRAPPER_ATTACHED_VALUES[program];
  let index = 1;
  while (index < words.length) {
    const word = words[index].text;
    if (word === '--') {
      index += 1;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    if (opaque !== undefined && opaque.has(word) && !word.includes('=')) return segment;
    const name = word.split('=')[0];
    if (values !== undefined && values.has(name === undefined ? '' : name)) {
      index += word.includes('=') ? 1 : 2;
      continue;
    }
    if (attached !== undefined && attached.test(word)) {
      index += 1;
      continue;
    }
    // A flag this reader does not know is one the wrapper itself reads: `env -i`,
    // `nohup --help`, `command -p`. It is skipped, and the command behind it still runs.
    index += 1;
  }
  // `timeout` takes its duration before the command it bounds.
  if (program === 'timeout') index += 1;
  const rest = words[index];
  return rest === undefined ? segment : segment.slice(rest.start);
}

// A segment that writes a file (`echo x > out`) is never a no-op.
function isNeutral(segment) {
  return !writesFile(segment) && matchesAny(NEUTRAL_COMMANDS, segment);
}

// Package runners that execute the program they name, and the words their own syntax
// puts between them and it: `npx codegraph status` runs it directly, while pnpm, npm,
// yarn and bun need their execution subcommand (`pnpm exec codegraph status`). `npm run
// codegraph` runs a script of that name, so `run` is deliberately absent: only an
// explicit execution of the program is the program. The value is how many launcher
// words (the subcommand included) stand before the program.
const PROGRAM_RUNNERS = { npx: 1, bunx: 1, pnpx: 1, pnpm: 2, npm: 2, yarn: 2, bun: 2 };
const RUN_SUBCOMMANDS = new Set(['exec', 'dlx']);
// A launcher that also runs the program it names directly: `yarn codegraph status`
// runs the binary, while `yarn exec codegraph status` spells the execution out. Both
// are the program; `yarn run codegraph` stays a script of that name.
const DIRECT_RUNNERS = new Set(['yarn']);

// The index of the `codegraph` program a segment runs — written plainly or behind a
// path, or executed by a package runner — and -1 when it runs something else: only the
// command position names a program, so `echo codegraph init` and `cat codegraph.json`
// never match.
function codeGraphProgramIndex(words, start) {
  const program = (value) => /^(?:\S*\/)?codegraph$/.test(value);
  const word = words[start] === undefined ? '' : words[start];
  if (program(word)) return start;
  if (!Object.prototype.hasOwnProperty.call(PROGRAM_RUNNERS, word)) return -1;
  let index = start + 1;
  if (PROGRAM_RUNNERS[word] > 1) {
    // The launcher's own options come before its execution subcommand.
    while (index < words.length && words[index].startsWith('-')) index += 1;
    const subcommand = words[index] === undefined ? '' : words[index];
    if (RUN_SUBCOMMANDS.has(subcommand)) index += 1;
    else if (!DIRECT_RUNNERS.has(word)) return -1;
  }
  while (index < words.length && (words[index].startsWith('-') || words[index] === '--')) index += 1;
  return program(words[index] === undefined ? '' : words[index]) ? index : -1;
}

/**
 * The words after a command-position `codegraph` program, or undefined when the segment
 * runs something else. Every invocation is the program's — the card's detail is the
 * command it ran — so a flag-only call and an unreadable subcommand are the program too.
 */
function codeGraphCommandWords(segment) {
  const words = shellWords(segment);
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] === undefined ? '' : words[index])) index += 1;
  const at = codeGraphProgramIndex(words, index);
  return at < 0 ? undefined : words.slice(at + 1);
}

function isReadOnlyInspection(segment, hidden = hasHiddenSubstitution(segment)) {
  return !writesFile(segment)
    && !hidden
    && (matchesAny(EXPLORING_COMMANDS, segment) || isGhApiRead(segment) || isGoEnvRead(segment));
}

// The splitter follows `$(...)` but not backticks or `<(...)`, so a command hidden in
// one of those never reaches this classifier; `>(...)` is already a file write. A
// segment carrying one is ambiguous rather than inspection.
const HIDDEN_SUBSTITUTION = /`|<\(/;

// A heredoc hands its body to the program as data, so the body is no part of the text the
// shell acts on: a quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) keeps it inert, and an
// unquoted one lets the shell expand `$(...)` and backticks inside it.
const HEREDOC_HEADER = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|(\\?)([A-Za-z_][\w.-]*))/;

/**
 * A segment split into the text the shell acts on and the heredoc bodies it hands to a
 * program. A heredoc this reader cannot delimit stays where it is, so what it cannot read
 * is never dropped from the text.
 */
function splitHeredocs(segment) {
  if (!segment.includes('<<')) return { text: segment, bodies: [] };
  let text = '';
  const bodies = [];
  let quote;
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    if (quote === "'") {
      text += char;
      if (char === "'") quote = undefined;
    } else if (char === '\\') {
      text += char + (segment[i + 1] === undefined ? '' : segment[i + 1]);
      i += 1;
    } else if (quote === '"') {
      text += char;
      if (char === '"') quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
      text += char;
    } else if (char === '<' && segment[i + 1] === '<' && segment[i + 2] !== '<') {
      const end = heredocEnd(segment, i);
      const header = HEREDOC_HEADER.exec(segment.slice(i));
      const newline = header === null ? -1 : segment.indexOf('\n', i + header[0].length);
      if (end === undefined || header === null || newline < 0 || newline >= end) {
        text += char;
      } else {
        text += segment.slice(i, newline);
        bodies.push({ text: segment.slice(newline, end), expanding: header[2] === undefined && header[3] === undefined && header[4] === '' });
        i = end - 1;
      }
    } else {
      text += char;
    }
  }
  return { text, bodies };
}

/** The text with every single-quoted span blanked: nothing inside one is ever expanded. */
function blankSingleQuotes(text) {
  let out = '';
  let quote;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
        out += char;
      }
    } else if (char === '\\') {
      out += char + (text[i + 1] === undefined ? '' : text[i + 1]);
      i += 1;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      out += char;
    } else {
      if (char === "'" || char === '"') quote = char;
      out += char;
    }
  }
  return out;
}

/** The text of a segment the shell acts on, without the data its heredocs hand over. */
function commandText(segment) {
  return splitHeredocs(segment).text;
}

/**
 * Whether a segment carries a command this reader cannot follow: a backtick or `<(...)` in
 * the text, or a substitution inside the body of a heredoc whose delimiter is unquoted.
 */
function hasHiddenSubstitution(segment) {
  const { text, bodies } = splitHeredocs(segment);
  return HIDDEN_SUBSTITUTION.test(blankSingleQuotes(text).replace(/\\[\s\S]/g, '  ')) || bodies.some((body) => body.expanding && /`|\$\(/.test(body.text.replace(/\\[\s\S]/g, '  ')));
}

/** `gh api` without a method, field, or input body reads; with one it writes. */
function isGhApiRead(segment) {
  const words = segment.split(/\s+/);
  if (words[0] !== 'gh' || words[1] !== 'api') return false;
  return !words.slice(2).some((word) => GH_API_WRITE_FLAGS.has(word.split('=')[0] === undefined ? '' : word.split('=')[0]) || /^-[XfF]./.test(word));
}

/**
 * The other half of that reading: the `gh api` call that writes creates or moves something
 * on the remote, so it publishes. A method the call spells out decides by itself — `-X GET`
 * is the same query without the flag, quoted or not, and no field riding beside it proves a
 * payload — while a field or an input body that CARRIES one is the payload a write sends,
 * glued to its flag (`-fkey=value`) or written after it. A header's value is that header's,
 * never a flag of its own.
 */
function isGhApiWrite(segment) {
  const words = shellWords(segment);
  if (words[0] !== 'gh' || words[1] !== 'api') return false;
  let method;
  let payload = false;
  for (let index = 2; index < words.length; index += 1) {
    const word = words[index] === undefined ? '' : words[index];
    const equals = word.indexOf('=');
    const flag = equals < 0 ? word : word.slice(0, equals);
    const attached = equals < 0 ? undefined : word.slice(equals + 1);
    // The method is attached in `-XPOST`/`--method=PUT` and the next word otherwise; the
    // shell dropped any quoting, so `-X "GET"` and `--method='HEAD'` are the reads they spell.
    const gluedMethod = /^-X./.exec(word);
    if (flag === '-X' || flag === '--method' || gluedMethod !== null) {
      // `-XPOST` and `--method=PUT` carry the value; `-X POST` writes it as the next word.
      let value = word.slice(2);
      if (gluedMethod === null) {
        value = attached === undefined ? words[index + 1] : attached;
        if (attached === undefined) index += 1;
      }
      if (value !== undefined && value !== '') method = value;
      continue;
    }
    // A header's value is not a flag this call passes: `-H "X: -filename"` sends a header.
    if (flag === '-H' || flag === '--header' || /^-H./.test(word)) {
      if (attached === undefined && !/^-H./.test(word)) index += 1;
      continue;
    }
    if (!GH_API_WRITE_FLAGS.has(flag) && !/^-[fF]/.test(word)) continue;
    // A field flag with no value hands the remote no payload at all.
    const value = attached === undefined ? words[index + 1] : attached;
    if (attached === undefined) index += 1;
    if (value !== undefined && value !== '') payload = true;
  }
  // A method that reads says so whatever rides beside it; a payload with no method writes.
  return method === undefined ? payload : !/^(GET|HEAD)$/i.test(method);
}

/**
 * `go env` reports the Go configuration, but `-w` stores a value in the env config file
 * and `-u` unsets one: both write, so neither is inspection.
 */
function isGoEnvRead(segment) {
  const words = segment.split(/\s+/);
  if (words[0] !== 'go' || words[1] !== 'env') return false;
  return !words.slice(2).some((word) => /^-[wu]$/.test(word));
}

// Stream merges and discarded output; neither writes a file.
const HARMLESS_REDIRECTS = /\s*(\d?>&\d|&?\d?>\s*\/dev\/null)/g;

// Output redirection to a file is a write. A `>` inside a quoted span is the program's
// own argument (`git commit -m "a > b"`, `git log --format="%h > %s"`), never a
// redirect, so only the text the shell would act on counts. Deliberately naive beyond
// that: an unbalanced quote keeps its `>`, which only ever leaves the call unnamed.
function writesFile(segment) {
  return unquotedSegment(commandText(segment)).replace(HARMLESS_REDIRECTS, '').includes('>');
}

/**
 * The text without its redirections into files, or `undefined` when one is not a plain
 * `> target`: a process substitution (`>(...)`) runs a command, and a redirect with no
 * target is a command this reader cannot follow.
 */
function withoutFileRedirects(text) {
  let out = '';
  let quote;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      out += char;
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"') {
        out += text[i + 1] === undefined ? '' : text[i + 1];
        i += 1;
      }
    } else if (char === '\\') {
      out += char + (text[i + 1] === undefined ? '' : text[i + 1]);
      i += 1;
    } else if (char === "'" || char === '"') {
      quote = char;
      out += char;
    } else if (char === '>') {
      if (text[i + 1] === '(') return undefined;
      let at = i + 1;
      if (text[at] === '>' || text[at] === '|' || text[at] === '&') at += 1;
      while (text[at] === ' ' || text[at] === '\t') at += 1;
      const target = /^("[^"]*"|'[^']*'|[^\s;|&<>()]+)/.exec(text.slice(at));
      if (target === null) return undefined;
      i = at + target[0].length - 1;
      // The file descriptor or `&` written right before the operator belongs to it.
      out = out.replace(/(^|\s)\d*&?$/, '$1');
    } else {
      out += char;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

function matchesAny(patterns, segment) {
  return patterns.some((pattern) => pattern.test(segment));
}

module.exports = {
  SHELL_ACTIVITIES,
  SHELL_ACTIVITY_IDENTITY,
  inferBashActivity,
  isCodegraphCommand,
  shellCommandSegments,
};
