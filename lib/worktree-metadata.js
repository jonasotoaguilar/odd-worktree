'use strict';
// Local metadata for the worktree tools.
//
// Git owns existence: `git worktree list` and `lstat` answer whether a worktree
// exists, which administrative directory it belongs to and which branch it holds.
// This module owns only what Git cannot know — which ODD a worktree serves, who
// created it, which preparation hooks ran and how far its setup chain got — and
// reconciles both sides into one joined view.
//
// A clone has exactly ONE metadata document, `<git-common-dir>/pi-worktrees.json`,
// shared with `lib/worktree-registry.js`. Its two data keys have one owner each:
// `worktrees` belongs to the registry and `records` belongs here, while `kind` and
// `version` are this store's discriminator. Neither reader interprets the other's
// key: this module carries a `worktrees` value through byte for byte and never
// validates or rewrites it. The extension passes the document's path in explicitly;
// `worktreeMetadataFilePath()` is the standalone port's own location, not that file.
//
// Records are keyed by canonical worktree path, which is the primary key. `adminId`,
// the basename of the worktree's administrative directory, is the identity used to
// reconcile: a known `adminId` at a new path is the same worktree moved and keeps its
// record, while a known path with a new `adminId` is a different worktree in a
// recycled path. Branch is observed data and never identity.
//
// Nothing here deletes a record. Verification refreshes an observed state, so a
// record whose worktree disappeared stays in the file until a human removes it.

const { randomUUID } = require('node:crypto');
const {
	lstatSync,
	readFileSync,
	realpathSync,
	statSync,
	mkdirSync,
	openSync,
	closeSync,
	writeFileSync,
	renameSync,
	unlinkSync,
	constants,
} = require('node:fs');
const { basename, dirname, isAbsolute, join, normalize, relative, resolve } = require('node:path');

const WORKTREE_METADATA_KIND = 'pi-odd-worktree.worktree-metadata';
const WORKTREE_METADATA_VERSION = 1;
// The standalone port's own location, kept because `worktreeMetadataFilePath()` and
// `lib/worktree-hooks.js` still use it. It is NOT the package's clone document: that
// one is `<git-common-dir>/pi-worktrees.json` and its path is passed in explicitly.
const WORKTREE_METADATA_DIRECTORY = 'gentle-ai';
const WORKTREE_METADATA_FILENAME = 'worktrees.json';

/**
 * `<git-common-dir>/gentle-ai/worktrees.json`: the standalone store the module was
 * ported with, kept for callers that still ask for it. The package's single clone
 * document is `<git-common-dir>/pi-worktrees.json` — shared with
 * `lib/worktree-registry.js`, whose `worktrees` key this module preserves — and its
 * path must be passed to the readers and writers explicitly rather than derived here.
 */
function worktreeMetadataFilePath(commonDir) {
	return join(commonDir, WORKTREE_METADATA_DIRECTORY, WORKTREE_METADATA_FILENAME);
}

// ---- Stored record shapes ----

/**
 * How far one preparation chain step got. `interrupted` is written when a step was
 * still running at the start of a later observation, so a session that died
 * mid-setup reconciles to it instead of a permanently stale `running`.
 */
const WORKTREE_SETUP_STATUSES = [
	'pending',
	'running',
	'ready',
	'failed',
	'skipped',
	'interrupted',
];

/**
 * The existence state last observed for a record; the observation, not a presentation state.
 */
const WORKTREE_OBSERVED_STATUSES = ['active', 'missing', 'gone', 'foreign'];

const WORKTREE_HOOK_OUTCOMES = ['applied', 'skipped', 'failed'];

/**
 * Why a record is `gone`. The state word is shared so the list never invents a fourth
 * existence state, and the reason is what lets a renderer explain it.
 */
const WORKTREE_GONE_REASONS = [
	'path-absent',
	'recycled',
	'broken-registration',
];

function emptyWorktreeMetadataFile() {
	return { kind: WORKTREE_METADATA_KIND, version: WORKTREE_METADATA_VERSION, records: {} };
}

function emptyWorktreeSetup(status = 'pending') {
	return { status, steps: [] };
}

// ---- The state vocabulary (S11) ----

/**
 * The one closed set later tasks consume: the agent-facing text, the TUI card and
 * the notifications all derive their wording from these ids and labels instead of
 * repeating string literals.
 */
