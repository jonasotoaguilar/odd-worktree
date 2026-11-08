'use strict';
// S7/S8/S9: the ONE active-session guard for checkout deletion.
//
// `worktree_close` and the warp panel's Ctrl+D both ask this module before they
// remove a checkout, so the two surfaces can never disagree about whether a
// checkout is in use.
//
// WHAT IT CONSUMES. Gentle Shell (an optional host, present on this machine)
// publishes a bounded presence store at
// `<agent home>/gentle-agents/presence` (upstream
// lib/orchestrator-presence.ts): one `<sessionHash>.<incarnation>.header.json`
// heartbeat per live Pi session, plus an optional `.discovery.json` sidecar
// whose `metadata.workspace` is that session's own cwd
// (lib/orchestrator-discovery.ts). Both are deliberately public metadata — a
// label, a hash, a workspace path, counters — never a transcript, a prompt or a
// credential. This module reads exactly those two files, validates them against
// the published shapes, and never reads the `.activity.json` payload, the
// catalog, or a session file.
//
// WHAT IT DELIBERATELY DOES NOT CONSUME. Gentle Shell's scratch ledger
// (lib/session-scratch.ts) records the clones and worktrees a session CREATED,
// keyed by that session's id, with its pid and process start token. Creation is
// not occupancy: the creating session may have finished or warped away, so
// blocking on it would refuse legitimate removals and invent authority the
// ledger does not carry. Presence (heartbeat + workspace) is the mechanism that
// answers "is a live session working here", so it is the only blocking
// evidence.
//
// WHAT "LIVE" MEANS HERE. A heartbeat counts only when it is not in the future
// and is at most `PRESENCE_FRESH_MS` old — the same recency window upstream
// computes for a peer. Everything else is STALE: Gentle Shell never deletes a
// record a crashed process left behind, so a stale record cannot block a
// removal forever. It is reported instead (see `notice`), because the honest
// statement is "no live session found, and N records were too old to prove
// anything".
//
// BOUNDS AND HONESTY. The scan reads at most `MAX_PRESENCE_ENTRIES` records,
// each under `HEADER_LIMIT` bytes, following no symbolic link (a linked
// presence directory or record is refused, never followed). Malformed records
// are counted, not thrown. When the store is absent, the guard says
// "unavailable" and blocks nothing: this check is BEST EFFORT and is not
// claimed to be exhaustive. A record whose discovery sidecar is missing or
// names no usable workspace is UNKNOWN — it can never be attributed to a
// checkout, so it never blocks and is reported in the evidence the caller
// displays.
//
// NAMING A SESSION. The presence store publishes only the sha256 of a session
// id, never the id itself. The raw id lives in Gentle Shell's transport presence
// registry (`<agent home>/gentle-agents/transport/presence/<sessionId>.<token>
// .json`, upstream lib/agents-session-transport.ts), which is published for
// other sessions to address this one. This module joins the two: a validated
// transport record whose `sessionId` hashes to the presence header's
// `sessionHash` names that session, and nothing else can. The registry is read
// with upstream's own rules — private 0700 directories, a regular same-user
// file under 8 KiB, no symbolic link, a filename whose id and token match the
// body, exactly four keys, a version-1 record — and only `sessionId` is
// consumed: the endpoint is never opened, never connected to, and never used to
// read a session. When no record joins (a peer that has not published one, an
// over-cap scan, an unreadable registry), the refusal falls back to the
// published presence hash and SAYS SO; it never guesses an id.
//
// No static package imports (node builtins only), so the extension's
// copy-to-.mjs test loaders keep working. Nothing here writes, moves, links or
// deletes anything.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { stripVTControlCharacters } = require('node:util');

