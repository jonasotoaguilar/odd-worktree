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
 * function counts it as one, so a single space after it is painted inside the glyph's
 * own second cell and the heading reads `⚒preparing`. Preparing's mark therefore ends
 * in one space — the minimum that still shows a column — so the heading's counted
 * width matches what the terminal paints.
 */
const SHELL_ACTIVITY_IDENTITY = {
  // The error role is the one slot that reads as a warning in every shipped theme,
  // and U+26A0 is the mark a reader recognizes before expanding the row.
  destructive: { glyph: '⚠', titleRole: 'error' },
  checking: { glyph: '✓', titleRole: 'mdHeading' },
  formatting: { glyph: '≋', titleRole: 'syntaxFunction' },
  preparing: { glyph: '⚒ ', titleRole: 'syntaxFunction' },
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
  /^go\s+(test|build|vet)\b/,
  /^cargo\s+(test|build|check|clippy|nextest)\b/,
  // `cargo fmt` rewrites code, so only the check form verifies anything.
  /^cargo\s+fmt\b.*\s--check\b/,
  /^ruff\s+format\s+--check\b/,
  /^deno\s+(test|check)\b/,
  /^deno\s+fmt\s+--check\b/,
  /^deno\s+task\s+(test|typecheck|lint|build|check)\b/,
  // eslint verifies work whatever write flag it carries, quoted or not.
  /^((npx|pnpx|bunx)\s+|(pnpm|yarn|npm)\s+(exec|run)\s+)?eslint\b/,
  // Waiting on or reading CI results verifies work; it is not exploration.
  /^gh\s+pr\s+checks\b/,
  /^gh\s+run\s+(view|watch|list)\b/,
];

// These runners verify only when they are not asked to rewrite files: `ruff check
// --fix` and `deno lint --fix` repair code, so they are not checks. The flag is the
// one the shell passes, so a quoted `--fix` counts too, while `--fix-dry-run` writes
// nothing and stays a check.
const FIXABLE_CHECKING_COMMANDS = [/^ruff\s+check\b/, /^deno\s+lint\b/];
const FIX_FLAGS = new Set(['--fix', '--fix-only', '--unsafe-fixes']);

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
const CHECK_SCRIPTS = new Set(['test', 'typecheck', 'lint', 'build', 'check']);
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
  /^(brew|port)\s+install\b/,
  /^(apt|apt-get|dnf|yum|zypper)\s+(install|add)\b/,
  /^apk\s+add\b/,
  /^pacman\s+-S\b/,
  /^go\s+(get|install|mod\s+download)\b/,
  /^cargo\s+(install|fetch|new|init)\b/,
  /^dotnet\s+(restore|add)\b/,
  // A repository, a directory or a file the call creates.
  /^git\s+(init|clone)\b/,
  /^(mkdir|touch|cp|ln)\b/,
  // Configuration the call stores on this machine. A read is inspection and is matched
  // before this family; a key deletion is not preparation either.
  /^git\s+config\s+[^-\s]+\s+\S/,
  /^(pip|pip3)\s+config\s+set\b/,
  /^go\s+env\s+-w\b/,
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
  // A stack's local half creates and rebases branches; it publishes nothing.
  /^gh\s+stack\s+(init|add|rebase)\b/,
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
  /^(ls|cat|head|tail|grep|egrep|rg|wc|pwd|tree|stat|file|which|type|readlink|realpath|dirname|basename|cut|uniq|tr|nl|column|strings|diff|cmp|od|xxd|hexdump|shasum|sha256sum|md5|md5sum|du|df|date|uname|whoami|ps|pgrep|lsof|jq|awk)\b/,
  /^command\s+-v\b/,
  /^(\[\[?|test)\s/,
  /^sort\b(?!.*\s(-o|--output)\b)/,
  /^sed\b(?!.*\s(-[a-zA-Z]*i|--in-place)\b)/,
  /^find\b(?!.*\s-(delete|exec|execdir|ok|okdir|fprint\w*)\b)/,
];

// Segments that neither inspect nor change anything worth labeling: shell control
// words, no-op builtins, and bare variable assignments (their command substitutions
// are classified as commands of their own).
const NEUTRAL_COMMANDS = [
  /^(cd|pushd|popd|echo|printf|sleep|true|false|export|set)\b/,
  /^(done|fi|esac|\}|\))$/,
  /^for\s+\w+(\s+in\b.*)?$/,
  // Each assignment must end at whitespace or the end: an optional separator would let
  // `a=a=a=…` split anywhere and backtrack exponentially.
  /^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s"'])*(\s+|$))+$/,
];

