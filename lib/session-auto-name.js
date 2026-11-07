'use strict';
// Automatic session naming from the ODD document being written
// (odd/tasks/session-auto-name.md, D2-D7).
//
// Pure derivation, no I/O: the caller passes what a tool call touched, a
// reader for the touched document when it has one, and whether that call was
// a write, and gets back either the label to write or `null` for "leave the
// session alone".
//
// The channel is the session NAME (`pi.setSessionName`), because Pi 1.3.0
// exposes no subject/alias write (D7): the session record carries a single
// `name`. The never-clobber guarantee (P3) therefore cannot come from a
// channel choice, so it comes from PATTERN: the plugin may write only an
// empty name or a name it can account for as its own (see
// `isPluginSessionName`). Anything else was typed by a human and is
// untouchable. The admitted consequence (D7) is that a human who names a
// session exactly like a label the plugin would write owns a name the plugin
// may later update.
//
// The label head is the document's own first level-1 heading (D2: the honest
// source for what the session is about), and the filename slug is only the
// fallback for a document with no readable heading.
//
// Input rels are the canonical `odd/<rel>` names the worktree capture already
// produces, never raw filesystem paths: mapping a path to a document is path
// logic that lives in one place already.

// Document shape that names a session: `odd/tasks/<feature>.md`, where the
// feature may be nested (`odd/tasks/perf/plan.md`).
const ODD_TASKS_PREFIX = 'odd/tasks/';

// Separator between the label head and the branch discriminator (D4). The
// spaces make it a shape a human hand-typing a name rarely produces, and
// they are what distinguishes the label from a human `fix@home`.
const BRANCH_SEPARATOR = ' @ ';

// A heading-sized label beyond this loses the rest of the words, cut at the
// last word boundary so the name stays readable at a glance.
const LABEL_MAX_CHARS = 48;

// gentle-pi's ODD phase tool (L3). Its result says WHICH phase the session
// moved to, never WHICH feature it is about, so the phase trigger cannot
// derive anything: it re-applies what the session last derived from a write.
// It is observable only as a `tool_result`, not a host event.
const ODD_PHASE_TOOL_NAME = 'gentle_odd_phase';

// A fallback feature is one or more `/`-separated segments using the
// characters a document filename can carry, without whitespace. A branch is
// any whitespace-free token — permissive on purpose, because a branch with an
// unusual-but-legal character (say `#1`) must still be recognized as OUR
// label on the next event, or a resumed session would freeze on it forever.
const FEATURE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const BRANCH_TOKEN = /^\S+$/;

// The tools whose call WRITES a document. Reading is context gathering: it
// would make the name jump to whatever was opened last (P1), so `read` is
// deliberately absent.
const WRITE_TOOL_NAMES = new Set(['write', 'edit']);

// The last ODD label each session applied, keyed by session id. In-module so
// the phase trigger stays testable without the extension, and bounded so a
// long-lived process that sees many sessions cannot grow without limit; only
// the most recent sessions can still be alive and resumed.
const SESSION_MEMORY_LIMIT = 100;
const lastLabelBySession = new Map();

function sessionKey(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

function rememberLabel(sessionId, entry) {
  const key = sessionKey(sessionId);
  if (key === null) return;
  // Re-inserting moves the session to the young end of the insertion order,
  // so eviction always drops the least recently written session.
  lastLabelBySession.delete(key);
  lastLabelBySession.set(key, entry);
  while (lastLabelBySession.size > SESSION_MEMORY_LIMIT) {
    const oldest = lastLabelBySession.keys().next().value;
    lastLabelBySession.delete(oldest);
  }
}

function rememberedLabel(sessionId) {
  const key = sessionKey(sessionId);
  if (key === null) return null;
  return lastLabelBySession.get(key) || null;
}

function isWriteToolName(name) {
  return typeof name === 'string' && WRITE_TOOL_NAMES.has(name);
}

// `<feature>` for an `odd/tasks/<feature>.md` rel, else null. Rejects empty
// segments, nested `.`/`..`, and any name carrying whitespace or characters a
// feature document cannot have.
function featureFromOddRel(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  if (!rel.startsWith(ODD_TASKS_PREFIX)) return null;
  const tail = rel.slice(ODD_TASKS_PREFIX.length);
  if (!tail.endsWith('.md')) return null;
  const feature = tail.slice(0, -'.md'.length);
  if (feature.length === 0) return null;
  const segments = feature.split('/');
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !FEATURE_SEGMENT.test(segment)) return null;
  }
  return feature;
}

