'use strict';
// identity-command (S1-S4): the user's own name, in ONE persisted document, read by the prompt card
// and appended to the orchestrator's prompt as a single line.
//
// WHERE IT LIVES (D1). The shell API's own store, the same one `lib/modules.js` writes: plugin id
// `odd-worktree` → document key `identity` → `{ schema: 1, name: "<name>" }`. It is persisted (a
// stored name survives a restart of Pi) and read SYNCHRONOUSLY through the shell API's published
// object (`shellApi()` from `lib/file-card-resolver.js`), which is exactly what lets a paint read
// it. A missing, malformed, wrong-version or unreadable document is NO NAME: never a guess and
// never a throw. Clearing overwrites that one document and touches no other key, so the `modules`
// document in the same store is never disturbed.
//
// WHAT A NAME MAY BE (D2). Trimmed, internal whitespace runs collapsed to one space, C0/C1 control
// characters dropped, 1 to 40 CODE POINTS after that. The name reaches a system prompt, so it stays
// one printable line; a value that does not normalize is refused, never repaired.
//
// WHERE IT IS INJECTED (D4). `systemPromptOptions.appendSystemPrompt`, append-only, with the same
// guards the `## ODD worktrees` section follows (`lib/odd-worktrees-prompt.js`): a
// `GENTLE_PI_AGENTS_CHILD=1` session and a named-agent event get nothing, because this line is the
// orchestrator's. TWO things decide it, and both must hold (S4 of card-message): a stored name AND
// this package's `Card message` switch On (`cardMessageOn()`, `lib/card-message.js`). With either
// missing, nothing is appended. `/identity` itself is untouched by that switch: the name is still
// stored, reported and cleared whatever `Card message` says (S3).
//
// THE TEXT IS PROSE ON DISK (S4). The block lives in `lib/identity-prompt/user-identity.md`, next to
// the worktree and CodeGraph rule files, so it can be read and edited without touching code; the
// `{{name}}` placeholder is what the normalized name replaces. A missing file, or one that does not
// open with the heading, falls back to the same text in code here (read ONCE, at load).
//
// The store name is the literal `lib/modules.js` owns (that module keeps the one store name for this
// package), repeated here with this comment rather than exported from there.

const fs = require('node:fs');
const path = require('node:path');

const { cardMessageOn } = require('./card-message.js');
const { shellApi } = require('./file-card-resolver.js');

const OWN_STORE = 'odd-worktree';
const IDENTITY_KEY = 'identity';
const IDENTITY_SCHEMA = 1;
/** The heading the prompt card wears when no name is stored. */
const IDENTITY_TITLE = 'You';
/** The heading is the identity of the block, so an already-injected section is never added twice. */
const SECTION_MARKER = '## User identity';
const MAX_NAME_LENGTH = 40;

// The one placeholder the prose on disk states, and the text that replaces it.
const NAME_PLACEHOLDER = '{{name}}';

// The block lives in its own Markdown file, beside the worktree and CodeGraph rule files, so it can
// be read, reviewed and edited as prose. A missing or unusable file falls back to the same text in
// code: the block still injects, never crashes a session, and the idempotency marker still works.
const PROMPT_DIR = path.join(__dirname, 'identity-prompt');
const PROMPT_FILE = path.join(PROMPT_DIR, 'user-identity.md');
const FALLBACK = `${SECTION_MARKER}\n\nThe user's name is ${NAME_PLACEHOLDER}.`;

function readPromptFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text.length > 0 && text.startsWith(SECTION_MARKER) ? text : null;
  } catch {
    return null;
  }
}

const SECTION_TEMPLATE = readPromptFile(PROMPT_FILE) || FALLBACK;
// The sentence alone: the template after its heading line and the blank line under it, so the line
// and the block can never disagree about what the file says.
const LINE_TEMPLATE = SECTION_TEMPLATE.startsWith(`${SECTION_MARKER}\n\n`)
  ? SECTION_TEMPLATE.slice(SECTION_MARKER.length + 2)
  : SECTION_TEMPLATE;