const WORKTREE_STATE_IDS = [
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
];

const WORKTREE_STATE_LABELS = {
	ready: 'ready',
	running: 'running',
	failed: 'failed',
	skipped: 'skipped',
	'active-manual': 'active · manual',
	missing: 'missing',
	gone: 'gone',
	foreign: 'foreign',
	pending: 'pending',
	interrupted: 'interrupted',
};

function worktreeStateLabel(state) {
	const label = WORKTREE_STATE_LABELS[state.id];
	if (state.id === 'running' && state.step) return `${label} (${state.step})`;
	if (state.id === 'pending' && state.reason) return `${label} (${state.reason})`;
	return label;
}

// Every display state comes from the persisted setup status here, so a `pending`
// chain that never started and an `interrupted` one are never reported as `running`
// or `failed`: the list would then hide exactly the states that need a human. A
// `running` or `pending` chain whose job is no longer live derives `interrupted`
// without rewriting the record (S12), so a dead session stops looking busy.
const WORKTREE_SETUP_STATE_DISPLAY = {
	pending: 'pending',
	running: 'running',
	ready: 'ready',
	failed: 'failed',
	skipped: 'skipped',
	interrupted: 'interrupted',
};

/** The step a running chain is on: the one running, else the last one it reached. */
function currentWorktreeSetupStep(setup) {
	return setup.steps.find((step) => step.status === 'running') ?? setup.steps.at(-1);
}

/**
 * A chain whose job is no longer live ended with the session that started it: the
 * observation is `interrupted`, and the persisted `running` or `pending` status stays
 * exactly as the dead session left it. No seam, or no job to ask about, is not evidence
 * of death, so a live or unknown chain keeps reporting its persisted state.
 */
function setupJobDead(setup, isJobLive) {
	if (isJobLive === undefined) return false;
	const jobId = setup.jobId;
	if (jobId === undefined || jobId.length === 0) return false;
	return !isJobLive(jobId);
}

function worktreeStateForRecord(record, isJobLive) {
	const id = WORKTREE_SETUP_STATE_DISPLAY[record.setup.status];
	if (id !== 'pending' && id !== 'running') return { id };
	if (setupJobDead(record.setup, isJobLive)) return { id: 'interrupted' };
	if (id === 'pending') {
		const reason = record.setup.detail;
		return reason === undefined || reason.length === 0 ? { id } : { id, reason };
	}
	const step = currentWorktreeSetupStep(record.setup);
	return step ? { id, step: step.command } : { id };
}

/**
 * The date a `gone` record is dated with: the first observation that found it gone,
 * falling back to the last observation that found it present. A renderer never guesses.
 */
function worktreeGoneDate(record) {
	return record.lastSeen.goneSince ?? record.lastSeen.at;
}

// ---- Reading and writing the store ----

/**
 * A write that refused to run. Every code means the file was left untouched,
 * because the alternative would be overwriting records this version cannot read.
 */
class WorktreeMetadataError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'WorktreeMetadataError';
		this.code = code;
	}
}

// `worktrees` belongs to lib/worktree-registry.js: both readers share one clone
// file, so this module tolerates that sibling key and carries it through untouched.
const STORE_KEYS = ['kind', 'version', 'records', 'worktrees'];
const hasOwn = (container, key) => Object.prototype.hasOwnProperty.call(container, key);

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneOf = (values, value) => typeof value === 'string' && values.includes(value);

function stripTrailingSeparators(path) {
	let value = path;
	while (value.length > 1 && /[\\/]$/.test(value) && !/^[A-Za-z]:[\\/]$/.test(value)) value = value.slice(0, -1);
	return value;
}

const optionalText = (container, key) =>
	typeof container[key] === 'string' ? container[key] : undefined;

const optionalCount = (container, key) =>
	Number.isInteger(container[key]) ? container[key] : undefined;

const hasOnlyText = (container, keys) =>
	keys.every((key) => container[key] === undefined || typeof container[key] === 'string');

