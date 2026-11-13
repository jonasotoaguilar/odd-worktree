'use strict';
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const test = require('node:test');
const { after } = require('node:test');
const {
	createWorktreeMetadataRecord,
	currentWorktreeSetupStep,
	defaultWorktreeReconcileEnvironment,
	emptyWorktreeMetadataFile,
	emptyWorktreeSetup,
	isCanonicalWorktreePath,
	normalizeWorktreeMetadataRecord,
	parseWorktreeListPorcelain,
	readWorktreeAdminDirFromGit,
	readWorktreeMetadataStore,
	reconcileWorktrees,
	saveWorktreeMetadataRecords,
	serializeWorktreeMetadataFile,
	WORKTREE_GONE_REASONS,
	WORKTREE_HOOK_OUTCOMES,
	WORKTREE_METADATA_DIRECTORY,
	WORKTREE_METADATA_FILENAME,
	WORKTREE_METADATA_KIND,
	WORKTREE_METADATA_VERSION,
	WORKTREE_OBSERVED_STATUSES,
	WORKTREE_SETUP_STATE_DISPLAY,
	WORKTREE_SETUP_STATUSES,
	WORKTREE_STATE_IDS,
	WORKTREE_STATE_LABELS,
	WorktreeMetadataError,
	worktreeGoneDate,
	worktreeMetadataFilePath,
	worktreeStateForRecord,
	worktreeStateLabel,
} = require('../lib/worktree-metadata.js');

// The worktree metadata store: where the records of one clone live, how they are
// read and merged without losing what another session wrote, and how they are
// reconciled against what Git answers. Every assertion goes through the module's
// public interface: the bytes and records a write produces, the read result, and
// the joined view a reconciliation returns.

const root = mkdtempSync(join(tmpdir(), 'gentle-worktree-metadata-'));
after(() => {
	rmSync(root, { recursive: true, force: true });
});

let scratchCount = 0;
function scratch(name) {
	const directory = join(root, `${scratchCount++}-${name}`);
	mkdirSync(directory, { recursive: true });
	return directory;
}

const AT = '2026-01-02T03:04:05.000Z';
const LATER = '2026-02-03T04:05:06.000Z';
const EVEN_LATER = '2026-03-04T05:06:07.000Z';
const COMMON_DIR = '/clone/.git';

function recordFor(overrides = {}) {
	return {
		odd: 'worktree-tools',
		createdAt: AT,
		createdBy: 'session-1',
		adminId: 'worktree-tools',
		branchAtCreation: 'feat/worktree-tools',
		baseRef: 'main',
		hooks: [{ name: 'copy-inputs', status: 'applied', detail: '3 files' }],
		setup: {
			status: 'ready',
			steps: [{ command: 'pnpm install', status: 'ready', logPath: '/logs/setup.log', exitCode: 0, endedAt: AT }],
			jobId: 'job-1',
			command: 'pnpm install',
			logPath: '/logs/setup.log',
			exitCode: 0,
			endedAt: AT,
		},
		lastSeen: { at: AT, branch: 'feat/worktree-tools', status: 'active' },
		...overrides,
	};
}

function recordsOf(entries) {
	return Object.fromEntries(entries);
}

function fakeEnvironment(paths) {
	return {
		stat: (path) => (paths[path] && paths[path].present !== false ? 'present' : 'absent'),
		realpath: (path) => {
			const entry = paths[path];
			return entry && entry.present !== false ? entry.realPath ?? path : undefined;
		},
		adminDir: (path) => paths[path]?.adminDir,
	};
}

const now = () => new Date(LATER);

// ---- S7: the metadata file ----

test('stores records in <git-common-dir>/gentle-ai/worktrees.json as version 1', () => {
	const commonDir = scratch('clone');
	const storePath = worktreeMetadataFilePath(commonDir);
	assert.equal(storePath, join(commonDir, 'gentle-ai', 'worktrees.json'));
	const worktreePath = join(commonDir, 'worktrees', 'feature');

	const written = saveWorktreeMetadataRecords(storePath, recordsOf([[worktreePath, recordFor()]]));
	assert.equal(written.kind, WORKTREE_METADATA_KIND);
	assert.equal(written.version, WORKTREE_METADATA_VERSION);

	const raw = readFileSync(storePath, 'utf8');
	const stored = JSON.parse(raw);
	assert.deepEqual(Object.keys(stored), ['kind', 'version', 'records']);
	assert.deepEqual(Object.keys(stored.records), [worktreePath]);
	assert.deepEqual(Object.keys(stored.records[worktreePath]), [
		'odd',
		'createdAt',
		'createdBy',
		'adminId',
		'branchAtCreation',
		'baseRef',
		'hooks',
		'setup',
		'lastSeen',
	]);
	assert.ok(raw.endsWith('\n'), 'the file ends with a newline');

	const round = readWorktreeMetadataStore(storePath);
	assert.equal(round.status, 'valid');
	if (round.status !== 'valid') return;
	assert.deepEqual(round.file.records[worktreePath], recordFor());
	assert.deepEqual(round.drops, []);
	assert.deepEqual(readdirSync(dirname(storePath)).filter((entry) => entry.includes('.tmp')), []);
});

test('reads a missing metadata file as missing and starts an empty file on the first write', () => {
	const storePath = worktreeMetadataFilePath(scratch('missing-store'));
	assert.deepEqual(readWorktreeMetadataStore(storePath), { status: 'missing' });

	const written = saveWorktreeMetadataRecords(storePath, recordsOf([[join(root, 'first-worktree'), recordFor()]]));
	assert.deepEqual(Object.keys(written.records), [join(root, 'first-worktree')]);
});

test('reads corrupt JSON as unreadable and refuses to overwrite it', () => {
	const storePath = worktreeMetadataFilePath(scratch('corrupt-store'));
	mkdirSync(dirname(storePath), { recursive: true });
	const bytes = '{ this is not json\n';
	writeFileSync(storePath, bytes);

	assert.equal(readWorktreeMetadataStore(storePath).status, 'unreadable');
	assert.throws(
		() => saveWorktreeMetadataRecords(storePath, recordsOf([[join(root, 'any-worktree'), recordFor()]])),
		(error) => error instanceof WorktreeMetadataError && error.code === 'unreadable-store',
	);
	assert.equal(readFileSync(storePath, 'utf8'), bytes);
});

test('reads an unknown future version as unsupported and refuses to overwrite it', () => {
	const storePath = worktreeMetadataFilePath(scratch('future-store'));
	mkdirSync(dirname(storePath), { recursive: true });
	const bytes = `${JSON.stringify({
		kind: WORKTREE_METADATA_KIND,
		version: WORKTREE_METADATA_VERSION + 1,
		records: { '/future/worktree': { odd: 'future' } },
	}, null, 2)}\n`;
	writeFileSync(storePath, bytes);

	const result = readWorktreeMetadataStore(storePath);
	assert.equal(result.status, 'unsupported');
	if (result.status !== 'unsupported') return;
	assert.equal(result.version, WORKTREE_METADATA_VERSION + 1);
	assert.throws(
		() => saveWorktreeMetadataRecords(storePath, recordsOf([[join(root, 'any-worktree'), recordFor()]])),
		(error) => error instanceof WorktreeMetadataError && error.code === 'unsupported-store',
	);
	assert.equal(readFileSync(storePath, 'utf8'), bytes);
});