// Shell keywords that prefix the command they introduce (`do grep x`).
const LEADING_KEYWORDS = /^(do|then|else|elif|if|while|until|time|!|\{|\()\s+/;

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
  // A segment nothing can name keeps the whole card generic, so the heading never hides
  // the work the call also did silently — unless the call runs CodeGraph, whose card
  // names the command itself whichever company it keeps.
  if (!runsCodeGraph && activities.some((activity, index) => activity === undefined && sqlPayload[index] !== true)) return undefined;
  // A deletion outranks every other identity on the same call: it is the one
  // consequence a reader cannot undo, so a check beside it never takes the card.
  if (activities.includes('destructive') || deletesData) return 'destructive';
  // A call that also runs CodeGraph is CodeGraph's card: the command is its detail, so
  // a check or a build beside it never takes the row.
  if (runsCodeGraph) return 'codegraph';
  if (activities.includes('checking')) return 'checking';
  if (activities.includes('publishing')) return 'publishing';
  if (activities.includes('versioning')) return 'versioning';
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

/** The `<<` a segment opens, and the delimiter whose own line ends the body it starts. */
const HEREDOC_HEADER = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/;

/**
 * Which segments a deletion the whole command proves already names: a database client
 * and the heredoc body it reads, which the segmenter splits into the lines the body's
 * own newlines delimit. The statements themselves are data, not commands, so nothing
 * can name them on their own — and nothing else may be excused from the undefined scan.
 */
function sqlPayloadCoverage(segments) {
  const covered = [];
  let body;
  for (const [index, segment] of segments.entries()) {
    if (body !== undefined) {
      covered[index] = true;
      if (segment === body) body = undefined;
      continue;
    }
    covered[index] = isSqlClientSegment(segment);
    if (covered[index]) {
      const header = HEREDOC_HEADER.exec(segment);
      body = header === null ? undefined : header[2];
    }
  }
  return covered;
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
  if (isCheckingSegment(segment)) return 'checking';
  if (isFormattingSegment(segment)) return 'formatting';
  if (isReadOnlyInspection(segment)) return 'exploring';
  // A segment whose payload this classifier cannot read, or that redirects its output
  // into a file, is a write it cannot name.
  if (HIDDEN_SUBSTITUTION.test(segment) || writesFile(segment)) return undefined;
  if (isPreparingSegment(segment)) return 'preparing';
  if (matchesAny(VERSIONING_COMMANDS, segment)) return 'versioning';
  if (matchesAny(PUBLISHING_COMMANDS, segment)) return 'publishing';
  if (codeGraphCommandWords(segment) !== undefined) return 'codegraph';
  return undefined;
}

/**
 * Whether a segment asks a known program for its own usage page: a request, a flag the
 * segment's own text merely mentions or an option consumed, or an unreadable one this
 * classifier refuses to guess about.
 */
function helpFlag(segment) {
  const words = shellWordTokens(segment);
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
  if (!HELP_AWARE_COMMANDS.has(program === undefined ? '' : program)) return 'unreadable';
  // `node -e '…' --help` runs the payload with `--help` as its own argument.
  if (SCRIPT_RUNNERS.has(program) && words.slice(1).some((word) => PAYLOAD_FLAGS.has(word.text))) return 'unreadable';
  if (writesFile(segment) || HIDDEN_SUBSTITUTION.test(segment)) return 'unreadable';
  return 'request';
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
  return script !== undefined && isCheckScript(script);
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
 * under a namespace, so a `:` suffix keeps its base script's meaning.
 */
function isCheckScript(word) {
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
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
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
    } else if (isSeparator(command, i)) {
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

// Drops harmless redirections (`2>&1`, `2>/dev/null`), leading shell keywords
// (`do grep x`), environment assignments (`CI=1 pnpm test`), git global options
// (`git -C dir status`), and whitespace. A bare assignment is left intact for
// NEUTRAL_COMMANDS.
function stripSegment(segment) {
  let stripped = segment.replace(HARMLESS_REDIRECTS, '').trim();
  while (LEADING_KEYWORDS.test(stripped)) stripped = stripped.replace(LEADING_KEYWORDS, '');
  return stripped
    .replace(/^([A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s"'])*\s+)+(?=\S)/, '')
    .replace(/^git\s+((-C|-c)\s+\S+\s+|--no-pager\s+)+/, 'git ');
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

function isReadOnlyInspection(segment) {
  return !writesFile(segment)
    && !HIDDEN_SUBSTITUTION.test(segment)
    && (matchesAny(EXPLORING_COMMANDS, segment) || isGhApiRead(segment) || isGoEnvRead(segment));
}

// The splitter follows `$(...)` but not backticks or `<(...)`, so a command hidden in
// one of those never reaches this classifier; `>(...)` is already a file write. A
// segment carrying one is ambiguous rather than inspection.
const HIDDEN_SUBSTITUTION = /`|<\(/;

/** `gh api` without a method, field, or input body reads; with one it writes. */
function isGhApiRead(segment) {
  const words = segment.split(/\s+/);
  if (words[0] !== 'gh' || words[1] !== 'api') return false;
  return !words.slice(2).some((word) => GH_API_WRITE_FLAGS.has(word.split('=')[0] === undefined ? '' : word.split('=')[0]) || /^-[XfF]./.test(word));
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
  return unquotedSegment(segment).replace(HARMLESS_REDIRECTS, '').includes('>');
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
