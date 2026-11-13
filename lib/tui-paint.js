'use strict';
// Shared palette for the full-screen readers (issues-view S11, odd-viewer S11,
// customize S11).
//
// ONE place decides which theme role paints each kind of token — a shortcut KEY
// versus its description, a frame title, a count, a static label, a live search
// value — so every footer and header in these views reads as the same palette
// and neither view keeps a second copy of the same try/catch wrappers.
//
// Roles are theme ROLE NAMES the host theme resolves (`accent`, `muted`, `dim`,
// `border`, `error`, …). Nothing here names a colour or an escape sequence: a
// caller injects the theme, and a missing, partial or throwing theme degrades to
// plain text instead of breaking a render. Shortcut keys and titles are
// emphasized through the theme's own `bold`, so the pairings below stay
// distinguishable in a monochrome terminal too, where roles collapse to one
// colour.
//
// S13/S16 («fijate en los titulos, usa un color secundario … para los botones
// usa el principal del tema»): the reference is the Pi **Agents** view the reader
// screenshotted, and its source lives in the installed `gentle-pi` package — no
// colour is inferred here.
//
//   - TITLE = `customMessageLabel`. That view declares its role table at
//     `gentle-pi/lib/agents-view.ts:42` —
//       const ROLE = { FRAME: "border", TITLE: "customMessageLabel",
//                      SELECTED: "accent", NAME: "text", NAME_IDLE: "muted",
//                      META: "dim", KEY: "accent", KEY_TEXT: "dim", EMPTY: "dim" }
//     — and paints its frame title with it at the same file's line 437:
//       theme.fg(ROLE.FRAME, "╭─ ") + theme.fg(ROLE.TITLE, `❀ Agents · …`) + …
//     The Jobs view uses the identical table (`gentle-pi/lib/jobs-view.ts:23`),
//     so `customMessageLabel` is that family's panel-title role: a secondary,
//     tinted colour (pi's dark theme resolves it to a purple, TokyoNight to
//     `sky`) that is visibly NOT the primary accent and NOT a neutral grey.
//   - BUTTON = the primary accent. The same table maps `KEY: "accent"` and
//     `SELECTED: "accent"`, so every shortcut key and the selection stay on the
//     primary colour (pi's documented accent: "logo, selected items, cursor").
//   - ordinary text = `text` (`NAME: "text"` in that table); a selected row is
//     told apart by its own `selectedBg` band rather than by being repainted.
//   - `dim` stays what that table calls `META`/`KEY_TEXT`/`EMPTY`: small
//     metadata, key descriptions and placeholders — which is also our `label`.
//
// Rejected earlier candidates: a `dim` title (a grey heading reads as metadata,
// not as the panel's name, and the reader explicitly called a grey title wrong),
// and `mdHeading`, which is a Markdown document heading role and therefore not a
// UI title role at all.

// The role per token kind. `key` and `title` are painted AND emphasized;
// `description`, `count` and `label` are colour-only, which is exactly what
// keeps a key distinguishable from the words next to it.
const ROLES = Object.freeze({
  key: 'accent',
  title: 'customMessageLabel',
  description: 'muted',
  count: 'muted',
  label: 'dim',
  value: 'text',
  border: 'border',
  error: 'error',
});

function textOf(value) {
  if (typeof value === 'string') return value;
  return value == null ? '' : String(value);
}

/**
 * Paint `text` with one theme role.
 *
 * A theme that is absent, that has no `fg`, that throws, or that answers
 * something that is not a string leaves the text unpainted — a hostile theme
 * never breaks a view.
 */
function paint(theme, role, text) {
  const value = textOf(text);
  try {
    if (theme && typeof theme.fg === 'function') {
      const painted = theme.fg(role, value);
      if (typeof painted === 'string') return painted;
    }
  } catch {
    // Fall through to the plain text.
  }
  return value;
}

/** Bold `text` through the theme, or leave it plain for a hostile theme. */
function emphasize(theme, text) {
  const value = textOf(text);
  try {
    if (theme && typeof theme.bold === 'function') {
      const bold = theme.bold(value);
      if (typeof bold === 'string') return bold;
    }
  } catch {
    // Fall through to the plain text.
  }
  return value;
}

/**
 * The focused-row form: a selected-background band when the theme offers one,
 * otherwise the accent role. This is what tells a SELECTED row apart from the
 * ordinary `text` rows the palette paints (S13): focus never depends on the row
 * already being a different colour. It stays visible on a theme that answers
 * neither because the callers also mark the row with `▸`.
 */
function highlight(theme, text, focused) {
  const value = textOf(text);
  if (!focused) return value;
  try {
    if (theme && typeof theme.bg === 'function') {
      const painted = theme.bg('selectedBg', value);
      if (typeof painted === 'string') return painted;
    }
  } catch {
    // Fall through to the accent form below.
  }
  return paint(theme, ROLES.key, value);
}

/** A shortcut key (a button): the PRIMARY accent + bold, never accent alone. */
function key(theme, text) {
  return emphasize(theme, paint(theme, ROLES.key, text));
}

/**
 * A frame title: the role the Pi Agents view paints its own title with
 * (`customMessageLabel`) + bold, named for what it is. A title is never painted
 * with the primary `key` role (S13), never with `dim` (the grey the reader
 * rejected) and never with a Markdown heading role.
 */