test('drops a record this version cannot decode, reports it, and refuses to write over it', () => {
	const storePath = worktreeMetadataFilePath(scratch('partial-store'));
	mkdirSync(dirname(storePath), { recursive: true });
	const bytes = `${JSON.stringify({
		kind: WORKTREE_METADATA_KIND,
		version: WORKTREE_METADATA_VERSION,
		records: {
			'/clone/worktrees/known': recordFor(),
			'/clone/worktrees/unknown-shape': { odd: 'only-an-odd' },
			'relative/key': recordFor(),
		},
	}, null, 2)}\n`;
	writeFileSync(storePath, bytes);

	const result = readWorktreeMetadataStore(storePath);
	assert.equal(result.status, 'valid');
	if (result.status !== 'valid') return;
	assert.deepEqual(Object.keys(result.file.records), ['/clone/worktrees/known']);
	assert.deepEqual(result.drops.map((drop) => drop.path), ['/clone/worktrees/unknown-shape', 'relative/key']);
	assert.throws(
		() => saveWorktreeMetadataRecords(storePath, recordsOf([[join(root, 'any-worktree'), recordFor()]])),
		(error) => error instanceof WorktreeMetadataError && error.code === 'undecodable-store',
	);
	assert.equal(readFileSync(storePath, 'utf8'), bytes);
});

test('re-reads before writing, so a record another session added between reads survives', () => {
	const storePath = worktreeMetadataFilePath(scratch('merge-store'));
	const first = join(root, 'merge-first');
	const second = join(root, 'merge-second');
	const third = join(root, 'merge-third');
	saveWorktreeMetadataRecords(storePath, recordsOf([[first, recordFor({ odd: 'first' })]]));

	// Another worktree or session writes its own record before our next write.
	const external = JSON.parse(readFileSync(storePath, 'utf8'));
	external.records[second] = recordFor({ odd: 'second' });
	writeFileSync(storePath, `${JSON.stringify(external, null, 2)}\n`);

	saveWorktreeMetadataRecords(storePath, recordsOf([[third, recordFor({ odd: 'third' })]]));
	const stored = JSON.parse(readFileSync(storePath, 'utf8'));
	assert.deepEqual(Object.keys(stored.records).sort(), [first, second, third].sort());
	assert.equal(stored.records[second].odd, 'second');
});

test('replaces the record stored for the same path instead of appending a second one', () => {
	const storePath = worktreeMetadataFilePath(scratch('replace-store'));
	const worktreePath = join(root, 'replace-worktree');
	saveWorktreeMetadataRecords(storePath, recordsOf([[worktreePath, recordFor({ odd: 'before' })]]));
	saveWorktreeMetadataRecords(storePath, recordsOf([[worktreePath, recordFor({ odd: 'after' })]]));

	const stored = JSON.parse(readFileSync(storePath, 'utf8'));
	assert.deepEqual(Object.keys(stored.records), [worktreePath]);
	assert.equal(stored.records[worktreePath].odd, 'after');
});

// ---- S4: one shared file, and the registry's `worktrees` array is not ours ----

// Rows shaped exactly as lib/worktree-registry.js writes them: the sibling owner's
// data, which this module must neither validate nor rewrite.
const REGISTRY_ROWS = [
	{
		branch: 'main',
		path: '/clone',
		thread: 'principal',
		issues: [],
		odd: null,
		registeredAt: AT,
		updatedAt: AT,
	},
	{
		branch: 'feat/worktree-tools',
		path: '/clone-worktrees/worktree-tools',
		thread: 'worktree-tools',
		issues: [12, 15],
		odd: 'odd/tasks/worktree-tools.md',
		createdAt: AT,
		updatedAt: LATER,
	},
];

test('reads the shared file as an empty store when it only carries the registry worktrees array', () => {
	for (const document of [
		{ version: WORKTREE_METADATA_VERSION, worktrees: REGISTRY_ROWS },
		{ kind: WORKTREE_METADATA_KIND, version: WORKTREE_METADATA_VERSION, worktrees: REGISTRY_ROWS },
	]) {
		const storePath = worktreeMetadataFilePath(scratch('shared-empty-store'));
		mkdirSync(dirname(storePath), { recursive: true });
		writeFileSync(storePath, `${JSON.stringify(document, null, 2)}\n`);

		const result = readWorktreeMetadataStore(storePath);
		assert.equal(result.status, 'valid');
		if (result.status !== 'valid') return;
		assert.deepEqual(result.file.records, {});
		assert.deepEqual(result.file.worktrees, REGISTRY_ROWS);
		assert.deepEqual(result.drops, []);
	}
});

test('adds only records to the shared file and carries the worktrees array through unchanged', () => {
	const storePath = worktreeMetadataFilePath(scratch('shared-write-store'));
	mkdirSync(dirname(storePath), { recursive: true });
	writeFileSync(storePath, `${JSON.stringify({ version: WORKTREE_METADATA_VERSION, worktrees: REGISTRY_ROWS }, null, 2)}\n`);

	const worktreePath = join(root, 'shared-worktree');
	saveWorktreeMetadataRecords(storePath, recordsOf([[worktreePath, recordFor()]]));

	const raw = readFileSync(storePath, 'utf8');
	const stored = JSON.parse(raw);
	assert.equal(stored.kind, WORKTREE_METADATA_KIND);
	assert.equal(stored.version, WORKTREE_METADATA_VERSION);
	assert.deepEqual(Object.keys(stored.records), [worktreePath]);
	assert.deepEqual(stored.records[worktreePath], recordFor());
	assert.deepEqual(stored.worktrees, REGISTRY_ROWS);
	assert.equal(JSON.stringify(stored.worktrees), JSON.stringify(REGISTRY_ROWS), 'the array is carried byte for byte');
	assert.ok(raw.endsWith('\n'));
	assert.deepEqual(readdirSync(dirname(storePath)).filter((entry) => entry.includes('.tmp')), []);
});

test('keeps the worktrees array when records already exist, and a read-serialize round trip is byte-identical', () => {
	const storePath = worktreeMetadataFilePath(scratch('shared-round-trip'));
	mkdirSync(dirname(storePath), { recursive: true });
	const worktreePath = join(root, 'shared-round-trip-worktree');
	const document = {
		kind: WORKTREE_METADATA_KIND,
		version: WORKTREE_METADATA_VERSION,
		worktrees: REGISTRY_ROWS,
		records: { [worktreePath]: recordFor() },
	};
	const bytes = serializeWorktreeMetadataFile(document);
	writeFileSync(storePath, bytes);

	const result = readWorktreeMetadataStore(storePath);
	assert.equal(result.status, 'valid');
	if (result.status !== 'valid') return;
	assert.deepEqual(result.file.worktrees, REGISTRY_ROWS);
	assert.equal(serializeWorktreeMetadataFile(result.file), bytes, 'an untouched shared file serializes back to the same bytes');

	const second = join(root, 'shared-round-trip-second');
	saveWorktreeMetadataRecords(storePath, recordsOf([[second, recordFor({ odd: 'second' })]]));
	const stored = JSON.parse(readFileSync(storePath, 'utf8'));
	assert.deepEqual(Object.keys(stored.records).sort(), [worktreePath, second].sort());
	assert.deepEqual(stored.worktrees, REGISTRY_ROWS);
});

test('still refuses a genuinely unknown top-level key beside the shared keys', () => {
	const storePath = worktreeMetadataFilePath(scratch('shared-unknown-key'));
	mkdirSync(dirname(storePath), { recursive: true });
	const bytes = `${JSON.stringify({
		version: WORKTREE_METADATA_VERSION,
		worktrees: REGISTRY_ROWS,
		records: {},
		sessions: [],
	}, null, 2)}\n`;
	writeFileSync(storePath, bytes);

	assert.deepEqual(readWorktreeMetadataStore(storePath), { status: 'unreadable', detail: 'unexpected top-level key: sessions' });
	assert.throws(
		() => saveWorktreeMetadataRecords(storePath, recordsOf([[join(root, 'any-worktree'), recordFor()]])),
		(error) => error instanceof WorktreeMetadataError && error.code === 'unreadable-store',
	);
	assert.equal(readFileSync(storePath, 'utf8'), bytes);
});