function normalizeSetupStep(value) {
	if (!isRecord(value)) return undefined;
	if (typeof value.command !== 'string' || !isOneOf(WORKTREE_SETUP_STATUSES, value.status)) return undefined;
	if (!hasOnlyText(value, ['logPath', 'startedAt', 'endedAt'])) return undefined;
	const exitCode = optionalCount(value, 'exitCode');
	if (value.exitCode !== undefined && exitCode === undefined) return undefined;
	const step = { command: value.command, status: value.status };
	const logPath = optionalText(value, 'logPath');
	const startedAt = optionalText(value, 'startedAt');
	const endedAt = optionalText(value, 'endedAt');
	if (logPath !== undefined) step.logPath = logPath;
	if (exitCode !== undefined) step.exitCode = exitCode;
	if (startedAt !== undefined) step.startedAt = startedAt;
	if (endedAt !== undefined) step.endedAt = endedAt;
	return step;
}

function normalizeSetup(value) {
	if (!isRecord(value)) return undefined;
	if (!isOneOf(WORKTREE_SETUP_STATUSES, value.status)) return undefined;
	const rawSteps = value.steps === undefined ? [] : value.steps;
	if (!Array.isArray(rawSteps)) return undefined;
	const steps = rawSteps.map(normalizeSetupStep);
	if (steps.some((step) => step === undefined)) return undefined;
	if (!hasOnlyText(value, ['jobId', 'command', 'logPath', 'endedAt', 'detail'])) return undefined;
	const exitCode = optionalCount(value, 'exitCode');
	if (value.exitCode !== undefined && exitCode === undefined) return undefined;
	const setup = { status: value.status, steps };
	const jobId = optionalText(value, 'jobId');
	const command = optionalText(value, 'command');
	const logPath = optionalText(value, 'logPath');
	const endedAt = optionalText(value, 'endedAt');
	const detail = optionalText(value, 'detail');
	if (jobId !== undefined) setup.jobId = jobId;
	if (command !== undefined) setup.command = command;
	if (logPath !== undefined) setup.logPath = logPath;
	if (exitCode !== undefined) setup.exitCode = exitCode;
	if (endedAt !== undefined) setup.endedAt = endedAt;
	if (detail !== undefined) setup.detail = detail;
	return setup;
}

function normalizeHookRecord(value) {
	if (!isRecord(value)) return undefined;
	if (typeof value.name !== 'string' || value.name.length === 0) return undefined;
	if (!isOneOf(WORKTREE_HOOK_OUTCOMES, value.status)) return undefined;
	if (!hasOnlyText(value, ['detail'])) return undefined;
	const detail = optionalText(value, 'detail');
	return detail === undefined ? { name: value.name, status: value.status } : { name: value.name, status: value.status, detail };
}

function normalizeLastSeen(value) {
	if (!isRecord(value)) return undefined;
	if (typeof value.at !== 'string' || value.at.length === 0) return undefined;
	if (!isOneOf(WORKTREE_OBSERVED_STATUSES, value.status)) return undefined;
	if (!hasOnlyText(value, ['branch', 'goneSince'])) return undefined;
	const seen = { at: value.at, status: value.status };
	const branch = optionalText(value, 'branch');
	if (branch !== undefined) seen.branch = branch;
	const goneSince = optionalText(value, 'goneSince');
	if (goneSince !== undefined) seen.goneSince = goneSince;
	return seen;
}

/**
 * S4: the ODD association is OPTIONAL — the field may be absent — but its type is not.
 * A present value must still be one non-empty path, so `''`, whitespace-only and every
 * non-string stay invalid; an absent key stays absent instead of becoming `null`, `''`
 * or `'-'` on the way to the file.
 */
function normalizeOptionalOdd(value) {
	if (value === undefined) return { valid: true };
	if (typeof value === 'string' && value.trim().length > 0) return { valid: true, odd: value };
	return { valid: false };
}