// Upstream's `recent` window for a presence header (orchestrator-presence.ts
// publishes every 5 s; orchestrator-discovery.ts treats 15 s as recent).
const PRESENCE_FRESH_MS = 15000;
// Upstream's HEADER_LIMIT: a header or discovery sidecar is a small document.
const HEADER_LIMIT = 16 * 1024;
// A machine with more concurrent Pi sessions than this is pathological; the
// scan stops and says so rather than reading an unbounded directory.
const MAX_PRESENCE_ENTRIES = 128;
// How many blocked sessions one refusal names before it summarizes the rest.
const MAX_NAMED_SESSIONS = 3;

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RECORD = /^([a-f0-9]{64})\.([a-f0-9-]{36})\.(header|discovery)\.json$/;
const HEADER_KEYS = ['schema', 'sessionHash', 'incarnation', 'label', 'heartbeat', 'generation', 'counts', 'digest', 'unavailable'];
const DISCOVERY_KEYS = ['schema', 'sessionHash', 'incarnation', 'generation', 'metadata'];
const DISCOVERY_OPTIONAL_KEYS = ['scope', 'state', 'aliases'];
const COUNT_KEYS = ['running', 'queued', 'waiting', 'finished'];

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const hasExactKeys = (value, keys) => isObject(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

function agentHomeFor(env) {
  const source = isObject(env) ? env : {};
  for (const key of ['GENTLE_PI_AGENT_HOME', 'PI_CODING_AGENT_DIR']) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return path.join(os.homedir(), '.pi', 'agent');
}

// The presence directory Gentle Shell publishes to, derived with ITS resolution
// rule (lib/agent-home.ts) so both extensions name the same store.
function presenceDirectoryFor(env) {
  return path.join(agentHomeFor(env), 'gentle-agents', 'presence');
}

function hashSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  return crypto.createHash('sha256').update(sessionId).digest('hex');
}

// Upstream's display-label normalization, used only to validate that a
// published workspace is a literal path and not something a control character
// or a collapsed whitespace run could disguise as another checkout.
function normalizedLabel(text) {
  const clean = stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(clean).slice(0, 120).join('').trimEnd();
}

function usableWorkspace(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  // Upstream publishes "" for a workspace it will not advertise (too long, or
  // not identical to its normalized form). Anything that is not a literal
  // absolute path is unusable evidence, never a guess.
  if (value !== normalizedLabel(value)) return null;
  if (!path.isAbsolute(value)) return null;
  return value;
}

function validHeader(value) {
  if (!hasExactKeys(value, HEADER_KEYS)) return null;
  if (value.schema !== 1) return null;
  if (typeof value.sessionHash !== 'string' || !HASH.test(value.sessionHash)) return null;
  if (typeof value.incarnation !== 'string' || !UUID.test(value.incarnation)) return null;
  if (typeof value.label !== 'string' || value.label !== normalizedLabel(value.label)) return null;
  if (!isCount(value.heartbeat) || !isCount(value.generation) || value.generation === 0) return null;
  if (!hasExactKeys(value.counts, COUNT_KEYS) || !COUNT_KEYS.every((key) => isCount(value.counts[key]))) return null;
  const digestOk = value.unavailable === null && typeof value.digest === 'string' && HASH.test(value.digest);
  const oversized = value.unavailable === 'activity-too-large' && value.digest === null;
  if (!digestOk && !oversized) return null;
  return value;
}

// The discovery sidecar carries the session's workspace. Only the identity and
// the workspace are consumed; the curated state, aliases and scope are not read
// into anything this module returns.
function discoveryWorkspace(value, header) {
  if (!isObject(value)) return null;
  const allowed = new Set([...DISCOVERY_KEYS, ...DISCOVERY_OPTIONAL_KEYS]);
  if (!Object.keys(value).every((key) => allowed.has(key))) return null;
  if (!DISCOVERY_KEYS.every((key) => Object.hasOwn(value, key))) return null;
  if (value.schema !== 1) return null;
  if (value.sessionHash !== header.sessionHash || value.incarnation !== header.incarnation) return null;
  if (value.generation !== header.generation) return null;
  if (!isObject(value.metadata)) return null;
  return usableWorkspace(value.metadata.workspace);
}

// A bounded read of ONE regular file: no symbolic link, a single link, the size
// checked before and after opening, and the same inode read as the one
// inspected (upstream `boundedRead`). Anything else throws and is counted as a
// rejected record by the caller.
async function readBoundedFile(file, limit) {
  const before = await fsPromises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('unsafe-file');
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && before.uid !== process.getuid()) {
    throw new Error('unsafe-file');
  }
  if (before.size > limit) throw new Error('oversized-file');
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW ?? 0)
    | (fs.constants.O_NONBLOCK ?? 0);
  const handle = await fsPromises.open(file, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe-file');
    if (stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('changed-file');
    if (stat.size > limit) throw new Error('oversized-file');
    const buffer = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used !== stat.size) throw new Error('changed-file');
    return buffer.subarray(0, used).toString('utf8');
  } finally {
    try { await handle.close(); } catch { /* a dead handle never fails the read */ }
  }
}