test('keeps refusing a document with neither the metadata kind nor the registry key', () => {
	const storePath = worktreeMetadataFilePath(scratch('foreign-document'));
	mkdirSync(dirname(storePath), { recursive: true });
	const bytes = `${JSON.stringify({ version: WORKTREE_METADATA_VERSION, records: {} }, null, 2)}\n`;
	writeFileSync(storePath, bytes);

	assert.equal(readWorktreeMetadataStore(storePath).status, 'unsupported');
	assert.throws(
		() => saveWorktreeMetadataRecords(storePath, recordsOf([[join(root, 'any-worktree'), recordFor()]])),
		(error) => error instanceof WorktreeMetadataError && error.code === 'unsupported-store',
	);
	assert.equal(readFileSync(storePath, 'utf8'), bytes);
});

test('rejects a key that is not a canonical absolute path and leaves the file byte-identical', () => {
	const storePath = worktreeMetadataFilePath(scratch('reject-store'));
	saveWorktreeMetadataRecords(storePath, recordsOf([[join(root, 'kept'), recordFor()]]));
	const bytes = readFileSync(storePath, 'utf8');
	const count = Object.keys(JSON.parse(bytes).records).length;

	for (const rejected of ['relative/path', `${join(root, 'trailing')}/`, '']) {
		assert.throws(
			() => saveWorktreeMetadataRecords(storePath, recordsOf([[rejected, recordFor()]])),
			(error) => error instanceof WorktreeMetadataError && error.code === 'invalid-record',
		);
	}
	assert.equal(readFileSync(storePath, 'utf8'), bytes);
	assert.equal(Object.keys(JSON.parse(readFileSync(storePath, 'utf8')).records).length, count);
});

test('rejects a record without a usable identity and leaves the file byte-identical', () => {
	const storePath = worktreeMetadataFilePath(scratch('reject-record-store'));
	saveWorktreeMetadataRecords(storePath, recordsOf([[join(root, 'kept'), recordFor()]]));
	const bytes = readFileSync(storePath, 'utf8');

	for (const record of [recordFor({ adminId: '' }), recordFor({ odd: '' }), recordFor({ setup: {} })]) {
		assert.throws(
			() => saveWorktreeMetadataRecords(storePath, recordsOf([[join(root, 'rejected'), record]])),
			(error) => error instanceof WorktreeMetadataError && error.code === 'invalid-record',
		);
	}
	assert.equal(readFileSync(storePath, 'utf8'), bytes);
});

// ---- S4: the ODD association is optional, its type is not ----

const oddlessRecord = () => {
	const { odd: _omitted, ...rest } = recordFor();
	return rest;
};

test('S4: a record with no odd key is accepted, normalized and stored without one', () => {
	const normalized = normalizeWorktreeMetadataRecord(oddlessRecord());
	assert.deepEqual(normalized, {
		createdAt: AT,
		createdBy: 'session-1',
		adminId: 'worktree-tools',
		branchAtCreation: 'feat/worktree-tools',
		baseRef: 'main',
		hooks: [{ name: 'copy-inputs', status: 'applied', detail: '3 files' }],
		setup: {
			status: 'ready',
			steps: [{ command: 'pnpm install', status: 'ready', logPath: '/logs/setup.log', exitCode: 0, endedAt: AT }],
			jobId: 'job-1',
			command: 'pnpm install',
			logPath: '/logs/setup.log',
			exitCode: 0,
			endedAt: AT,
		},
		lastSeen: { at: AT, branch: 'feat/worktree-tools', status: 'active' },
	});
	assert.equal('odd' in normalized, false, 'an absent odd stays absent when normalized');

	const storePath = join(scratch('oddless-store'), 'pi-worktrees.json');
	const worktreePath = join(root, 'oddless-worktree');
	saveWorktreeMetadataRecords(storePath, recordsOf([[worktreePath, oddlessRecord()]]));
	const stored = JSON.parse(readFileSync(storePath, 'utf8'));
	assert.deepEqual(Object.keys(stored.records[worktreePath]), [
		'createdAt',
		'createdBy',
		'adminId',
		'branchAtCreation',
		'baseRef',
		'hooks',
		'setup',
		'lastSeen',
	]);
	assert.equal(JSON.stringify(stored).includes('"odd"'), false, 'no null, no empty string and no dash is written');
});

test('S4: an empty odd is still refused as an invalid record', () => {
	const storePath = join(scratch('empty-odd-store'), 'pi-worktrees.json');
	saveWorktreeMetadataRecords(storePath, recordsOf([[join(root, 'kept'), recordFor()]]));
	const bytes = readFileSync(storePath, 'utf8');

	for (const odd of ['', '   ', 42, null, [], {}]) {
		assert.throws(
			() => saveWorktreeMetadataRecords(storePath, recordsOf([[join(root, 'empty-odd'), recordFor({ odd }) ]])),
			(error) => error instanceof WorktreeMetadataError
				&& error.code === 'invalid-record'
				&& error.message === `worktree metadata record for ${join(root, 'empty-odd')} is incomplete`,
			JSON.stringify(odd),
		);
	}
	assert.equal(readFileSync(storePath, 'utf8'), bytes, 'a refused record leaves the file byte-identical');
});

test('S4: a non-string odd is still refused as an invalid record', () => {
	const storePath = join(scratch('typed-odd-store'), 'pi-worktrees.json');
	for (const odd of [42, true, {}, [], ['odd/tasks/a.md']]) {
		assert.throws(
			() => saveWorktreeMetadataRecords(storePath, recordsOf([[join(root, 'typed-odd'), recordFor({ odd }) ]])),
			(error) => error instanceof WorktreeMetadataError && error.code === 'invalid-record',
			JSON.stringify(odd),
		);
	}
});

test('S4: an odd-less record round-trips through the shared document and leaves worktrees untouched', () => {
	const storePath = join(scratch('oddless-roundtrip'), 'pi-worktrees.json');
	const worktrees = [
		{ branch: 'feat/x', path: '/clone-worktrees/x', thread: 'thread-1', issues: [], odd: 'odd/tasks/x.md' },
	];
	mkdirSync(dirname(storePath), { recursive: true });
	writeFileSync(storePath, `${JSON.stringify({ version: WORKTREE_METADATA_VERSION, worktrees }, null, 2)}\n`);

	const worktreePath = join(root, 'oddless-roundtrip-worktree');
	saveWorktreeMetadataRecords(storePath, recordsOf([[worktreePath, oddlessRecord()]]));

	const stored = readWorktreeMetadataStore(storePath);
	assert.equal(stored.status, 'valid');
	if (stored.status !== 'valid') return;
	assert.deepEqual(stored.drops, [], 'the odd-less record is not dropped on the way back in');
	assert.equal('odd' in stored.file.records[worktreePath], false, 'the round trip keeps the key absent');
	assert.deepEqual(stored.file.worktrees, worktrees, 'the registry side of the document is untouched');

	const raw = JSON.parse(readFileSync(storePath, 'utf8'));
	assert.equal('odd' in raw.records[worktreePath], false, 'the bytes carry no odd key');
	assert.deepEqual(raw.worktrees, worktrees);
});