/** A record this version understands, or undefined when it must not be rewritten. */
function normalizeWorktreeMetadataRecord(value) {
	if (!isRecord(value)) return undefined;
	const odd = normalizeOptionalOdd(value.odd);
	if (!odd.valid) return undefined;
	if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) return undefined;
	if (typeof value.createdBy !== 'string' || value.createdBy.length === 0) return undefined;
	if (typeof value.adminId !== 'string' || value.adminId.length === 0) return undefined;
	if (typeof value.branchAtCreation !== 'string' || typeof value.baseRef !== 'string') return undefined;
	if (!Array.isArray(value.hooks)) return undefined;
	const hooks = value.hooks.map(normalizeHookRecord);
	if (hooks.some((hook) => hook === undefined)) return undefined;
	const setup = normalizeSetup(value.setup);
	if (!setup) return undefined;
	const lastSeen = normalizeLastSeen(value.lastSeen);
	if (!lastSeen) return undefined;
	return {
		...(odd.odd === undefined ? {} : { odd: odd.odd }),
		createdAt: value.createdAt,
		createdBy: value.createdBy,
		adminId: value.adminId,
		branchAtCreation: value.branchAtCreation,
		baseRef: value.baseRef,
		hooks,
		setup,
		lastSeen,
	};
}

/** The canonical key shape a record is stored under: absolute, normalized, no trailing separator. */
function isCanonicalWorktreePath(path) {
	return isAbsolute(path) && normalize(path) === path && stripTrailingSeparators(path) === path;
}

function orderedSetup(setup) {
	const ordered = { status: setup.status, steps: setup.steps.map(orderedSetupStep) };
	if (setup.jobId !== undefined) ordered.jobId = setup.jobId;
	if (setup.command !== undefined) ordered.command = setup.command;
	if (setup.logPath !== undefined) ordered.logPath = setup.logPath;
	if (setup.exitCode !== undefined) ordered.exitCode = setup.exitCode;
	if (setup.endedAt !== undefined) ordered.endedAt = setup.endedAt;
	if (setup.detail !== undefined) ordered.detail = setup.detail;
	return ordered;
}

function orderedSetupStep(step) {
	const ordered = { command: step.command, status: step.status };
	if (step.logPath !== undefined) ordered.logPath = step.logPath;
	if (step.exitCode !== undefined) ordered.exitCode = step.exitCode;
	if (step.startedAt !== undefined) ordered.startedAt = step.startedAt;
	if (step.endedAt !== undefined) ordered.endedAt = step.endedAt;
	return ordered;
}

function orderedRecord(record) {
	return {
		// S4: an absent ODD stays absent in the bytes — not null, not `''`, not `'-'`.
		...(record.odd === undefined ? {} : { odd: record.odd }),
		createdAt: record.createdAt,
		createdBy: record.createdBy,
		adminId: record.adminId,
		branchAtCreation: record.branchAtCreation,
		baseRef: record.baseRef,
		hooks: record.hooks.map((hook) => {
			const ordered = { name: hook.name, status: hook.status };
			if (hook.detail !== undefined) ordered.detail = hook.detail;
			return ordered;
		}),
		setup: orderedSetup(record.setup),
		lastSeen: orderedLastSeen(record.lastSeen),
	};
}

function orderedLastSeen(lastSeen) {
	const ordered = { at: lastSeen.at, status: lastSeen.status };
	if (lastSeen.branch !== undefined) ordered.branch = lastSeen.branch;
	if (lastSeen.goneSince !== undefined) ordered.goneSince = lastSeen.goneSince;
	return ordered;
}