// The first `odd/tasks/<feature>.md` document of the call, or null. The
// first one wins because a multi-document write has no natural order.
function firstTaskDocument(rels) {
  if (!Array.isArray(rels)) return null;
  for (const rel of rels) {
    const feature = featureFromOddRel(rel);
    if (feature !== null) return { rel, feature };
  }
  return null;
}

// Cut to `max` characters at the last word boundary inside the cut, so a
// truncated label ends with a whole word. A single word longer than `max`
// has no boundary and is cut hard; anything short stays untouched.
function truncateLabel(text, max) {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
}

// The document's first level-1 ATX heading (`# ...`), trimmed with inner
// whitespace collapsed and truncated for the label, or null when the text
// carries none. A deeper heading (`## ...`) is a section title, not the
// document's own heading, and never matches.
function headingFromText(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    // ATX level-1 needs whitespace after the `#`; `##` and deeper are
    // section titles, and `#hashtag` is prose, not a heading.
    if (!/^#[ \t]/.test(line)) continue;
    const body = line.slice(1).trim();
    if (body.length === 0) continue;
    return truncateLabel(body.replace(/\s+/g, ' '), LABEL_MAX_CHARS);
  }
  return null;
}

// The label head for a document: its heading when there is one, else the
// filename slug. Deterministic for the same document, which is what keeps
// repeated events idempotent.
function labelHeadForDocument(feature, text) {
  const heading = headingFromText(text);
  return heading !== null ? heading : feature;
}

// Read the touched document through the caller's reader. Any failure — a
// reader that throws, a missing file, a non-string result — is "no heading"
// and falls back to the slug, never an error the naming path must handle.
function readDocumentText(readDocument, rel) {
  if (typeof readDocument !== 'function') return null;
  try {
    const text = readDocument(rel);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

// D4: the branch suffix is what keeps two concurrent forks of the same
// feature apart, since the worktree branch is already unique. A branch the
// caller cannot supply (an odd registry entry without one) degrades to the
// bare label head, which is still a label the plugin owns.
function sessionNameForFeature(feature, branch) {
  if (typeof branch === 'string' && BRANCH_TOKEN.test(branch)) {
    return `${feature}${BRANCH_SEPARATOR}${branch}`;
  }
  return feature;
}

function isFeatureName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const segments = name.split('/');
  return segments.every((segment) => segment !== '.' && segment !== '..' && FEATURE_SEGMENT.test(segment));
}

// The ownership test (D7), widened for heading labels: a name counts as the
// plugin's own when ANY of these holds.
//   (a) it is the label this session already applied (the memory below),
//       which is what lets the phase trigger reuse it;
//   (b) it ends with ` @ <branch>` for THIS worktree's branch — the property
//       that survives a resume without in-memory state, since the branch
//       suffix is applied on every write;
//   (c) it is the plain feature slug from the filename, i.e. what earlier
//       versions wrote before heading labels existed;
//   (d) it is the document's current heading.
// Called with no context it keeps the original contract: exactly the two
// shapes earlier versions wrote (`<feature>` and `<feature> @ <branch>`).
function isPluginSessionName(name, context) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const { branch, feature, documentLabel, appliedLabel } = context || {};
  if (typeof appliedLabel === 'string' && appliedLabel.length > 0 && name === appliedLabel) return true;
  if (typeof documentLabel === 'string' && documentLabel.length > 0 && name === documentLabel) return true;
  const at = name.indexOf(BRANCH_SEPARATOR);
  if (at === -1) {
    if (typeof feature === 'string' && feature.length > 0 && name === feature) return true;
    return isFeatureName(name);
  }
  const head = name.slice(0, at);
  const tail = name.slice(at + BRANCH_SEPARATOR.length);
  if (head.length === 0 || !BRANCH_TOKEN.test(tail)) return false;
  if (typeof branch === 'string' && branch.length > 0 && tail === branch) return true;
  return isFeatureName(head);
}