test('writes the same bytes for the same records regardless of insertion order', () => {
	const left = worktreeMetadataFilePath(scratch('order-left'));
	const right = worktreeMetadataFilePath(scratch('order-right'));
	const alpha = join(root, 'order-alpha');
	const beta = join(root, 'order-beta');

	saveWorktreeMetadataRecords(left, recordsOf([[alpha, recordFor({ odd: 'alpha' })], [beta, recordFor({ odd: 'beta' })]]));
	saveWorktreeMetadataRecords(right, recordsOf([[beta, recordFor({ odd: 'beta' })], [alpha, recordFor({ odd: 'alpha' })]]));
	assert.equal(readFileSync(right, 'utf8'), readFileSync(left, 'utf8'));
});

test('builds the record a create call persists, defaulting what it has not observed yet', () => {
	const created = createWorktreeMetadataRecord({
		odd: 'worktree-tools',
		createdBy: 'session-1',
		adminId: 'worktree-tools',
		branchAtCreation: 'feat/worktree-tools',
		baseRef: 'main',
	}, new Date(AT));

	assert.equal(created.createdAt, AT);
	assert.deepEqual(created.hooks, []);
	assert.deepEqual(created.setup, emptyWorktreeSetup());
	assert.deepEqual(created.lastSeen, { at: AT, status: 'active' });
	assert.deepEqual(Object.keys(created), [
		'odd',
		'createdAt',
		'createdBy',
		'adminId',
		'branchAtCreation',
		'baseRef',
		'hooks',
		'setup',
		'lastSeen',
	]);
});

// ---- S11: the state vocabulary ----

test('exposes the ten display states as one closed set with one label each', () => {
	assert.deepEqual([...WORKTREE_STATE_IDS], [
		'ready',
		'running',
		'failed',
		'skipped',
		'active-manual',
		'missing',
		'gone',
		'foreign',
		'pending',
		'interrupted',
	]);
	assert.deepEqual(Object.keys(WORKTREE_STATE_LABELS).sort(), [...WORKTREE_STATE_IDS].sort());
	assert.deepEqual(WORKTREE_STATE_IDS.map((id) => WORKTREE_STATE_LABELS[id]), [
		'ready',
		'running',
		'failed',
		'skipped',
		'active · manual',
		'missing',
		'gone',
		'foreign',
		'pending',
		'interrupted',
	]);
});

test('renders the running state with the step it is running', () => {
	assert.equal(worktreeStateLabel({ id: 'ready' }), 'ready');
	assert.equal(worktreeStateLabel({ id: 'active-manual' }), 'active · manual');
	assert.equal(worktreeStateLabel({ id: 'running', step: 'pnpm install' }), 'running (pnpm install)');
	assert.equal(worktreeStateLabel({ id: 'running' }), 'running');
});

test('derives the display state of a record from its setup chain', () => {
	const withSetup = (setup) => worktreeStateForRecord(recordFor({ setup }));
	assert.equal(withSetup({ status: 'ready', steps: [] }).id, 'ready');
	assert.deepEqual(
		withSetup({ status: 'running', steps: [{ command: 'pnpm install', status: 'ready' }, { command: 'cargo fetch', status: 'running' }] }),
		{ id: 'running', step: 'cargo fetch' },
	);
	assert.equal(withSetup({ status: 'failed', steps: [{ command: 'pnpm install', status: 'failed', exitCode: 1 }] }).id, 'failed');
	assert.equal(withSetup({ status: 'skipped', steps: [] }).id, 'skipped');
	assert.equal(withSetup({ status: 'interrupted', steps: [] }).id, 'interrupted');
	assert.equal(withSetup({ status: 'pending', steps: [] }).id, 'pending');
});

test('renders a pending setup with the reason it was recorded with', () => {
	const label = (setup) =>
		worktreeStateLabel(worktreeStateForRecord(recordFor({ setup })));

	assert.equal(label({ status: 'pending', steps: [], detail: 'job limit reached' }), 'pending (job limit reached)');
	assert.equal(label({ status: 'pending', steps: [] }), 'pending');
	assert.equal(label({ status: 'interrupted', steps: [] }), 'interrupted');
	assert.equal(worktreeStateLabel({ id: 'pending' }), 'pending');
	assert.equal(worktreeStateLabel({ id: 'pending', reason: 'job limit reached' }), 'pending (job limit reached)');
	assert.equal(worktreeStateLabel({ id: 'interrupted' }), 'interrupted');
});

test('keeps the pending reason in the persisted setup, and decodes a setup without one', () => {
	const storePath = worktreeMetadataFilePath(scratch('pending-store'));
	const worktreePath = join(root, 'pending-worktree');
	saveWorktreeMetadataRecords(storePath, recordsOf([[
		worktreePath,
		recordFor({ setup: { status: 'pending', steps: [], detail: 'job limit reached' } }),
	]]));

	const stored = readWorktreeMetadataStore(storePath);
	assert.equal(stored.status, 'valid');
	if (stored.status !== 'valid') return;
	assert.deepEqual(stored.file.records[worktreePath].setup, { status: 'pending', steps: [], detail: 'job limit reached' });

	// A record persisted before the reason existed still decodes and renders `pending` alone.
	const legacyPath = worktreeMetadataFilePath(scratch('pending-without-reason'));
	mkdirSync(dirname(legacyPath), { recursive: true });
	writeFileSync(legacyPath, `${JSON.stringify({
		kind: WORKTREE_METADATA_KIND,
		version: WORKTREE_METADATA_VERSION,
		records: { [worktreePath]: recordFor({ setup: { status: 'pending', steps: [] } }) },
	}, null, 2)}\n`);
	const legacy = readWorktreeMetadataStore(legacyPath);
	assert.equal(legacy.status, 'valid');
	if (legacy.status !== 'valid') return;
	assert.equal('detail' in legacy.file.records[worktreePath].setup, false);
	assert.equal(worktreeStateLabel(worktreeStateForRecord(legacy.file.records[worktreePath])), 'pending');
});

// ---- S8: identity and reconciliation ----

test('parses git worktree list --porcelain into worktree entries', () => {
	const porcelain = [
		'worktree /clone',
		'HEAD 1111111111111111111111111111111111111111',
		'branch refs/heads/main',
		'',
		'worktree /clone-worktrees/worktree-tools',
		'HEAD 2222222222222222222222222222222222222222',
		'branch refs/heads/feat/worktree-tools',
		'',
		'worktree /clone-worktrees/detached',
		'HEAD 3333333333333333333333333333333333333333',
		'detached',
		'',
		'worktree /clone-worktrees/pruned',
		'HEAD 4444444444444444444444444444444444444444',
		'detached',
		'prunable gitdir file points to non-existent location',
		'',
	].join('\n');

	const expected = [
		{ path: '/clone', head: '1111111111111111111111111111111111111111', branch: 'main' },
		{ path: '/clone-worktrees/worktree-tools', head: '2222222222222222222222222222222222222222', branch: 'feat/worktree-tools' },
		{ path: '/clone-worktrees/detached', head: '3333333333333333333333333333333333333333', detached: true },
		{
			path: '/clone-worktrees/pruned',
			head: '4444444444444444444444444444444444444444',
			detached: true,
			prunable: true,
			prunableReason: 'gitdir file points to non-existent location',
		},
	];
	assert.deepEqual(parseWorktreeListPorcelain(porcelain), expected);
	assert.deepEqual(parseWorktreeListPorcelain(porcelain.replaceAll('\n\n', '\0\0').replaceAll('\n', '\0')), expected);
});