function reasonOf(error) {
  if (typeof error === 'string' && error.length > 0) return error;
  const code = error && error.code;
  if (code === 'ENOENT') return 'missing';
  if (code === 'EACCES' || code === 'EPERM') return 'not readable';
  if (code === 'ENOTDIR') return 'not a directory';
  if (error && error.message === 'unsafe-directory') {
    return 'the presence directory is a symbolic link, or not a private directory this session owns';
  }
  if (error && error.message === 'unsafe-file') return 'a presence record is a symbolic link, or not a private regular file';
  if (error && typeof error.message === 'string' && error.message.length > 0) return error.message;
  return 'unreadable';
}

// Upstream's private-directory rule: a real directory owned by this user with no
// group or other permission bits at all.
async function checkedDirectory(dir) {
  const stat = await fsPromises.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-directory');
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    if (stat.uid !== process.getuid()) throw new Error('unsafe-directory');
    if ((stat.mode & 0o077) !== 0) throw new Error('unsafe-directory');
  }
  return dir;
}

// Upstream's transport bounds (agents-session-transport.ts): a record is 8 KiB,
// the registry scan stops at 64 schema-matching files.
const TRANSPORT_MAX_BYTES = 8192;
const TRANSPORT_MAX_ENTRIES = 64;
// Upstream's session-id and record-name shapes. The 22-character token belongs
// to the endpoint socket and is part of the filename; this module never uses it.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const TRANSPORT_FILE = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\.([A-Za-z0-9_-]{22})\.json$/;

function transportDirectoryFor(env) {
  return path.join(agentHomeFor(env), 'gentle-agents', 'transport', 'presence');
}

// A transport directory is EXACTLY 0700 and owned by this user (upstream's
// `privateDirectory`). A linked or loosened directory is refused, never read.
async function privateDirectory700(dir) {
  const stat = await fsPromises.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-directory');
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    if (stat.uid !== process.getuid()) throw new Error('unsafe-directory');
    if ((stat.mode & 0o777) !== 0o700) throw new Error('unsafe-directory');
  }
  return dir;
}

// The record's raw session id, only when the body is the exact published shape
// and names the same id as the filename. Anything else is no identity at all.
function transportSessionId(value, expectedId) {
  if (!isObject(value)) return null;
  const keys = ['version', 'sessionId', 'endpoint', 'createdAt'];
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) return null;
  if (value.version !== 1 || typeof value.endpoint !== 'string' || !isCount(value.createdAt)) return null;
  if (typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId)) return null;
  return value.sessionId === expectedId ? value.sessionId : null;
}

// The published transport ids, read with upstream's bounds and refusals.
// Resolves; never rejects. `unavailable`/`truncated`/`rejected` are disclosure,
// not authority: a missing join can never name a session and never blocks.
async function readTransportSessions(options = {}) {
  const env = options && isObject(options.env) ? options.env : process.env;
  const maxEntries = isCount(options.maxEntries) && options.maxEntries > 0
    ? Math.min(options.maxEntries, TRANSPORT_MAX_ENTRIES)
    : TRANSPORT_MAX_ENTRIES;
  const base = path.join(agentHomeFor(env), 'gentle-agents');
  const dir = transportDirectoryFor(env);
  const unavailable = (reason) => ({
    status: 'unavailable', reason, sessionIds: [], scanned: 0, rejected: 0, truncated: false,
  });
  try {
    const shared = await fsPromises.lstat(base);
    if (!shared.isDirectory() || shared.isSymbolicLink()) throw new Error('unsafe-directory');
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && shared.uid !== process.getuid()) {
      throw new Error('unsafe-directory');
    }
    await privateDirectory700(path.join(base, 'transport'));
    await privateDirectory700(dir);
  } catch (error) {
    return unavailable(reasonOf(error));
  }
  let names;
  try {
    names = await fsPromises.readdir(dir);
  } catch (error) {
    return unavailable(reasonOf(error));
  }
  const matches = names.filter((name) => !name.startsWith('.') && TRANSPORT_FILE.test(name)).sort();
  const selected = matches.slice(0, maxEntries);
  const result = {
    status: 'ok', reason: null, sessionIds: [], scanned: 0, rejected: 0,
    truncated: matches.length > selected.length,
  };
  for (const name of selected) {
    result.scanned += 1;
    const match = TRANSPORT_FILE.exec(name);
    try {
      const text = await readBoundedFile(path.join(dir, name), TRANSPORT_MAX_BYTES);
      const id = transportSessionId(JSON.parse(text), match[1]);
      if (id === null) throw new Error('malformed');
      result.sessionIds.push(id);
    } catch {
      result.rejected += 1;
    }
  }
  return result;
}

