'use strict';
// Automatic session naming from the ODD document being written.
//
// Pure derivation, no I/O: the caller passes what a tool call touched, whether that
// call was a write, and the names the session already wrote, and gets back either the
// label to write or `null` for "leave the session alone".
//
// THE NAME IS THE ODD'S OWN NAME (D2). Writing `odd/tasks/prompt-card-fix.md` names
// the session `Prompt card fix`: the separators a feature name uses (`-`, `_`, and
// the `/` of a nested feature) become spaces, the first letter is capitalized, the
// rest of the name is left exactly as the document named it, and the result is cut
// at a word boundary when it is too long to read at a glance. Prose INSIDE the
// document never names the session: a document's own heading is its author's
// sentence, not the ODD's identity, and reading it made the name depend on a file
// read that a not-yet-created document does not have.
//
// EVERY WRITE RE-NAMES (D3): the label is derived on each `write`/`edit` that lands on
// an `odd/tasks/*.md` document, so a session that moves on to another ODD is renamed
// to that ODD. Reading is context gathering and never renames (D6).
//
// NEVER CLOBBER A HUMAN (D4). The channel is the session NAME (`setSessionName`); a
// name the plugin cannot account for was typed by a person and is untouchable. The
// plugin may write only an empty name, or one it can PROVE it produced:
//   (a) the label this session already applied (in-memory, per session);
//   (b) the label of the document being written right now;
//   (c) the label of any ODD this session already wrote — the durable record of
//       touches (`odd-worktree.odd-touch`) hands those names in, which is what makes
//       the proof survive a resume (D5) without storing a second thing; or
//   (d) a name an earlier version of this plugin wrote: the plain dashed slug
//       (`prompt-card-fix`) or the same slug with a branch suffix
//       (`prompt-card-fix @ feat/prompt-card-fix`).
// Anything else is a human's name. The admitted consequence is that a human who names
// a session exactly like an ODD they themselves wrote stops owning that name.
//
// There is no branch in the name (the user's decision): two forks of the same ODD
// share a label, and the session file, not the name, is what tells them apart.
//
// Input rels are the canonical `odd/<rel>` names the worktree capture already
// produces, never raw filesystem paths: mapping a path to a document is path logic
// that lives in one place already.

// Document shape that names a session: `odd/tasks/<feature>.md`, where the feature
// may be nested (`odd/tasks/perf/plan.md`).
const ODD_TASKS_PREFIX = 'odd/tasks/';

// A label beyond this loses the rest of the words, cut at the last word boundary so
// the name stays readable at a glance.
const LABEL_MAX_CHARS = 48;

// The separator the branch suffix of an EARLIER version used. It is never written any
// more; it is recognized so a resumed session renamed by that version is still
// adoptable (D4d).
const LEGACY_BRANCH_SEPARATOR = ' @ ';

// gentle-pi's ODD phase tool. Its result says WHICH phase the session moved to, never
// WHICH feature it is about, so the phase trigger cannot derive anything: it
// re-applies what the session last derived from a write. It is observable only as a
// `tool_result`, not a host event.
const ODD_PHASE_TOOL_NAME = 'gentle_odd_phase';

// A feature is one or more `/`-separated segments using the characters a document
// filename can carry, without whitespace. A branch is any whitespace-free token —
// permissive on purpose, because a branch of an earlier version's suffix may carry an
// unusual-but-legal character and must still be recognized as OUR label.
const FEATURE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const BRANCH_TOKEN = /^\S+$/;

// The separators a feature name uses as word boundaries. `/` is the nested-feature
// separator and reads as a word break like the others.
const WORD_SEPARATORS = /[/_-]+/g;

// The tools whose call WRITES a document. Reading is context gathering: it would make
// the name jump to whatever was opened last (D6), so `read` is deliberately absent.
const WRITE_TOOL_NAMES = new Set(['write', 'edit']);

// The last label each session applied, keyed by session id. In-module so the phase
// trigger stays testable without the extension, and bounded so a long-lived process
// that sees many sessions cannot grow without limit; only the most recent sessions
// can still be alive and resumed.
const SESSION_MEMORY_LIMIT = 100;
const lastLabelBySession = new Map();