test('joins a stored record with the Git entry at the same path', () => {
	const worktreePath = '/clone-worktrees/worktree-tools';
	const environment = fakeEnvironment({ [worktreePath]: { adminDir: `${COMMON_DIR}/worktrees/worktree-tools` } });
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [{ path: worktreePath, branch: 'feat/worktree-tools' }],
		records: recordsOf([[worktreePath, recordFor({ lastSeen: { at: AT, branch: 'stale', status: 'active' } })]]),
	});

	assert.equal(reconciliation.worktrees.length, 1);
	const [joined] = reconciliation.worktrees;
	assert.equal(joined.path, worktreePath);
	assert.equal(worktreeStateLabel(joined.state), 'ready');
	assert.equal(joined.orphaned, false);
	assert.equal(joined.adminId, 'worktree-tools');
	assert.equal(joined.branch, 'feat/worktree-tools');
	assert.equal(joined.record?.odd, 'worktree-tools');
	assert.deepEqual(reconciliation.records[worktreePath].lastSeen, {
		at: LATER,
		branch: 'feat/worktree-tools',
		status: 'active',
	});
	assert.equal(reconciliation.changed, true);
});

test('keys records by canonical path, so a symlinked spelling joins the same record', () => {
	const realPath = '/clone-worktrees/worktree-tools';
	const aliasPath = '/shortcut/worktree-tools';
	const environment = {
		stat: () => 'present',
		realpath: (path) => (path === aliasPath ? realPath : path),
		adminDir: () => `${COMMON_DIR}/worktrees/worktree-tools`,
	};
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [{ path: aliasPath, branch: 'feat/worktree-tools' }],
		records: recordsOf([[realPath, recordFor()]]),
	});

	assert.equal(reconciliation.worktrees.length, 1);
	assert.equal(reconciliation.worktrees[0].path, realPath);
	assert.equal(reconciliation.worktrees[0].record?.odd, 'worktree-tools');
	assert.deepEqual(Object.keys(reconciliation.records), [realPath]);
});

test('keeps the record and its odd when the same adminId appears at another path', () => {
	const before = '/clone-worktrees/old-name';
	const after = '/clone-worktrees/moved/worktree-tools';
	const environment = fakeEnvironment({ [after]: { adminDir: `${COMMON_DIR}/worktrees/worktree-tools` } });
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [{ path: after, branch: 'feat/worktree-tools' }],
		records: recordsOf([[before, recordFor()]]),
	});

	assert.equal(reconciliation.worktrees.length, 1);
	const [moved] = reconciliation.worktrees;
	assert.equal(moved.path, after);
	assert.equal(moved.movedFrom, before);
	assert.equal(moved.record?.odd, 'worktree-tools');
	assert.equal(worktreeStateLabel(moved.state), 'ready');
	assert.deepEqual(Object.keys(reconciliation.records), [after]);
	assert.equal(reconciliation.records[after].odd, 'worktree-tools');
	assert.equal(reconciliation.changed, true);
});

test('keeps the old record orphaned and needs a fresh record when a path is recycled', () => {
	const recycledPath = '/clone-worktrees/recycled';
	const environment = fakeEnvironment({ [recycledPath]: { adminDir: `${COMMON_DIR}/worktrees/recycled-second` } });
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [{ path: recycledPath, branch: 'feat/other' }],
		records: recordsOf([[recycledPath, recordFor({ adminId: 'recycled-first', odd: 'old-odd' })]]),
	});

	const live = reconciliation.worktrees.find((worktree) => worktree.record === undefined);
	assert.ok(live, 'the new worktree in the recycled path has no record yet');
	assert.equal(live.path, recycledPath);
	assert.equal(worktreeStateLabel(live.state), 'active · manual');
	assert.equal(live.adminId, 'recycled-second');
	assert.equal(live.branch, 'feat/other');

	const orphaned = reconciliation.worktrees.find((worktree) => worktree.orphaned);
	assert.ok(orphaned, 'the old record survives, marked orphaned');
	assert.equal(orphaned.path, recycledPath);
	assert.equal(worktreeStateLabel(orphaned.state), 'gone');
	assert.equal(orphaned.record?.odd, 'old-odd');
	assert.deepEqual(Object.keys(reconciliation.records), [recycledPath]);
	assert.equal(reconciliation.records[recycledPath].adminId, 'recycled-first');
	assert.equal(reconciliation.records[recycledPath].lastSeen.status, 'gone');
});

test('treats the branch as observed data, so a branch change stays the same worktree', () => {
	const worktreePath = '/clone-worktrees/worktree-tools';
	const environment = fakeEnvironment({ [worktreePath]: { adminDir: `${COMMON_DIR}/worktrees/worktree-tools` } });
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [{ path: worktreePath, branch: 'fix/something-else' }],
		records: recordsOf([[worktreePath, recordFor()]]),
	});

	const [joined] = reconciliation.worktrees;
	assert.equal(joined.record?.branchAtCreation, 'feat/worktree-tools');
	assert.equal(joined.branch, 'fix/something-else');
	assert.equal(reconciliation.records[worktreePath].branchAtCreation, 'feat/worktree-tools');
	assert.deepEqual(reconciliation.records[worktreePath].lastSeen, {
		at: LATER,
		branch: 'fix/something-else',
		status: 'active',
	});
});

test('marks a path that belongs to another repository as foreign and keeps its record', () => {
	const foreignPath = '/elsewhere/worktree-tools';
	const environment = fakeEnvironment({ [foreignPath]: { adminDir: '/other-repo/.git/worktrees/worktree-tools' } });
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [{ path: foreignPath, branch: 'feat/worktree-tools' }],
		records: recordsOf([[foreignPath, recordFor()]]),
	});

	assert.equal(reconciliation.worktrees.length, 1);
	assert.equal(worktreeStateLabel(reconciliation.worktrees[0].state), 'foreign');
	assert.equal(reconciliation.worktrees[0].record?.odd, 'worktree-tools');
	assert.deepEqual(Object.keys(reconciliation.records), [foreignPath]);
	assert.equal(reconciliation.records[foreignPath].lastSeen.status, 'foreign');
});

test('marks a stored record whose path now belongs to another repository as foreign without deleting it', () => {
	const foreignPath = '/elsewhere/worktree-tools';
	const environment = fakeEnvironment({ [foreignPath]: { adminDir: '/other-repo/.git/worktrees/worktree-tools' } });
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [],
		records: recordsOf([[foreignPath, recordFor()]]),
	});

	assert.equal(reconciliation.worktrees.length, 1);
	assert.equal(worktreeStateLabel(reconciliation.worktrees[0].state), 'foreign');
	assert.equal(reconciliation.worktrees[0].orphaned, false);
	assert.deepEqual(Object.keys(reconciliation.records), [foreignPath]);
});

test('marks a Git-listed worktree as missing when its path is gone or prunable', () => {
	const absentPath = '/clone-worktrees/absent';
	const prunablePath = '/clone-worktrees/prunable';
	const environment = fakeEnvironment({
		[absentPath]: { present: false },
		[prunablePath]: { adminDir: `${COMMON_DIR}/worktrees/prunable` },
	});
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [
			{ path: absentPath, branch: 'feat/absent' },
			{ path: prunablePath, prunable: true, prunableReason: 'gitdir file points to non-existent location' },
		],
		records: recordsOf([[absentPath, recordFor()]]),
	});

	assert.deepEqual(reconciliation.worktrees.map((worktree) => worktreeStateLabel(worktree.state)), ['missing', 'missing']);
	assert.equal(reconciliation.records[absentPath].lastSeen.status, 'missing');
	assert.deepEqual(Object.keys(reconciliation.records), [absentPath]);
});