// C0 and C1 controls, DEL included: a name is one printable line and nothing else.
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;
// The controls that are ALSO whitespace (tab, LF, VT, FF, CR, NEL). They keep the separator they
// stood for, so a pasted `"Jona\t\nSoto"` is `Jona Soto` and not one run-together word; every other
// control is dropped, and the runs collapse AFTER the drop, so a dropped control never leaves the
// double space of a broken run behind either.
const CONTROL_WHITESPACE = /[\u0009-\u000D\u0085]/g;
const WHITESPACE_RUN = /\s+/g;
// A markdown heading run. Every prompt block this package appends is found by its own
// `## <heading>` marker, so a name that could form one would make an older block disappear from
// the next append; a name may not carry the run. A `#` with no `## ` after it is still a name
// (`C#`, `#designer`), because no block begins that way.
const HEADING_RUN = '## ';

/**
 * The name a command may store, or `undefined` when the value is not one. Never throws.
 *
 * Trimmed, internal runs collapsed to one space, controls dropped in the order stated above, no
 * markdown heading run, and the length counted in CODE POINTS, so an emoji is one character and
 * not two.
 */
function normalizeIdentityName(value) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(CONTROL_WHITESPACE, ' ')
    .replace(CONTROL_CHARS, '')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
  if (cleaned.length === 0) return undefined;
  if (cleaned.includes(HEADING_RUN)) return undefined;
  return [...cleaned].length > MAX_NAME_LENGTH ? undefined : cleaned;
}

// The store `lib/modules.js` creates, or `null` when the api cannot make one.
function storeOf(api) {
  if (api === null || typeof api !== 'object' || typeof api.createStore !== 'function') return null;
  return api.createStore(OWN_STORE);
}

// The `identity` document, or `undefined` for every shape that is not an object.
function storedDocument(store) {
  const stored = store.get(IDENTITY_KEY, undefined);
  return stored !== null && typeof stored === 'object' && !Array.isArray(stored) ? stored : undefined;
}

/** The stored name, normalized, or `undefined` when nothing usable is stored. Never throws. */
function readIdentityName(api) {
  try {
    const store = storeOf(api);
    if (store === null) return undefined;
    const document = storedDocument(store);
    if (document === undefined || document.schema !== IDENTITY_SCHEMA) return undefined;
    return normalizeIdentityName(document.name);
  } catch {
    return undefined;
  }
}

/**
 * Persist one name, keeping every other document of the store. Answers `true` when it wrote and
 * `false` for a refused name or an api with no store, so a caller never promises a write that did
 * not happen. Never throws.
 */