function sessionKey(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

function rememberLabel(sessionId, label) {
  const key = sessionKey(sessionId);
  if (key === null) return;
  // Re-inserting moves the session to the young end of the insertion order, so
  // eviction always drops the least recently written session.
  lastLabelBySession.delete(key);
  lastLabelBySession.set(key, label);
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

// `<feature>` for an `odd/tasks/<feature>.md` rel, else null. Rejects empty segments,
// nested `.`/`..`, and any name carrying whitespace or characters a feature document
// cannot have.
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

// The first `odd/tasks/<feature>.md` document of the call, or null. The first one wins
// because a multi-document write has no natural order.
function firstTaskDocument(rels) {
  if (!Array.isArray(rels)) return null;
  for (const rel of rels) {
    const feature = featureFromOddRel(rel);
    if (feature !== null) return { rel, feature };
  }
  return null;
}

// Cut to `max` characters at the last word boundary inside the cut, so a truncated
// label ends with a whole word. A single word longer than `max` has no boundary and is
// cut hard; anything short stays untouched.
function truncateLabel(text, max) {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  return lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
}

// The session label for an ODD feature name (D2): separators become spaces, the run
// of spaces collapses, the first letter is capitalized and the rest is left exactly
// as the document named it. `perf/plan` -> `Perf plan`, `prompt-card-fix` ->
// `Prompt card fix`. An empty name yields no label; nothing is invented.
function labelFromFeature(feature) {
  if (typeof feature !== 'string' || feature.length === 0) return null;
  const words = feature.replace(WORD_SEPARATORS, ' ').replace(/\s+/g, ' ').trim();
  if (words.length === 0) return null;
  const sentence = words.charAt(0).toUpperCase() + words.slice(1);
  return truncateLabel(sentence, LABEL_MAX_CHARS);
}

// The labels of the ODDs this session already wrote, as handed in from the durable
// touch record (`oddSession.touched()` names). Malformed and unusable entries are
// skipped: a durable record that cannot be read leaves the ownership test with less
// evidence, never with a wrong answer.
function sessionLabelsFrom(touchedNames) {
  if (!Array.isArray(touchedNames)) return [];
  const out = [];
  for (const name of touchedNames) {
    const label = labelFromFeature(name);
    if (label !== null && !out.includes(label)) out.push(label);
  }
  return out;
}

function isFeatureName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const segments = name.split('/');
  return segments.every((segment) => segment !== '.' && segment !== '..' && FEATURE_SEGMENT.test(segment));
}

// The ownership test (D4). A name counts as the plugin's own when ANY of these holds:
//   (a) it is the label this session already applied — what lets the phase trigger
//       reuse it;
//   (b) it is the label of the document being written;
//   (c) it is the label of an ODD this session already wrote (the durable record);
//   (d) an earlier version wrote it: the plain feature slug, or `<slug> @ <branch>`.
// Anything else was typed by a human. Called with no context it answers exactly what
// earlier versions of this test answered for those legacy shapes.
function isPluginSessionName(name, context) {
  if (typeof name !== 'string' || name.length === 0) return false;
  const { feature, appliedLabel, sessionLabels } = context || {};
  if (typeof appliedLabel === 'string' && appliedLabel.length > 0 && name === appliedLabel) return true;
  if (typeof feature === 'string' && feature.length > 0 && name === labelFromFeature(feature)) return true;
  if (Array.isArray(sessionLabels) && sessionLabels.includes(name)) return true;
  const at = name.indexOf(LEGACY_BRANCH_SEPARATOR);
  if (at === -1) return isFeatureName(name);
  const head = name.slice(0, at);
  const tail = name.slice(at + LEGACY_BRANCH_SEPARATOR.length);
  if (head.length === 0 || !BRANCH_TOKEN.test(tail)) return false;
  return isFeatureName(head);
}

// May the plugin write over `name`? An unnamed session (empty, or no name entry at
// all — `getSessionName()` returns undefined) is adoptable; every other name must be
// the plugin's own.
function canAdoptSessionName(name, context) {
  if (name === undefined || name === null) return true;
  if (typeof name !== 'string') return false;
  return name.length === 0 || isPluginSessionName(name, context);
}

// The label for a tool call that touched `rels`, or null when the call is not a WRITE
// to an `odd/tasks/<feature>.md` document. No ownership is decided here;
// `planSessionRename` owns that.
function autoNameForToolCall({ rels, isWrite } = {}) {
  if (isWrite !== true) return null;
  const match = firstTaskDocument(rels);
  if (match === null) return null;
  return labelFromFeature(match.feature);
}

// The single decision the write wiring needs. Returns the name to write, or null for
// "touch nothing", which covers three cases: the call did not write an ODD task
// document, the current name was chosen by a human, and the derived label is already
// the current name — the last one is what makes running this on every pipeline event
// idempotent instead of a stream of host writes. The derived label is remembered per
// session whether or not it was written, so a later phase transition can re-apply it.
function planSessionRename({ rels, isWrite, currentName, sessionId, touchedNames } = {}) {
  if (isWrite !== true) return null;
  const match = firstTaskDocument(rels);
  if (match === null) return null;
  const label = labelFromFeature(match.feature);
  if (label === null) return null;
  const previous = rememberedLabel(sessionId);
  const adoptable = canAdoptSessionName(currentName, {
    feature: match.feature,
    appliedLabel: previous === null ? undefined : previous,
    sessionLabels: sessionLabelsFrom(touchedNames),
  });
  rememberLabel(sessionId, label);
  if (!adoptable || label === currentName) return null;
  return label;
}

// The phase trigger: an ODD phase transition with no feature of its own re-applies the
// label this session last derived from a write. After a resume there is no in-memory
// memory, so the newest ODD of the durable touch record stands in — it is the same
// fact, read from where it survives. Returns null for "touch nothing" when the session
// never wrote an ODD document, when the current name is a human's, or when the label
// is already applied.
function planPhaseSessionRename({ sessionId, currentName, touchedNames } = {}) {
  const sessionLabels = sessionLabelsFrom(touchedNames);
  const previous = rememberedLabel(sessionId);
  const label = previous !== null ? previous : sessionLabels.length > 0 ? sessionLabels[0] : null;
  if (label === null) return null;
  if (!canAdoptSessionName(currentName, { appliedLabel: previous === null ? undefined : previous, sessionLabels })) {
    return null;
  }
  if (label === currentName) return null;
  rememberLabel(sessionId, label);
  return label;
}

module.exports = {
  ODD_TASKS_PREFIX,
  LABEL_MAX_CHARS,
  LEGACY_BRANCH_SEPARATOR,
  ODD_PHASE_TOOL_NAME,
  autoNameForToolCall,
  featureFromOddRel,
  isPluginSessionName,
  canAdoptSessionName,
  isWriteToolName,
  labelFromFeature,
  planSessionRename,
  planPhaseSessionRename,
};