function emptyRead() {
  return { status: 'ok', entries: [], scanned: 0, rejected: 0, truncated: false };
}

// One bounded read of the whole published store. Resolves; never rejects.
async function readGentlePresence(options = {}) {
  const env = options && isObject(options.env) ? options.env : process.env;
  const now = Number.isSafeInteger(options.now) ? options.now : Date.now();
  const maxEntries = isCount(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : MAX_PRESENCE_ENTRIES;
  const dir = presenceDirectoryFor(env);
  try {
    await checkedDirectory(dir);
  } catch (error) {
    return { ...emptyRead(), status: 'unavailable', reason: reasonOf(error) };
  }
  let names;
  try {
    names = await fsPromises.readdir(dir);
  } catch (error) {
    return { ...emptyRead(), status: 'unavailable', reason: reasonOf(error) };
  }
  const records = names
    .filter((name) => !name.startsWith('.') && RECORD.test(name))
    .sort();
  const headerNames = records.filter((name) => name.endsWith('.header.json'));
  const selected = headerNames.slice(0, maxEntries);
  const result = emptyRead();
  result.truncated = headerNames.length > selected.length;
  for (const name of selected) {
    result.scanned += 1;
    const match = RECORD.exec(name);
    try {
      const text = await readBoundedFile(path.join(dir, name), HEADER_LIMIT);
      const header = validHeader(JSON.parse(text));
      if (!header || header.sessionHash !== match[1] || header.incarnation !== match[2]) throw new Error('malformed');
      let workspace = null;
      try {
        const sidecar = await readBoundedFile(
          path.join(dir, `${header.sessionHash}.${header.incarnation}.discovery.json`),
          HEADER_LIMIT,
        );
        workspace = discoveryWorkspace(JSON.parse(sidecar), header);
      } catch {
        // A legacy publisher has no sidecar; an unreadable one is no evidence.
        workspace = null;
      }
      result.entries.push({
        sessionHash: header.sessionHash,
        incarnation: header.incarnation,
        label: header.label,
        heartbeat: header.heartbeat,
        // Published task counters, validated above and passed through
        // unchanged: the warp guard reads this session's own workload.
        counts: {
          running: header.counts.running,
          queued: header.counts.queued,
          waiting: header.counts.waiting,
          finished: header.counts.finished,
        },
        recent: now >= header.heartbeat && now - header.heartbeat <= PRESENCE_FRESH_MS,
        workspace,
        unknown: workspace === null,
      });
    } catch {
      result.rejected += 1;
    }
  }
  return result;
}

// Every identity a path can present: its resolved spelling plus, when the
// filesystem still resolves it, its realpath.
function pathIdentities(absolutePath) {
  const identities = new Set();
  if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) return identities;
  identities.add(path.resolve(absolutePath));
  try {
    identities.add(fs.realpathSync(absolutePath));
  } catch {
    // A directory that is gone contributes only its spelling.
  }
  return identities;
}

// True when `workspacePath` is the checkout or lives inside it. Comparison is by
// identity, so a symlink spelling of the same checkout still matches, and a
// sibling that merely shares a name prefix does not.
function withinCheckout(workspacePath, targetPath) {
  if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) return false;
  const targets = pathIdentities(targetPath);
  if (targets.size === 0) return false;
  for (const id of pathIdentities(workspacePath)) {
    for (const target of targets) {
      if (id === target || id.startsWith(target + path.sep)) return true;
    }
  }
  return false;
}

// How one blocked session is named. The RAW id when a validated transport
// record joins the presence hash, otherwise the published hash with an explicit
// "could not be resolved" clause at the refusal — never a label alone, which
// would not identify the session the human has to close or warp.
function sessionName(blocker) {
  if (typeof blocker.rawSessionId === 'string' && blocker.rawSessionId.length > 0) {
    return blocker.label ? `'${blocker.label}' (id ${blocker.rawSessionId})` : `id ${blocker.rawSessionId}`;
  }
  const id = typeof blocker.sessionHash === 'string' ? `presence ${blocker.sessionHash.slice(0, 12)}` : 'an unpublished identity';
  return blocker.label ? `'${blocker.label}' (${id})` : id;
}