function title(theme, text) {
  return emphasize(theme, paint(theme, ROLES.title, text));
}

/** What a shortcut key does. */
function description(theme, text) {
  return paint(theme, ROLES.description, text);
}

/** A tab count, a document count, a status word. */
function count(theme, text) {
  return paint(theme, ROLES.count, text);
}

/** A static label or prompt the reader does not type into. */
function label(theme, text) {
  return paint(theme, ROLES.label, text);
}

/**
 * A live value the reader typed or derived — the query in the search row, a
 * branch, a path, a page number. It is ordinary text, so it stays out of the
 * accent a button owns and the selected row keeps its own band.
 */
function value(theme, text) {
  return paint(theme, ROLES.value, text);
}

// The legend joins its kept entries with this separator (the same one the
// one-row footer always used).
const LEGEND_SEPARATOR = ' · ';

// S14: one scroll GROUP is every hint that pages the same target — the primary
// pair, the always-available page pair, the half-page pair, the printable
// fallback. The reader reported the alternates as noise («alguna key generidad
// como el page o half estan demas»), so the legend spends ONE token on the
// group and says what it does (`ctrl+j/k scroll`); the list keys that also
// scroll keep working unadvertised. Callers pass their own target word.
const DEFAULT_SCROLL_LABEL = 'scroll';

/**
 * Collapse one scroll group's hints into the SINGLE legend entry that names
 * the target it scrolls (S14).
 *
 * The group's FIRST entry decides both the key spelling and the priority: it is
 * the binding the caller considers primary (the one the terminal can actually
 * deliver), and the entries after it are alternates for the same target, so
 * their tokens leave the legend. Only the HINT collapses — the caller's key
 * handler is untouched, so a dropped token keeps working.
 *
 * @param {Array<{key?: string, text?: string, short?: string, priority?: number}>} entries
 *   the group's entries, primary first.
 * @param {string} [target] the pane the keys scroll, e.g. `doc`.
 * @returns {{key: string, text: string, short: string, priority: number}|null}
 *   the labelled entry, or null for an empty group so a caller can spread it
 *   unconditionally.
 */
function scrollHint(entries, target) {
  const list = (Array.isArray(entries) ? entries : []).filter((entry) => entry && typeof entry === 'object');
  if (list.length === 0) return null;
  const primary = list[0];
  const keys = textOf(primary.key) || textOf(primary.short) || textOf(primary.text);
  if (keys === '') return null;
  // The target survives compaction: an unlabelled key pair is exactly the
  // ambiguity S14 reported, so `short` carries the label too.
  const token = `${keys} ${textOf(target) || DEFAULT_SCROLL_LABEL}`;
  return {
    key: keys,
    text: token,
    short: token,
    priority: Number.isFinite(Number(primary.priority)) ? Number(primary.priority) : 0,
  };
}

// Which entries survive, and which spelling of them: the FULL token while it
// fits, then the compact token, then the same list minus its lowest-priority
// entries until something fits. Display order never changes and no token
// carries a newline, so the legend stays on ONE row.
function legendSelection(entries, width, measure) {
  const list = Array.isArray(entries) ? entries : [];
  const join = (items, field) => items.map((entry) => textOf(entry && entry[field])).join(LEGEND_SEPARATOR);
  const fits = (text) => {
    try {
      return Number(measure(text)) <= width;
    } catch {
      // A hostile measurer never claims a fit.
      return false;
    }
  };
  if (fits(join(list, 'text'))) return { entries: list, field: 'text' };
  if (fits(join(list, 'short'))) return { entries: list, field: 'short' };
  const kept = list.slice();
  while (kept.length > 1) {
    let drop = 0;
    for (let at = 1; at < kept.length; at += 1) {
      if (kept[at].priority <= kept[drop].priority) drop = at;
    }
    kept.splice(drop, 1);
    if (fits(join(kept, 'short'))) break;
  }
  return { entries: kept, field: 'short' };
}

// One legend entry: its `key` prefix carries the key role (+ bold) and the rest
// of the token carries the description role. An entry without a `key`, or one
// whose chosen spelling does not start with it, is a description throughout —
// the legend never guesses where a key ends and the words begin.
function entryCell(theme, entry, field) {
  const spelled = textOf(entry && entry[field]);
  const keys = textOf(entry && entry.key);
  if (keys === '' || !spelled.startsWith(keys)) return description(theme, spelled);
  const rest = spelled.slice(keys.length);
  if (rest === '') return key(theme, keys);
  return `${key(theme, keys)}${description(theme, rest)}`;
}

/**
 * The painted legend row: keys in the key role, descriptions in the muted one,
 * compacted to ONE row as described above. `measure` reports the visible width
 * of a string (ANSI-aware), so painting never changes what fits.
 */
function legendRow(theme, entries, width, measure) {
  const selection = legendSelection(entries, width, measure);
  const separator = paint(theme, ROLES.border, LEGEND_SEPARATOR);
  return selection.entries.map((entry) => entryCell(theme, entry, selection.field)).join(separator);
}

module.exports = {
  ROLES,
  count,
  description,
  emphasize,
  highlight,
  key,
  label,
  legendRow,
  paint,
  scrollHint,
  title,
  value,
};