test('marks a record whose path is gone and that Git no longer lists as gone without deleting it', () => {
	const mainPath = '/clone';
	const deletedPath = '/clone-worktrees/deleted';
	const environment = fakeEnvironment({ [mainPath]: { adminDir: COMMON_DIR } });
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [{ path: mainPath, branch: 'main' }],
		records: recordsOf([[deletedPath, recordFor()]]),
	});

	assert.deepEqual(
		reconciliation.worktrees.map((worktree) => [worktree.path, worktreeStateLabel(worktree.state), worktree.orphaned]),
		[[mainPath, 'active · manual', false], [deletedPath, 'gone', false]],
	);
	assert.deepEqual(Object.keys(reconciliation.records), [deletedPath]);
	assert.equal(reconciliation.records[deletedPath].odd, 'worktree-tools');
	assert.equal(reconciliation.records[deletedPath].adminId, 'worktree-tools');
	assert.equal(reconciliation.records[deletedPath].lastSeen.status, 'gone');
	assert.equal(reconciliation.changed, true);
});

test('dates a gone record from the first observation that found it gone', () => {
	const deletedPath = '/clone-worktrees/deleted';
	const environment = fakeEnvironment({ ['/clone']: { adminDir: COMMON_DIR } });
	const first = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [{ path: '/clone', branch: 'main' }],
		records: recordsOf([[deletedPath, recordFor({ lastSeen: { at: AT, branch: 'feat/worktree-tools', status: 'active' } })]]),
	});

	// The removal happened somewhere after the last present observation; the date the
	// caller reads is the first observation that missed it, never the last list call.
	assert.equal(first.records[deletedPath].lastSeen.goneSince, LATER);
	assert.equal(first.records[deletedPath].lastSeen.at, AT);
	assert.equal(first.records[deletedPath].lastSeen.status, 'gone');
	assert.equal(worktreeGoneDate(first.records[deletedPath]), LATER);
	assert.equal(first.changed, true);

	const second = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now: () => new Date(EVEN_LATER),
		entries: [{ path: '/clone', branch: 'main' }],
		records: first.records,
	});

	// A later verification neither re-dates the removal nor advances the last present one.
	assert.equal(second.records[deletedPath].lastSeen.goneSince, LATER);
	assert.equal(second.records[deletedPath].lastSeen.at, AT);
	assert.equal(worktreeGoneDate(second.records[deletedPath]), LATER);
	assert.equal(second.changed, false);
});

test('clears the gone date when the worktree is observed present again', () => {
	const worktreePath = '/clone-worktrees/back-again';
	const environment = fakeEnvironment({ [worktreePath]: { adminDir: `${COMMON_DIR}/worktrees/worktree-tools` } });
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now: () => new Date(EVEN_LATER),
		entries: [{ path: worktreePath, branch: 'feat/worktree-tools' }],
		records: recordsOf([[
			worktreePath,
			recordFor({ lastSeen: { at: AT, branch: 'feat/worktree-tools', status: 'gone', goneSince: LATER } }),
		]]),
	});

	assert.deepEqual(reconciliation.records[worktreePath].lastSeen, {
		at: EVEN_LATER,
		branch: 'feat/worktree-tools',
		status: 'active',
	});
	assert.equal('goneSince' in reconciliation.records[worktreePath].lastSeen, false);
	assert.equal(worktreeGoneDate(reconciliation.records[worktreePath]), EVEN_LATER);
});

test('round-trips a gone date through the store and decodes a file written before it existed', () => {
	const storePath = worktreeMetadataFilePath(scratch('gone-since-store'));
	const worktreePath = join(root, 'gone-since-worktree');
	saveWorktreeMetadataRecords(storePath, recordsOf([[
		worktreePath,
		recordFor({ lastSeen: { at: AT, branch: 'feat/worktree-tools', status: 'gone', goneSince: LATER } }),
	]]));

	const stored = readWorktreeMetadataStore(storePath);
	assert.equal(stored.status, 'valid');
	if (stored.status !== 'valid') return;
	assert.deepEqual(stored.file.records[worktreePath].lastSeen, {
		at: AT,
		branch: 'feat/worktree-tools',
		status: 'gone',
		goneSince: LATER,
	});
	assert.equal(worktreeGoneDate(stored.file.records[worktreePath]), LATER);

	// A file written before the field existed still decodes, and the fallback keeps a date.
	const legacyPath = worktreeMetadataFilePath(scratch('legacy-store'));
	mkdirSync(dirname(legacyPath), { recursive: true });
	writeFileSync(legacyPath, `${JSON.stringify({
		kind: WORKTREE_METADATA_KIND,
		version: WORKTREE_METADATA_VERSION,
		records: { [worktreePath]: recordFor() },
	}, null, 2)}\n`);
	const legacy = readWorktreeMetadataStore(legacyPath);
	assert.equal(legacy.status, 'valid');
	if (legacy.status !== 'valid') return;
	assert.equal('goneSince' in legacy.file.records[worktreePath].lastSeen, false);
	assert.equal(worktreeGoneDate(legacy.file.records[worktreePath]), AT);
});

test('reports a record whose path was recycled as gone, orphaned and dated from the recycle', () => {
	const recycledPath = '/clone-worktrees/recycled';
	const environment = fakeEnvironment({ [recycledPath]: { adminDir: `${COMMON_DIR}/worktrees/recycled-second` } });
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [{ path: recycledPath, branch: 'feat/other' }],
		records: recordsOf([[recycledPath, recordFor({ adminId: 'recycled-first', lastSeen: { at: AT, status: 'active' } })]]),
	});

	const orphaned = reconciliation.worktrees.find((worktree) => worktree.orphaned);
	assert.ok(orphaned, 'the old record is reported as orphaned');
	assert.equal(worktreeStateLabel(orphaned.state), 'gone');
	assert.equal(orphaned.orphaned, true);
	assert.equal(orphaned.goneReason, 'recycled');
	assert.equal(worktreeGoneDate(reconciliation.records[recycledPath]), LATER);
	assert.ok(WORKTREE_GONE_REASONS.includes('recycled'));
});

test('reports a record Git no longer lists whose own admin dir still matches as a broken registration', () => {
	const stalePath = '/clone-worktrees/stale';
	const environment = fakeEnvironment({ [stalePath]: { adminDir: `${COMMON_DIR}/worktrees/worktree-tools` } });
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [],
		records: recordsOf([[stalePath, recordFor({ lastSeen: { at: AT, status: 'active' } })]]),
	});

	assert.equal(reconciliation.worktrees.length, 1);
	const [stale] = reconciliation.worktrees;
	assert.equal(worktreeStateLabel(stale.state), 'gone');
	assert.equal(stale.orphaned, false);
	assert.equal(stale.goneReason, 'broken-registration');
	assert.ok(WORKTREE_GONE_REASONS.includes('broken-registration'));

	// Both gone kinds keep their first-gone date across a later verification.
	const later = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now: () => new Date(EVEN_LATER),
		entries: [],
		records: reconciliation.records,
	});
	assert.equal(later.worktrees[0].goneReason, 'broken-registration');
	assert.equal(worktreeGoneDate(later.records[stalePath]), LATER);
	assert.equal(later.changed, false);
});

test('reports a record whose path is gone as gone for an absent path', () => {
	const deletedPath = '/clone-worktrees/deleted';
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment: fakeEnvironment({}),
		now,
		entries: [],
		records: recordsOf([[deletedPath, recordFor()]]),
	});

	assert.equal(reconciliation.worktrees.length, 1);
	assert.equal(worktreeStateLabel(reconciliation.worktrees[0].state), 'gone');
	assert.equal(reconciliation.worktrees[0].orphaned, false);
	assert.equal(reconciliation.worktrees[0].goneReason, 'path-absent');
	assert.ok(WORKTREE_GONE_REASONS.includes('path-absent'));
});