function sessionNames(blockers, maxNamed) {
  const named = blockers.slice(0, maxNamed).map(sessionName).join(', ');
  const rest = blockers.length - Math.min(blockers.length, maxNamed);
  return rest > 0 ? `${named}, and ${rest} more` : named;
}

// Why no raw id joined, in words that are true of the evidence actually read: a
// missing registry means nothing was published, a broken one means nothing could
// be read, and a truncated scan means only that this record was not in it. The
// refusal never claims a peer failed to publish when the scan simply stopped.
function unresolvedReason(transport) {
  if (!isObject(transport) || transport.status !== 'ok') {
    const reason = isObject(transport) && typeof transport.reason === 'string' ? transport.reason : null;
    if (reason === null || reason === 'missing') return 'Gentle Shell published no transport record for that session';
    return `Gentle Shell's transport registry could not be read (${reason})`;
  }
  if (transport.truncated === true) return 'no matching transport record was in the bounded transport scan';
  return 'Gentle Shell published no transport record for that session';
}

// The refusal wording. Both callers show it verbatim, so it names the next step
// for the human and states that nothing was mutated. A blocker whose raw id did
// not join says so instead of presenting a hash as an id.
function refusalText(verdict, targetPath, blockers, maxNamed, transport) {
  if (verdict === 'current') {
    return `cannot close the worktree at ${targetPath}: this session is working in that checkout; `
      + 'move this session to another checkout first (run /warp, for example /warp principal), then close it; '
      + 'the checkout and the registry were left untouched';
  }
  const unresolved = blockers.filter((blocker) => typeof blocker.rawSessionId !== 'string').length;
  const unresolvedClause = unresolved === 0
    ? ''
    : `; ${unresolved === 1 ? unresolvedReason(transport) : 'no transport record joined those sessions'}, `
      + `so ${unresolved === 1 ? 'its session id could not be resolved' : 'their session ids could not be resolved'}`
      + ` (${unresolved === 1 ? 'its presence hash is' : 'their presence hashes are'} shown instead)`;
  return `cannot close the worktree at ${targetPath}: the Pi session ${sessionNames(blockers, maxNamed)} is working in that checkout`
    + unresolvedClause
    + '; make sure it has finished there, then close the checkout, or run /warp in that session to move it away; '
    + 'the checkout and the registry were left untouched';
}