// Fixed key order and sorted record keys keep the artifact byte-identical for the
// same content, so merging what another session wrote does not churn the file. The
// registry's `worktrees` array is emitted in one stable position, verbatim, and only
// when the loaded document carried it, so a round trip of an untouched shared file
// reproduces its bytes.
function serializeWorktreeMetadataFile(file) {
	const records = {};
	for (const path of Object.keys(file.records).sort()) records[path] = orderedRecord(file.records[path]);
	const document = { kind: file.kind, version: file.version };
	if (hasOwn(file, 'worktrees')) document.worktrees = file.worktrees;
	document.records = records;
	return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * What the file holds. `missing`, `unreadable` and `unsupported` never throw: an
 * absent file is a new clone, and a file this version cannot understand is reported
 * so a caller can say so instead of overwriting it.
 */
function readWorktreeMetadataStore(path) {
	let text;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') return { status: 'missing' };
		return { status: 'unreadable', detail: error.message };
	}
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return { status: 'unreadable', detail: 'invalid JSON' };
	}
	if (!isRecord(value)) return { status: 'unreadable', detail: 'not a JSON object' };
	const sharedDocument = hasOwn(value, 'worktrees');
	if (value.version !== WORKTREE_METADATA_VERSION) {
		return { status: 'unsupported', detail: 'written by another version', version: value.version };
	}
	// The kind is this module's own discriminator, but the clone file the registry
	// writes carries `worktrees` and no kind: that document is legitimate, so it is
	// read as this store rather than refused as written by another version.
	if (value.kind !== WORKTREE_METADATA_KIND && !(value.kind === undefined && sharedDocument)) {
		return { status: 'unsupported', detail: 'written by another version', version: value.version };
	}
	const unexpected = Object.keys(value).filter((key) => !STORE_KEYS.includes(key));
	if (unexpected.length > 0) return { status: 'unreadable', detail: `unexpected top-level key: ${unexpected[0]}` };
	// A shared document with no `records` yet is a valid empty store, not corrupt.
	const rawRecords = value.records === undefined && sharedDocument ? {} : value.records;
	if (!isRecord(rawRecords)) return { status: 'unreadable', detail: 'records is not an object' };

	const records = {};
	const drops = [];
	for (const [path, raw] of Object.entries(rawRecords)) {
		if (!isCanonicalWorktreePath(path)) {
			drops.push({ path, reason: 'not a canonical absolute path' });
			continue;
		}
		const record = normalizeWorktreeMetadataRecord(raw);
		if (!record) {
			drops.push({ path, reason: 'record does not match this version' });
			continue;
		}
		records[path] = record;
	}
	const file = { kind: WORKTREE_METADATA_KIND, version: WORKTREE_METADATA_VERSION, records };
	if (sharedDocument) file.worktrees = value.worktrees;
	return { status: 'valid', file, drops };
}

/**
 * Replace a JSON store through a sibling temp file and a rename. A direct write
 * that is interrupted leaves truncated JSON, which the readers must then reject as
 * unreadable, so the destination is only ever swapped for a complete file and the
 * temp file is removed on every failure path. Shared by the profiles store and the
 * per-repository profile pin so both stores keep the same atomicity guarantee.
 */