// May the plugin write over `name`? An unnamed session (empty, or no name
// entry at all — `getSessionName()` returns undefined) is adoptable; every
// other name must be the plugin's own.
function canAdoptSessionName(name, context) {
  if (name === undefined || name === null) return true;
  if (typeof name !== 'string') return false;
  return name.length === 0 || isPluginSessionName(name, context);
}

// The label for a tool call that touched `rels`, or null when the call is
// not a WRITE to an `odd/tasks/<feature>.md` document. No ownership is
// decided here; `planSessionRename` owns that.
function autoNameForToolCall({ rels, isWrite, branch, readDocument } = {}) {
  if (isWrite !== true) return null;
  const match = firstTaskDocument(rels);
  if (match === null) return null;
  const head = labelHeadForDocument(match.feature, readDocumentText(readDocument, match.rel));
  return sessionNameForFeature(head, branch);
}

// The single decision the write wiring needs. Returns the name to write, or
// null for "touch nothing", which covers three cases: the call did not write
// an ODD task document, the current name was chosen by a human, and the
// derived label is already the current name — the last one is what makes
// running this on every pipeline event idempotent instead of a stream of host
// writes. The derived label is remembered per session whether or not it was
// written, so a later phase transition can re-apply it.
function planSessionRename({ rels, isWrite, branch, currentName, sessionId, readDocument } = {}) {
  if (isWrite !== true) return null;
  const match = firstTaskDocument(rels);
  if (match === null) return null;
  const head = labelHeadForDocument(match.feature, readDocumentText(readDocument, match.rel));
  const label = sessionNameForFeature(head, branch);
  const previous = rememberedLabel(sessionId);
  const adoptable = canAdoptSessionName(currentName, {
    branch,
    feature: match.feature,
    documentLabel: head,
    appliedLabel: previous === null ? undefined : previous.label,
  });
  rememberLabel(sessionId, { label, head, branch });
  if (!adoptable || label === currentName) return null;
  return label;
}

// The phase trigger: an ODD phase transition with no feature of its own
// re-applies the label this session last derived from a write. Returns null
// for "touch nothing" when the session never wrote an ODD document, when the
// current name is a human's, or when the label is already applied.
function planPhaseSessionRename({ sessionId, branch, currentName } = {}) {
  const previous = rememberedLabel(sessionId);
  if (previous === null) return null;
  if (!canAdoptSessionName(currentName, { branch, appliedLabel: previous.label })) return null;
  const effectiveBranch = typeof branch === 'string' && branch.length > 0 ? branch : previous.branch;
  const label = sessionNameForFeature(previous.head, effectiveBranch);
  if (label === currentName) return null;
  rememberLabel(sessionId, { label, head: previous.head, branch: effectiveBranch });
  return label;
}

module.exports = {
  ODD_TASKS_PREFIX,
  BRANCH_SEPARATOR,
  LABEL_MAX_CHARS,
  ODD_PHASE_TOOL_NAME,
  autoNameForToolCall,
  featureFromOddRel,
  headingFromText,
  isPluginSessionName,
  canAdoptSessionName,
  isWriteToolName,
  labelHeadForDocument,
  planSessionRename,
  planPhaseSessionRename,
  sessionNameForFeature,
};