test('reports no change when the verification observes what the record already holds', () => {
	const worktreePath = '/clone-worktrees/stable';
	const environment = fakeEnvironment({ [worktreePath]: { adminDir: `${COMMON_DIR}/worktrees/stable` } });
	const records = recordsOf([[
		worktreePath,
		recordFor({ adminId: 'stable', lastSeen: { at: LATER, branch: 'feat/worktree-tools', status: 'active' } }),
	]]);
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [{ path: worktreePath, branch: 'feat/worktree-tools' }],
		records,
	});

	assert.equal(reconciliation.changed, false);
	assert.deepEqual(reconciliation.records, records);
});

// ---- S23: a setup whose session died reads as interrupted, never as stale running ----

const RUNNING_PATH = '/clone-worktrees/running';

function runningRecord(overrides = {}) {
	return recordFor({
		adminId: 'running',
		setup: {
			status: 'running',
			steps: [{ command: 'pnpm install', status: 'running', logPath: '/logs/setup.log' }],
			jobId: 'job-1',
		},
		lastSeen: { at: LATER, branch: 'feat/worktree-tools', status: 'active' },
		...overrides,
	});
}

/** One reconciliation of a stored running record against the liveness seam under test. */
function observedRunning(
	setupJobLiveness,
	record = runningRecord(),
) {
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment: fakeEnvironment({ [RUNNING_PATH]: { adminDir: `${COMMON_DIR}/worktrees/running` } }),
		now,
		entries: [{ path: RUNNING_PATH, branch: 'feat/worktree-tools' }],
		records: recordsOf([[RUNNING_PATH, record]]),
		setupJobLiveness,
	});
	return reconciliation.worktrees[0];
}

test('keeps reporting running while the setup job is live or nothing can say otherwise', () => {
	const live = observedRunning((jobId) => jobId === 'job-1');
	assert.deepEqual(live.state, { id: 'running', step: 'pnpm install' });
	assert.equal(worktreeStateLabel(live.state), 'running (pnpm install)');

	// Absent evidence is not proof of death: without a seam the observation is the same.
	const unknown = observedRunning();
	assert.deepEqual(unknown.state, { id: 'running', step: 'pnpm install' });
	assert.equal(worktreeStateLabel(unknown.state), 'running (pnpm install)');
});

test('derives interrupted for a running record whose job is no longer live, without rewriting it', () => {
	const asked = [];
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment: fakeEnvironment({ [RUNNING_PATH]: { adminDir: `${COMMON_DIR}/worktrees/running` } }),
		now,
		entries: [{ path: RUNNING_PATH, branch: 'feat/worktree-tools' }],
		records: recordsOf([[RUNNING_PATH, runningRecord()]]),
		setupJobLiveness: (jobId) => {
			asked.push(jobId);
			return false;
		},
	});

	assert.deepEqual(asked, ['job-1']);
	const [stale] = reconciliation.worktrees;
	assert.deepEqual(stale.state, { id: 'interrupted' });
	assert.equal(worktreeStateLabel(stale.state), 'interrupted');

	// S12: the persisted record keeps the state the dead session left behind.
	assert.deepEqual(reconciliation.records[RUNNING_PATH].setup, runningRecord().setup);
	assert.equal(reconciliation.records[RUNNING_PATH].setup.status, 'running');
	assert.equal(reconciliation.records[RUNNING_PATH].setup.jobId, 'job-1');
	assert.equal(reconciliation.changed, false);
});

test('derives interrupted for a pending record that names a job no longer live', () => {
	const pending = runningRecord({
		setup: { status: 'pending', steps: [], jobId: 'job-1', detail: 'job limit reached' },
	});
	assert.deepEqual(observedRunning(() => false, pending).state, { id: 'interrupted' });

	// A live job or no seam at all leaves the pending reason intact.
	const live = observedRunning(() => true, pending);
	assert.deepEqual(live.state, { id: 'pending', reason: 'job limit reached' });
	assert.equal(worktreeStateLabel(live.state), 'pending (job limit reached)');
	assert.deepEqual(observedRunning(undefined, pending).state, { id: 'pending', reason: 'job limit reached' });

	// Without a job to ask about, the seam is never consulted for a pending record.
	const asked = [];
	const noJob = observedRunning((jobId) => {
		asked.push(jobId);
		return false;
	}, runningRecord({ setup: { status: 'pending', steps: [], detail: 'job limit reached' } }));
	assert.deepEqual(asked, []);
	assert.deepEqual(noJob.state, { id: 'pending', reason: 'job limit reached' });
});

// ---- S8/S12: the injected Git and filesystem seams ----

test('reads the administrative directory through an injectable Git runner', () => {
	const calls = [];
	const adminDir = readWorktreeAdminDirFromGit((cwd, args) => {
		calls.push({ cwd, args });
		return { code: 0, stdout: '/clone/.git/worktrees/worktree-tools\n' };
	}, '/clone-worktrees/worktree-tools');

	assert.equal(adminDir, '/clone/.git/worktrees/worktree-tools');
	assert.deepEqual(calls, [{
		cwd: '/clone-worktrees/worktree-tools',
		args: ['rev-parse', '--path-format=absolute', '--git-dir'],
	}]);
	assert.equal(readWorktreeAdminDirFromGit(() => undefined, '/gone'), undefined);
	assert.equal(readWorktreeAdminDirFromGit(() => ({ code: 128, stdout: '' }), '/gone'), undefined);
	assert.equal(readWorktreeAdminDirFromGit(() => ({ code: 0, stdout: '\n' }), '/gone'), undefined);
});

test('feeds the Git runner seam into the reconciliation identity', () => {
	const worktreePath = '/clone-worktrees/worktree-tools';
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		now,
		entries: [{ path: worktreePath, branch: 'feat/worktree-tools' }],
		records: recordsOf([[worktreePath, recordFor()]]),
		environment: {
			...defaultWorktreeReconcileEnvironment,
			stat: () => 'present',
			realpath: (path) => path,
			adminDir: () => readWorktreeAdminDirFromGit(
				() => ({ code: 0, stdout: '/clone/.git/worktrees/worktree-tools\n' }),
				worktreePath,
			),
		},
	});

	assert.equal(reconciliation.worktrees[0].adminId, 'worktree-tools');
	assert.equal(worktreeStateLabel(reconciliation.worktrees[0].state), 'ready');
});

test('resolves the administrative directory of a real linked worktree from its .git file', () => {
	const clone = scratch('real-clone');
	const adminDir = join(clone, '.git', 'worktrees', 'worktree-tools');
	mkdirSync(adminDir, { recursive: true });
	const worktree = join(root, 'real-worktree');
	mkdirSync(worktree, { recursive: true });
	writeFileSync(join(worktree, '.git'), `gitdir: ${adminDir}\n`);

	assert.equal(defaultWorktreeReconcileEnvironment.stat(worktree), 'present');
	assert.equal(defaultWorktreeReconcileEnvironment.stat(join(root, 'never-created')), 'absent');
	assert.equal(basename(defaultWorktreeReconcileEnvironment.adminDir(worktree) ?? ''), 'worktree-tools');
	assert.equal(basename(defaultWorktreeReconcileEnvironment.adminDir(clone) ?? ''), '.git');
	assert.equal(defaultWorktreeReconcileEnvironment.adminDir(join(root, 'never-created')), undefined);

	const canonicalWorktree = realpathSync(worktree);
	const reconciliation = reconcileWorktrees({
		commonDir: realpathSync(join(clone, '.git')),
		environment: defaultWorktreeReconcileEnvironment,
		now,
		entries: [{ path: worktree, branch: 'feat/worktree-tools' }],
		records: recordsOf([[canonicalWorktree, recordFor()]]),
	});
	assert.equal(reconciliation.worktrees.length, 1);
	assert.equal(reconciliation.worktrees[0].path, canonicalWorktree);
	assert.equal(worktreeStateLabel(reconciliation.worktrees[0].state), 'ready');
	assert.equal(reconciliation.worktrees[0].adminId, 'worktree-tools');
});

