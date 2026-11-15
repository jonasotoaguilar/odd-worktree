'use strict';
// S10: the CodeGraph output shapes the card's collapsed rows are decided from.
//
// Every string here is a row the real binary printed (codegraph 1.6.0, the
// `@clack/prompts` chrome it paints its progress in) in a fresh temporary Git
// repository, or the same shape its MCP `codegraph_explore` handler answers
// with. Nothing reads a repository, an index or a terminal: the preview is a
// pure function of the operation, the command and the output retained here, so
// the fixtures are plain strings and this file spawns nothing.

/** A fresh `codegraph init -y`: its progress box and the sentence it ends with. */
const INIT_FRESH = [
  '┌  Initializing CodeGraph',
  '│',
  '◆  Initialized in /tmp/ws',
  '│',
  'Scanning files...',
  'Parsing code...',
  '│',
  '◆  Indexed 1 files',
  '│',
  '●  3 nodes, 2 edges in 208ms',
  '│',
  '└  Done',
  '',
].join('\n');

/** `codegraph init -y` on a workspace that already has an index. */
const INIT_EXISTING = [
  '┌  Initializing CodeGraph',
  '│',
  '▲  Already initialized in /tmp/ws',
  '│',
  '●  Use "codegraph index" to re-index or "codegraph sync" to update',
  '│',
  '└  ',
].join('\n');

/** An init log with facts but no concluding sentence. */
const INIT_FACTS = [
  '┌  Initializing CodeGraph',
  'Scanning files...',
  '◆  Indexed 2 files',
  '●  5 nodes, 7 edges in 239ms',
  '└  Done',
].join('\n');

/** A failed init: the reason it printed, and the instruction that follows it. */
const INIT_FAILED = [
  '┌  Initializing CodeGraph',
  '✗  Failed: EACCES: permission denied, open /tmp/ws/.codegraph/codegraph.db',
  '●  Move or delete that file, then run "codegraph init" again.',
  '└  ',
].join('\n');

/** `codegraph sync`: the files it re-read, and the nodes it updated. */
const SYNC_CHANGED = [
  '┌  Syncing CodeGraph',
  '│',
  '◆  Synced 3 changed files',
  '●  Added: 1, Modified: 2 — 10 nodes in 123ms',
  '│',
  '└  Done',
].join('\n');

/** `codegraph sync` on a workspace where nothing changed. */
const SYNC_UP_TO_DATE = ['┌  Syncing CodeGraph', '│', '●  Already up to date', '│', '└  Done'].join('\n');

/** `codegraph sync` on a workspace whose index a newer engine wrote. */
const SYNC_NO_FILES = ['┌  Syncing CodeGraph', '│', '◆  Synced 1 changed files', '●  Added: 1, Modified: 0, Removed: 0 — 4 nodes in 88ms', '│', '└  Done'].join('\n');

/** A successful `codegraph query`: two entries, each symbol line plus its location. */
const QUERY = [
  'Search Results for "alpha":',
  '',
  'function    alpha',
  '  src/a.ts:1',
  '',
  'import      ./a.ts',
  '  src/b.ts:1',
].join('\n');

/** `codegraph query` with nothing to report. */
const QUERY_EMPTY = 'ℹ No results found for "zzz"';

/** The MCP `codegraph_explore` answer: its header sentence, then the source it sent. */
const EXPLORE = [
  '**Exploration: auth login**',
  '',
  'Found 2 symbols across 1 file.',
  '',
  '**`src/auth.ts`** — login(session)',
].join('\n');

/** The MCP explore header sentence with the further clause the handler may add. */
const EXPLORE_PINNED = '**Exploration: auth login**\n\nFound 1 symbol across 2 files. 1 file pinned from the query.';

module.exports = {
  EXPLORE,
  EXPLORE_PINNED,
  INIT_EXISTING,
  INIT_FACTS,
  INIT_FAILED,
  INIT_FRESH,
  QUERY,
  QUERY_EMPTY,
  SYNC_CHANGED,
  SYNC_NO_FILES,
  SYNC_UP_TO_DATE,
};