// Decide, for ONE checkout, whether a live session is working in it.
//
// `presence` is the value `readGentlePresence` returned and `transport` the
// value `readTransportSessions` returned (both optional: a missing store is no
// evidence, never an invented one). `currentSessionId` is this session's id
// (hashed here for comparison with the published hash), and `currentCwd` is the
// checkout this session stands on — the deterministic fallback that works with
// no presence store at all. The evaluation itself is pure: same inputs, same
// verdict.
function evaluateCheckoutSessions(options = {}) {
  const now = Number.isSafeInteger(options.now) ? options.now : Date.now();
  const maxNamed = isCount(options.maxNamed) && options.maxNamed > 0 ? options.maxNamed : MAX_NAMED_SESSIONS;
  const targetPath = typeof options.targetPath === 'string' ? options.targetPath : '';
  const presence = isObject(options.presence) ? options.presence : { status: 'unavailable', entries: [] };
  const transport = isObject(options.transport)
    ? options.transport
    : { status: 'unavailable', reason: 'missing', sessionIds: [], scanned: 0, rejected: 0, truncated: false };
  const entries = Array.isArray(presence.entries) ? presence.entries : [];
  const currentHash = typeof options.currentSessionId === 'string'
    ? hashSessionId(options.currentSessionId)
    : null;
  // hash(sessionId) -> sessionId, from the published transport registry only.
  const idsByHash = new Map();
  for (const id of Array.isArray(transport.sessionIds) ? transport.sessionIds : []) {
    const digest = typeof id === 'string' ? hashSessionId(id) : null;
    if (digest !== null) idsByHash.set(digest, id);
  }

  const blockers = [];
  const stale = [];
  let liveWithoutWorkspace = 0;
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.sessionHash !== 'string') continue;
    if (entry.recent === true && entry.unknown === true) liveWithoutWorkspace += 1;
    if (typeof entry.workspace !== 'string' || !withinCheckout(entry.workspace, targetPath)) continue;
    const age = Number.isSafeInteger(entry.heartbeat) && now >= entry.heartbeat
      ? now - entry.heartbeat
      : null;
    const record = {
      kind: currentHash !== null && entry.sessionHash === currentHash ? 'current' : 'foreign',
      source: 'presence',
      label: typeof entry.label === 'string' ? entry.label : '',
      sessionHash: entry.sessionHash,
      rawSessionId: idsByHash.get(entry.sessionHash) ?? null,
      workspace: entry.workspace,
      heartbeatAgeMs: age,
    };
    if (entry.recent === true) {
      blockers.push(record);
    } else {
      stale.push(record);
    }
  }
  // The session standing in the checkout is caught even when Gentle Shell is
  // absent, has not published yet, or published a stale record.
  if (blockers.every((blocker) => blocker.kind !== 'current')
    && typeof options.currentCwd === 'string'
    && options.currentCwd.length > 0
    && withinCheckout(options.currentCwd, targetPath)) {
    blockers.unshift({
      kind: 'current',
      source: 'cwd',
      label: '',
      sessionHash: currentHash,
      rawSessionId: null,
      workspace: options.currentCwd,
      heartbeatAgeMs: 0,
    });
  }

  const verdict = blockers.some((blocker) => blocker.kind === 'current')
    ? 'current'
    : (blockers.length > 0 ? 'foreign' : 'clear');
  const unavailable = presence.status !== 'ok';
  const unknown = unavailable ? 0 : entries.filter((entry) => isObject(entry) && entry.unknown === true).length;
  const resolved = blockers.filter((blocker) => typeof blocker.rawSessionId === 'string').length;
  const evidence = {
    status: unavailable ? 'unavailable' : 'ok',
    reason: typeof presence.reason === 'string' ? presence.reason : null,
    scanned: isCount(presence.scanned) ? presence.scanned : 0,
    rejected: isCount(presence.rejected) ? presence.rejected : 0,
    truncated: presence.truncated === true,
    matched: blockers.length + stale.length,
    live: blockers.length,
    stale: stale.length,
    unknown,
    resolved,
    unresolved: blockers.length - resolved,
    transport: {
      status: transport.status === 'ok' ? 'ok' : 'unavailable',
      reason: typeof transport.reason === 'string' ? transport.reason : null,
      scanned: isCount(transport.scanned) ? transport.scanned : 0,
      rejected: isCount(transport.rejected) ? transport.rejected : 0,
      truncated: transport.truncated === true,
    },
  };
  // Best-effort disclosure for the CLEAR path: every line states something the
  // check could not prove. None of them blocks a removal — they travel to the
  // human-readable close output instead (S7: bounded, stale and unknown
  // evidence must be visible, never silently trusted or silently dropped).
  const notices = [];
  if (verdict === 'clear' && stale.length > 0) {
    const files = stale.length === 1 ? 'record' : 'records';
    notices.push(`session check: no live session found in the checkout (${stale.length} stale Gentle Shell presence ${files} ignored; best effort)`);
  }
  if (verdict === 'clear' && liveWithoutWorkspace > 0) {
    const peers = liveWithoutWorkspace === 1 ? 'record' : 'records';
    notices.push(`${liveWithoutWorkspace} live Gentle Shell presence ${peers} published no workspace, so the active-session check could not attribute ${liveWithoutWorkspace === 1 ? 'it' : 'them'} to any checkout (best effort)`);
  }
  if (verdict === 'clear' && evidence.truncated) {
    notices.push(`the Gentle Shell presence scan read only its first ${evidence.scanned} records, so the active-session check is partial (best effort)`);
  }
  if (verdict === 'clear' && evidence.transport.truncated) {
    notices.push('Gentle Shell\'s transport registry exceeded its bounded scan, so some session ids could not be resolved (best effort)');
  }
  if (verdict === 'clear' && unavailable && evidence.reason !== null && evidence.reason !== 'missing') {
    notices.push(`session check: Gentle Shell presence could not be read (${evidence.reason}); the active-session check is best effort`);
  }
  return {
    verdict,
    blockers,
    stale,
    evidence,
    notices,
    notice: notices.length > 0 ? notices.join(' ') : null,
    text: verdict === 'clear' ? null : refusalText(verdict, targetPath, blockers, maxNamed, transport),
  };
}

module.exports = {
  PRESENCE_FRESH_MS,
  presenceDirectoryFor,
  transportDirectoryFor,
  hashSessionId,
  readGentlePresence,
  readTransportSessions,
  evaluateCheckoutSessions,
};