// ---- S12: verification never removes a record ----

test('never removes a record, whatever the verification observes', () => {
	const records = recordsOf([
		['/clone-worktrees/active', recordFor({ adminId: 'active' })],
		['/clone-worktrees/absent', recordFor({ adminId: 'absent' })],
		['/elsewhere/foreign', recordFor({ adminId: 'foreign' })],
		['/clone-worktrees/recycled', recordFor({ adminId: 'recycled-first' })],
	]);
	const environment = fakeEnvironment({
		'/clone-worktrees/active': { adminDir: `${COMMON_DIR}/worktrees/active` },
		'/elsewhere/foreign': { adminDir: '/other-repo/.git/worktrees/foreign' },
		'/clone-worktrees/recycled': { adminDir: `${COMMON_DIR}/worktrees/recycled-second` },
	});
	const reconciliation = reconcileWorktrees({
		commonDir: COMMON_DIR,
		environment,
		now,
		entries: [
			{ path: '/clone-worktrees/active', branch: 'feat/active' },
			{ path: '/clone-worktrees/recycled', branch: 'feat/recycled' },
		],
		records,
	});

	assert.deepEqual(Object.keys(reconciliation.records).sort(), Object.keys(records).sort());
	assert.deepEqual(
		['/clone-worktrees/active', '/clone-worktrees/absent', '/elsewhere/foreign', '/clone-worktrees/recycled']
			.map((path) => [path, reconciliation.records[path].adminId, reconciliation.records[path].lastSeen.status]),
		[
			['/clone-worktrees/active', 'active', 'active'],
			['/clone-worktrees/absent', 'absent', 'gone'],
			['/elsewhere/foreign', 'foreign', 'foreign'],
			['/clone-worktrees/recycled', 'recycled-first', 'gone'],
		],
	);
});

// ---- PRESERVE: exported symbols and branches the source suite leaves untested ----

test('exports the fixed vocabularies and the store location', () => {
	// The discriminator names THIS package, not the branch the port came from.
	assert.equal(WORKTREE_METADATA_KIND, 'pi-odd-worktree.worktree-metadata');
	assert.equal(WORKTREE_METADATA_VERSION, 1);
	assert.equal(WORKTREE_METADATA_DIRECTORY, 'gentle-ai');
	assert.equal(WORKTREE_METADATA_FILENAME, 'worktrees.json');
	assert.deepEqual([...WORKTREE_SETUP_STATUSES], ['pending', 'running', 'ready', 'failed', 'skipped', 'interrupted']);
	assert.deepEqual([...WORKTREE_HOOK_OUTCOMES], ['applied', 'skipped', 'failed']);
	assert.deepEqual([...WORKTREE_OBSERVED_STATUSES], ['active', 'missing', 'gone', 'foreign']);
});

test('starts an empty metadata file and an empty setup', () => {
	assert.deepEqual(emptyWorktreeMetadataFile(), {
		kind: WORKTREE_METADATA_KIND,
		version: WORKTREE_METADATA_VERSION,
		records: {},
	});
	assert.deepEqual(emptyWorktreeSetup(), { status: 'pending', steps: [] });
	assert.deepEqual(emptyWorktreeSetup('ready'), { status: 'ready', steps: [] });
});

test('recognises the canonical path shape a record is stored under', () => {
	assert.equal(isCanonicalWorktreePath('/clone/worktrees/feature'), true);
	assert.equal(isCanonicalWorktreePath('relative/path'), false);
	assert.equal(isCanonicalWorktreePath('/clone/worktrees/feature/'), false);
	assert.equal(isCanonicalWorktreePath(''), false);
});

test('reports a store that is not an object or carries an unexpected top-level key as unreadable', () => {
	const notObject = worktreeMetadataFilePath(scratch('not-an-object'));
	mkdirSync(dirname(notObject), { recursive: true });
	writeFileSync(notObject, '[]\n');
	assert.deepEqual(readWorktreeMetadataStore(notObject), { status: 'unreadable', detail: 'not a JSON object' });

	const extraKey = worktreeMetadataFilePath(scratch('extra-key'));
	mkdirSync(dirname(extraKey), { recursive: true });
	writeFileSync(extraKey, `${JSON.stringify({
		kind: WORKTREE_METADATA_KIND,
		version: WORKTREE_METADATA_VERSION,
		records: {},
		extra: 1,
	}, null, 2)}\n`);
	assert.deepEqual(readWorktreeMetadataStore(extraKey), { status: 'unreadable', detail: 'unexpected top-level key: extra' });
});

test('parses a bare worktree entry and tolerates CRLF output', () => {
	assert.deepEqual(parseWorktreeListPorcelain('worktree /clone\nbare\n'), [{ path: '/clone', bare: true }]);
	assert.deepEqual(
		parseWorktreeListPorcelain('worktree /clone-worktrees/w\r\nHEAD abc\r\nbranch refs/heads/main\r\n'),
		[{ path: '/clone-worktrees/w', head: 'abc', branch: 'main' }],
	);
});

test('reports the last reached step and a running state with no step to name', () => {
	assert.deepEqual(currentWorktreeSetupStep({ status: 'ready', steps: [] }), undefined);
	assert.deepEqual(
		currentWorktreeSetupStep({
			status: 'failed',
			steps: [{ command: 'pnpm install', status: 'ready' }, { command: 'cargo fetch', status: 'failed' }],
		}),
		{ command: 'cargo fetch', status: 'failed' },
	);
	assert.deepEqual(worktreeStateForRecord(recordFor({ setup: { status: 'running', steps: [] } })), { id: 'running' });
});

test('maps every persisted setup status to its display state', () => {
	assert.deepEqual(WORKTREE_SETUP_STATE_DISPLAY, {
		pending: 'pending',
		running: 'running',
		ready: 'ready',
		failed: 'failed',
		skipped: 'skipped',
		interrupted: 'interrupted',
	});
	for (const status of WORKTREE_SETUP_STATUSES) assert.equal(WORKTREE_SETUP_STATE_DISPLAY[status], status);
});

test('normalizes a record it understands and rejects one it does not', () => {
	assert.deepEqual(normalizeWorktreeMetadataRecord(recordFor()), recordFor());
	assert.equal(normalizeWorktreeMetadataRecord({ odd: 'only-an-odd' }), undefined);
	assert.equal(normalizeWorktreeMetadataRecord(null), undefined);
});

test('serializes the store with sorted record keys and a trailing newline', () => {
	const file = {
		kind: WORKTREE_METADATA_KIND,
		version: WORKTREE_METADATA_VERSION,
		records: { '/b': recordFor({ odd: 'b' }), '/a': recordFor({ odd: 'a' }) },
	};
	const text = serializeWorktreeMetadataFile(file);
	assert.ok(text.endsWith('\n'));
	const parsed = JSON.parse(text);
	assert.deepEqual(Object.keys(parsed.records), ['/a', '/b']);
	assert.deepEqual(parsed, file);
});