function writeJsonFileAtomicallySync(path, text) {
	// Replacing a file with identical bytes is not a change, so it is skipped instead
	// of churning the mtime. Pin writes are the reason this matters: re-applying the
	// profile a repository already pins must not touch the pin file. An unreadable or
	// missing destination simply falls through to the atomic write below.
	try {
		if (readFileSync(path, 'utf8') === text) return;
	} catch {
		// Fall through: the file is absent or not readable as text.
	}
	mkdirSync(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	const descriptor = openSync(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
		0o600,
	);
	// Every step records its own failure and cleanup never throws, so the error
	// that actually broke the write is the one reported: a failing close or unlink
	// must not mask a failed write or rename, and the temp file is removed on every
	// path.
	const failures = [];
	try {
		writeFileSync(descriptor, text);
	} catch (error) {
		failures.push(error);
	}
	try {
		closeSync(descriptor);
	} catch (error) {
		failures.push(error);
	}
	if (failures.length === 0) {
		try {
			renameSync(temporary, path);
		} catch (error) {
			failures.push(error);
		}
	}
	try {
		unlinkSync(temporary);
	} catch (error) {
		if (error.code !== 'ENOENT') failures.push(error);
	}
	if (failures.length > 0) throw failures[0];
}

/**
 * Merge records into the store through a re-read, then replace the file atomically.
 *
 * Every worktree and session of a clone shares the file, so the read that matters is
 * the one immediately before the write: the caller passes only the records it owns
 * and merging keeps everything another session wrote in between. A file this version
 * cannot fully understand is never overwritten — the write is refused with an error
 * naming why, and the bytes and record count stay exactly as they were.
 */
function saveWorktreeMetadataRecords(storePath, records) {
	const writes = {};
	for (const [path, record] of Object.entries(records)) {
		if (!isCanonicalWorktreePath(path)) {
			throw new WorktreeMetadataError(
				'invalid-record',
				`worktree metadata keys must be canonical absolute paths: ${JSON.stringify(path)}`,
			);
		}
		const normalized = normalizeWorktreeMetadataRecord(record);
		if (!normalized) {
			throw new WorktreeMetadataError('invalid-record', `worktree metadata record for ${path} is incomplete`);
		}
		writes[path] = normalized;
	}

	const existing = readWorktreeMetadataStore(storePath);
	if (existing.status === 'unreadable') {
		throw new WorktreeMetadataError(
			'unreadable-store',
			`refusing to overwrite an unreadable worktree metadata file: ${storePath} (${existing.detail})`,
		);
	}
	if (existing.status === 'unsupported') {
		throw new WorktreeMetadataError(
			'unsupported-store',
			`refusing to overwrite worktree metadata written by another version: ${storePath} (version ${String(existing.version)})`,
		);
	}
	if (existing.status === 'valid' && existing.drops.length > 0) {
		throw new WorktreeMetadataError(
			'undecodable-store',
			`refusing to overwrite a worktree metadata file with records this version cannot decode: ${storePath} (${existing.drops
				.map((drop) => drop.path)
				.join(', ')})`,
		);
	}

	const merged = existing.status === 'valid' ? { ...existing.file.records } : {};
	for (const [path, record] of Object.entries(writes)) merged[path] = record;
	const file = { kind: WORKTREE_METADATA_KIND, version: WORKTREE_METADATA_VERSION, records: merged };
	// Merge into `records` only: the registry's `worktrees` value is not ours to
	// interpret, so it is carried into the written document unchanged.
	if (existing.status === 'valid' && hasOwn(existing.file, 'worktrees')) file.worktrees = existing.file.worktrees;
	writeJsonFileAtomicallySync(storePath, serializeWorktreeMetadataFile(file));
	return file;
}

/** The record a create call stores, with what a fresh worktree has not observed yet defaulted. */
function createWorktreeMetadataRecord(input, now = new Date()) {
	const createdAt = input.createdAt ?? now.toISOString();
	return {
		// S4: an omitted ODD is stored as an ABSENT field, never as null, `''` or `'-'`.
		...(input.odd === undefined ? {} : { odd: input.odd }),
		createdAt,
		createdBy: input.createdBy,
		adminId: input.adminId,
		branchAtCreation: input.branchAtCreation,
		baseRef: input.baseRef,
		hooks: [...(input.hooks ?? [])],
		setup: input.setup ?? emptyWorktreeSetup(),
		lastSeen: input.lastSeen ?? { at: createdAt, status: 'active' },
	};
}

// ---- Git answers and the filesystem seams ----

/**
 * `git worktree list --porcelain` as entries. Records are separated by a blank line
 * in the ordinary output and by a NUL in `-z` output, so both spellings parse here.
 */
function parseWorktreeListPorcelain(text) {
	const entries = [];
	let current;
	const commit = () => {
		if (current) entries.push(current);
		current = undefined;
	};
	for (const rawLine of text.replaceAll('\0', '\n').split('\n')) {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0) {
			commit();
			continue;
		}
		const separator = line.indexOf(' ');
		const field = separator === -1 ? line : line.slice(0, separator);
		const value = separator === -1 ? '' : line.slice(separator + 1);
		switch (field) {
			case 'worktree':
				commit();
				current = { path: value };
				break;
			case 'HEAD':
				if (current) current.head = value;
				break;
			case 'branch':
				if (current) current.branch = value.replace(/^refs\/heads\//, '');
				break;
			case 'detached':
				if (current) current.detached = true;
				break;
			case 'bare':
				if (current) current.bare = true;
				break;
			case 'prunable':
				if (current) {
					current.prunable = true;
					if (value) current.prunableReason = value;
				}
				break;
		}
	}
	commit();
	return entries;
}

/** The worktree's administrative directory through `git rev-parse --git-dir`, canonical and absolute. */
function readWorktreeAdminDirFromGit(run, path) {
	const result = run(path, ['rev-parse', '--path-format=absolute', '--git-dir']);
	if (!result || result.code !== 0) return undefined;
	const value = result.stdout.replace(/\r?\n$/, '');
	return value.length > 0 ? resolve(path, value) : undefined;
}

function adminDirFromFileSystem(path) {
	const marker = join(path, '.git');
	let info;
	try {
		info = statSync(marker);
	} catch {
		return undefined;
	}
	if (info.isDirectory()) {
		try {
			return realpathSync(marker);
		} catch {
			return marker;
		}
	}
	if (!info.isFile()) return undefined;
	let text;
	try {
		text = readFileSync(marker, 'utf8');
	} catch {
		return undefined;
	}
	const match = /^gitdir:\s*(.+)$/m.exec(text);
	if (!match) return undefined;
	if (!isAbsolute(match[1].trim())) return undefined;
	try {
		return realpathSync(match[1].trim());
	} catch {
		return match[1].trim();
	}
}

/** Filesystem-only environment: reads `<path>/.git` instead of spawning Git. */
const defaultWorktreeReconcileEnvironment = {
	stat: (path) => {
		try {
			lstatSync(path);
			return 'present';
		} catch {
			return 'absent';
		}
	},
	realpath: (path) => {
		try {
			return realpathSync(path);
		} catch {
			return undefined;
		}
	},
	adminDir: adminDirFromFileSystem,
};

// ---- Reconciliation (S8) and existence verification (S12) ----

function canonicalPath(path, environment) {
	const absolute = stripTrailingSeparators(isAbsolute(path) ? normalize(path) : resolve(path));
	return stripTrailingSeparators(environment.realpath(absolute) ?? absolute);
}

function isInsideDirectory(child, parent) {
	const comparable = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
	const rest = relative(comparable(parent), comparable(child));
	return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
}

function observe(record, observation) {
	return { ...record, lastSeen: observedLastSeen(record.lastSeen, observation) };
}

/**
 * What one observation writes into `lastSeen`. A gone record keeps the date it was last
 * present and dates the removal from the first observation that missed it, so a later
 * verification neither re-dates the removal nor claims to have seen it.
 */
function observedLastSeen(current, observation) {
	const branch = observation.branch ?? current.branch;
	if (observation.status === 'gone') {
		const seen = { at: current.at, status: 'gone', goneSince: current.goneSince ?? observation.at };
		if (branch !== undefined) seen.branch = branch;
		return seen;
	}
	const seen = { at: observation.at, status: observation.status };
	if (branch !== undefined) seen.branch = branch;
	return seen;
}

function comparableRecords(records) {
	const sorted = {};
	for (const path of Object.keys(records).sort()) {
		sorted[path] = normalizeWorktreeMetadataRecord(records[path]) ?? records[path];
	}
	return JSON.stringify(sorted);
}

/**
 * Join the stored records with what Git and the filesystem answer now.
 *
 * The canonical path is the primary key and `adminId` is the reconciliation key, so
 * a worktree moved to another path keeps its record and its ODD while a recycled path
 * does not hand the old record to the new worktree. The returned `records` is the
 * observation of every stored record and never drops one: a record whose path is
 * gone, foreign or recycled stays in the file with an updated `lastSeen`.
 */
function reconcileWorktrees(input) {
	const environment = input.environment ?? defaultWorktreeReconcileEnvironment;
	const stateFor = (record) => worktreeStateForRecord(record, input.setupJobLiveness);
	const at = (input.now ?? (() => new Date()))().toISOString();
	const commonDir = canonicalPath(input.commonDir, environment);

	const stored = new Map();
	for (const [key, record] of Object.entries(input.records)) {
		stored.set(canonicalPath(key, environment), { key, record });
	}

	const worktrees = [];
	const resolved = new Map();

	for (const entry of input.entries) {
		const path = canonicalPath(entry.path, environment);
		const storedAtPath = stored.get(path);
		const present = entry.prunable !== true && environment.stat(path) === 'present';

		if (!present) {
			const record = storedAtPath ? observe(storedAtPath.record, {
				at,
				branch: entry.branch ?? storedAtPath.record.lastSeen.branch,
				status: 'missing',
			}) : undefined;
			if (storedAtPath && record) resolved.set(path, { path, record });
			worktrees.push({
				path,
				state: { id: 'missing' },
				adminId: storedAtPath?.record.adminId,
				branch: entry.branch,
				record,
				orphaned: false,
			});
			continue;
		}

		const adminDir = environment.adminDir(path);
		const adminId = adminDir === undefined ? undefined : basename(adminDir);
		if (adminDir === undefined || !isInsideDirectory(adminDir, commonDir)) {
			const record = storedAtPath ? observe(storedAtPath.record, {
				at,
				branch: entry.branch ?? storedAtPath.record.lastSeen.branch,
				status: 'foreign',
			}) : undefined;
			if (storedAtPath && record) resolved.set(path, { path, record });
			worktrees.push({
				path,
				state: { id: 'foreign' },
				adminId: adminId ?? storedAtPath?.record.adminId,
				branch: entry.branch,
				record,
				orphaned: false,
			});
			continue;
		}

		if (storedAtPath && storedAtPath.record.adminId === adminId) {
			const record = observe(storedAtPath.record, { at, branch: entry.branch, status: 'active' });
			resolved.set(path, { path, record });
			worktrees.push({
				path,
				state: stateFor(record),
				adminId,
				branch: entry.branch,
				record,
				orphaned: false,
			});
			continue;
		}

		// Same adminId at a different path is this worktree moved, so it keeps its record.
		let moved;
		for (const [canonicalKey, candidate] of stored) {
			if (resolved.has(canonicalKey) || candidate.record.adminId !== adminId) continue;
			moved = { canonicalKey, record: candidate.record };
			break;
		}
		if (moved && adminId !== undefined) {
			const record = observe(moved.record, { at, branch: entry.branch, status: 'active' });
			resolved.set(moved.canonicalKey, { path, record });
			worktrees.push({
				path,
				state: stateFor(record),
				movedFrom: moved.canonicalKey,
				adminId,
				branch: entry.branch,
				record,
				orphaned: false,
			});
			continue;
		}

		// A different adminId owns this path: the new worktree needs a fresh record, and
		// the stored one is left for the record-only pass below to report as orphaned.
		worktrees.push({
			path,
			state: { id: 'active-manual' },
			adminId,
			branch: entry.branch,
			orphaned: false,
		});
	}

	// Records Git no longer lists. They stay stored: this is an observation, not a prune.
	for (const [canonicalKey, candidate] of stored) {
		if (resolved.has(canonicalKey)) continue;
		const present = environment.stat(canonicalKey) === 'present';
		const adminDir = present ? environment.adminDir(canonicalKey) : undefined;
		const belongsHere = adminDir !== undefined && isInsideDirectory(adminDir, commonDir);
		const foreign = present && !belongsHere;
		const orphaned = present && belongsHere && basename(adminDir) !== candidate.record.adminId;
		const goneReason = foreign
			? undefined
			: orphaned
				? 'recycled'
				: belongsHere
					? 'broken-registration'
					: 'path-absent';
		const record = observe(candidate.record, {
			at,
			branch: candidate.record.lastSeen.branch,
			status: foreign ? 'foreign' : 'gone',
		});
		resolved.set(canonicalKey, { path: canonicalKey, record });
		const entry = {
			path: canonicalKey,
			state: { id: foreign ? 'foreign' : 'gone' },
			adminId: candidate.record.adminId,
			record,
			orphaned,
		};
		if (goneReason !== undefined) entry.goneReason = goneReason;
		worktrees.push(entry);
	}

	const records = {};
	for (const canonicalKey of stored.keys()) {
		const resolution = resolved.get(canonicalKey);
		if (resolution) records[resolution.path] = resolution.record;
	}

	return { worktrees, records, changed: comparableRecords(input.records) !== comparableRecords(records) };
}

module.exports = {
	WORKTREE_METADATA_KIND,
	WORKTREE_METADATA_VERSION,
	WORKTREE_METADATA_DIRECTORY,
	WORKTREE_METADATA_FILENAME,
	worktreeMetadataFilePath,
	WORKTREE_SETUP_STATUSES,
	WORKTREE_HOOK_OUTCOMES,
	WORKTREE_OBSERVED_STATUSES,
	WORKTREE_GONE_REASONS,
	emptyWorktreeMetadataFile,
	emptyWorktreeSetup,
	WORKTREE_STATE_IDS,
	WORKTREE_STATE_LABELS,
	worktreeStateLabel,
	WORKTREE_SETUP_STATE_DISPLAY,
	currentWorktreeSetupStep,
	worktreeStateForRecord,
	worktreeGoneDate,
	WorktreeMetadataError,
	normalizeWorktreeMetadataRecord,
	isCanonicalWorktreePath,
	serializeWorktreeMetadataFile,
	readWorktreeMetadataStore,
	saveWorktreeMetadataRecords,
	createWorktreeMetadataRecord,
	parseWorktreeListPorcelain,
	readWorktreeAdminDirFromGit,
	defaultWorktreeReconcileEnvironment,
	reconcileWorktrees,
};