function writeIdentityName(api, value) {
  try {
    const name = normalizeIdentityName(value);
    if (name === undefined) return false;
    const store = storeOf(api);
    if (store === null) return false;
    store.set(IDENTITY_KEY, { schema: IDENTITY_SCHEMA, name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the stored name, keeping every other document of the store, and answer whether anything
 * was removed (nothing stored is nothing to clear). Never throws.
 *
 * The published store has `get` and `set` only — the shell API's `Store` has no `delete` —
 * so the document is normally OVERWRITTEN with the cleared shape `{ schema: 1, name: null }`, which
 * the strict read above refuses: no name survives it. A store that does publish a `delete` (a fake,
 * or a later shell API) is asked for it instead, so nothing at all survives the clear.
 */
function clearIdentityName(api) {
  try {
    const store = storeOf(api);
    if (store === null) return false;
    // Nothing USABLE is nothing to clear: a document that already holds no name (the cleared
    // shape a previous clear wrote, a malformed one, another schema) is not written again.
    if (readIdentityName(api) === undefined) return false;
    if (typeof store.delete === 'function') {
      store.delete(IDENTITY_KEY);
      return true;
    }
    store.set(IDENTITY_KEY, { schema: IDENTITY_SCHEMA, name: null });
    return true;
  } catch {
    return false;
  }
}

/** The name the running process has stored right now, or `undefined`. Never throws. */
function currentIdentityName() {
  try {
    return readIdentityName(shellApi());
  } catch {
    return undefined;
  }
}

/** The one sentence the block states, or `''` for a value that is not a name (never a broken one). */
function identityLine(name) {
  const normalized = normalizeIdentityName(name);
  return normalized === undefined ? '' : LINE_TEMPLATE.split(NAME_PLACEHOLDER).join(normalized);
}

/** The block: the marker heading, a blank line, then exactly one sentence. `''` for no name. */
function identitySection(name) {
  const line = identityLine(name);
  return line === '' ? '' : `${SECTION_MARKER}\n\n${line}`;
}

// The names a named-agent event may carry, copied from `lib/odd-worktrees-prompt.js`: `agent` itself
// is listed because a plain string there is a named agent too, and an object is read through `.name`.
function namedAgentOf(event) {
  if (!event || typeof event !== 'object') return null;
  const candidates = [
    event.agentName,
    event.agent,
    event.name,
    event.agent && typeof event.agent === 'object' ? event.agent.name : undefined,
    event.subagent && typeof event.subagent === 'object' ? event.subagent.name : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

// The separator the existing text needs before the block starts, as the ODD section does it.
function separatorFor(existing) {
  if (existing.endsWith('\n\n')) return '';
  if (existing.endsWith('\n')) return '\n';
  return '\n\n';
}

// The heading a block is found by, as a LINE of its own: prose that merely mentions the heading
// is not the block, so it never suppresses the line a stored name states.
const SECTION_MARKER_LINE = new RegExp(`^${SECTION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');

/**
 * Whether `Card message` is On for this append: the injected seam when the caller gave one, else the
 * published `card-message` document. A seam that throws is a no, so an unreadable switch never
 * appends a block nobody asked for.
 */
function cardMessageSelected(deps) {
  try {
    if (typeof deps.cardMessage === 'function') return deps.cardMessage() === true;
    return cardMessageOn() === true;
  } catch {
    return false;
  }
}

/**
 * Append the block for this session to `event.systemPromptOptions.appendSystemPrompt`. Returns
 * nothing: the mutation is the whole contract. `deps.api` is the store seam (the published shell API
 * when it is absent), `deps.env` the environment the session runs with and `deps.cardMessage` the
 * `Card message` seam (the published switch when it is absent). Append-only: every existing byte
 * stays the prefix of the new value. Never throws.
 */
function appendUserIdentitySection(event, deps = {}) {
  try {
    const effectiveDeps = deps || {};
    const env = effectiveDeps.env || process.env;
    // A child and a named-agent event get none of it.
    if (env.GENTLE_PI_AGENTS_CHILD === '1') return;
    if (namedAgentOf(event) !== null) return;

    const name = effectiveDeps.api !== undefined
      ? readIdentityName(effectiveDeps.api)
      : currentIdentityName();
    const section = identitySection(name);
    // No stored name, no block: the name itself is the first switch.
    if (section === '') return;
    // And no card, no block: `Card message` Off appends nothing (S4).
    if (!cardMessageSelected(effectiveDeps)) return;

    const options = event && event.systemPromptOptions;
    if (!options || typeof options !== 'object') return;
    const existing = typeof options.appendSystemPrompt === 'string' ? options.appendSystemPrompt : '';
    if (SECTION_MARKER_LINE.test(existing)) return;
    options.appendSystemPrompt = existing.length === 0
      ? section
      : `${existing}${separatorFor(existing)}${section}`;
  } catch {
    // The prompt block must never break session start.
  }
}

module.exports = {
  OWN_STORE,
  IDENTITY_KEY,
  IDENTITY_SCHEMA,
  IDENTITY_TITLE,
  SECTION_MARKER,
  MAX_NAME_LENGTH,
  appendUserIdentitySection,
  clearIdentityName,
  currentIdentityName,
  identityLine,
  identitySection,
  normalizeIdentityName,
  readIdentityName,
  writeIdentityName,
};
