'use strict';
// S2 / S3 / S4 (T3): the DESTRUCTIVE evidence behind the bash card's `⚠ destructive`
// heading — the reader ported from the user's own gentle-shell branch
// (`cards-bash-v2`, `lib/destructive-card-activity.ts` plus the pure recognizer it
// reuses from `lib/destructive-command-guard.ts`, read read-only).
//
// This module is PRESENTATION evidence and nothing else: it decides the mark and the
// word one card heads with, and no permission, guard or execution decision in this
// package may ever read it. The rule it implements is the one a database client
// forces on any reader: a client is fed its statements through a pipe or a heredoc,
// so the WHOLE command has to be read to prove what it deletes — and anything this
// reader cannot prove answers "not proven", never "probably safe". Every "false"
// below therefore means "no evidence", which is what lets the call keep whatever
// other identity it has (or the generic `$ bash` card).
//
// Public surface only: the three exported readers. Nothing here spawns a process,
// reaches the network or touches a file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isDestructiveCommand, isDestructiveSegment, isSqlClientSegment } = require('../lib/bash-destructive.js');

// A statement a client is asked to run is data loss when it drops, truncates, or
// deletes everything: a `DELETE` with a clause that picks rows, and a read, prove
// nothing — so they are not evidence, and the card keeps its other identity.
test('a write payload is proven while a read or a scoped delete is not', () => {
	for (const segment of [
		`psql -c 'DROP TABLE users'`,
		`psql -c "TRUNCATE TABLE logs"`,
		`mysql -e 'DROP DATABASE app'`,
		`sqlite3 app.db 'DROP TABLE t'`,
		`psql -c 'DELETE FROM t'`,
		`psql -c 'DELETE FROM t WHERE 1 = 1'`,
	]) {
		assert.equal(isDestructiveSegment(segment), true, segment);
	}
	for (const segment of [
		`psql -c 'SELECT 1'`,
		`psql -c 'SELECT * FROM users ORDER BY id'`,
		`psql -c 'DELETE FROM t WHERE id = 1'`,
		'psql',
	]) {
		assert.equal(isDestructiveSegment(segment), false, segment);
	}
});

// The distinction the family exists for: the client's own segment states none of its
// statements, so only the whole command proves the deletion — and the whole command
// is what the card reads before it decides.
test('only the whole command proves what a client is fed', () => {
	for (const command of [
		`echo 'DROP TABLE t' | psql`,
		`printf '%s' 'DROP TABLE t' | psql`,
		"psql <<'SQL'\nDROP TABLE t;\nSQL",
	]) {
		assert.equal(isDestructiveCommand(command), true, command);
	}
	// What a program reads from a file it never shows is not evidence, so the client
	// behind a `cat` proves nothing — the call keeps whatever else it can name.
	assert.equal(isDestructiveCommand(`cat schema.sql | psql`), false);
	// The client's own segment is a database client and nothing more: a reader that
	// looked at it alone would file the deletion as a plain, unnamed shell command.
	assert.equal(isSqlClientSegment('psql'), true);
	assert.equal(isSqlClientSegment('psql -c \'SELECT 1\''), true);
	assert.equal(isDestructiveSegment('psql'), false);
	// The pipe carries the proof; the payload on its own is prose the shell prints.
	assert.equal(isDestructiveCommand(`echo 'DROP TABLE t'`), false);
	assert.equal(isDestructiveCommand(`psql -c 'SELECT 1'`), false);
	// Prose that merely names a client is not a client.
	assert.equal(isSqlClientSegment(`echo psql`), false);
	assert.equal(isSqlClientSegment('node psql.js'), false);
});

// "Not proven" is the answer wherever this reader cannot see the payload: an unknown
// wrapper, a client reading a file it never shows, a script of its own, a parameter
// that expands to a statement. None of them is "safe" — they are simply no evidence,
// and nothing here may be read as a permission verdict either way.
test('an unprovable payload answers no evidence rather than "probably safe"', () => {
	for (const segment of ['xargs rm -rf', './scripts/clean.sh --all', 'psql -f drop.sql', 'psql -c "$STMT"']) {
		assert.equal(isDestructiveSegment(segment), false, segment);
	}
	for (const command of ['cat drop.sql | psql', 'psql -f drop.sql', 'psql -c "$STMT"']) {
		assert.equal(isDestructiveCommand(command), false, command);
	}
});

// Only a command-position word names a program, so prose a program merely receives is
// never a deletion — including the text of a commit message and a grep pattern.
test('quoted prose is never read as a deletion', () => {
	for (const segment of [
		`echo 'rm -rf /'`,
		`printf 'git reset --hard'`,
		`git commit -m "rm -rf /tmp"`,
		`grep -rn 'DROP TABLE' docs`,
		`echo 'DROP TABLE t'`,
	]) {
		assert.equal(isDestructiveSegment(segment), false, segment);
		assert.equal(isDestructiveCommand(segment), false, segment);
	}
});

// A program whose name is an inherited member of a lookup table, and an argument that
// is not a command line at all, must answer "no evidence" instead of throwing: the
// classifier runs synchronously on every bash row the host repaints.
test('hazardous and malformed input never throws', () => {
	for (const segment of ['constructor -rf dist', '__proto__ rm -rf dist', 'toString -rf dist', 'hasOwnProperty -rf dist']) {
		assert.equal(isDestructiveSegment(segment), false, segment);
		assert.equal(isDestructiveCommand(segment), false, segment);
		assert.equal(isSqlClientSegment(segment), false, segment);
	}
	for (const value of [undefined, null, 42, {}, []]) {
		assert.equal(isDestructiveSegment(value), false, String(value));
		assert.equal(isDestructiveCommand(value), false, String(value));
		assert.equal(isSqlClientSegment(value), false, String(value));
	}
});
