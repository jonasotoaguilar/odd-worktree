'use strict';
// T3 (S3/S5): the file card's document body, drawn by Pi's OWN Markdown renderer.
//
// A Markdown document is a document, not a set of rows: this module hands the source
// to `Markdown` from `@earendil-works/pi-tui` — the same component the transcript uses —
// with a theme table mapping every Markdown element onto a THEME ROLE, so a heading, a
// bullet, an inline code span, a fence, a quote and a rule all wear the theme's own
// colours instead of one body colour painted over the whole block. The table is the
// reference PR's (`lib/skill-odd-card.ts:fileCardMarkdownTheme`, gentle-shell #3061),
// and the roles are the host's own (`theme-tokens.ts`: `mdHeading`, `mdLink`,
// `mdLinkUrl`, `mdCode`, `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`,
// `mdQuoteBorder`, `mdHr`, `mdListBullet`).
//
// The rows it returns are ALREADY PAINTED. That is the point of using Pi's renderer —
// and it is why the substrate places them with an ANSI-aware width instead of a plain
// codepoint count (`cardPaintedRows`, `lib/shell-card.js`), never re-painting them with
// a body role of ours (invariant 17: nothing painted is measured, and nothing measured
// is painted twice).
//
// A host without the TUI package, a renderer that throws, and a document that renders
// no row all answer `[]`, so the caller keeps the wrapped plain source it drew before.
// This package ships no node_modules: the package is resolved INSIDE the call, never at
// load, exactly as every other pi-tui use in this repo does it.

/** The role each Markdown element is painted in; the source of truth for the table below. */
const MARKDOWN_ROLES = Object.freeze({
  heading: 'mdHeading',
  link: 'mdLink',
  linkUrl: 'mdLinkUrl',
  code: 'mdCode',
  codeBlock: 'mdCodeBlock',
  codeBlockBorder: 'mdCodeBlockBorder',
  quote: 'mdQuote',
  quoteBorder: 'mdQuoteBorder',
  hr: 'mdHr',
  listBullet: 'mdListBullet',
});

// The text attributes the host theme carries beside `fg`. A theme without one answers
// with the text itself, so a document never loses a word to a missing attribute.
const MARKDOWN_ATTRIBUTES = Object.freeze(['bold', 'italic', 'underline', 'strikethrough']);

const asObject = (value) => (value !== null && typeof value === 'object' ? value : {});

/** One role as a paint function: a theme that cannot paint it leaves the text as it was. */
function rolePainter(theme, role) {
  return (text) => {
    const value = String(text ?? '');
    try {
      if (typeof theme.fg === 'function') {
        const painted = theme.fg(role, value);
        if (typeof painted === 'string') return painted;
      }
    } catch {
      // A hostile theme never costs the document a word.
    }
    return value;
  };
}

/** One text attribute as a paint function, or the identity when the theme has none. */
function attributePainter(theme, name) {
  return (text) => {
    const value = String(text ?? '');
    try {
      const apply = theme[name];
      if (typeof apply === 'function') {
        const painted = apply.call(theme, value);
        if (typeof painted === 'string') return painted;
      }
    } catch {
      // Same as above: an attribute that fails keeps the plain text.
    }
    return value;
  };
}

/**
 * Pi's `MarkdownTheme` built from a card's theme: every element in its theme role and
 * every attribute from the theme's own handlers.
 */
function fileCardMarkdownTheme(theme) {
  const paint = asObject(theme);
  const table = {};
  for (const [element, role] of Object.entries(MARKDOWN_ROLES)) table[element] = rolePainter(paint, role);
  for (const attribute of MARKDOWN_ATTRIBUTES) table[attribute] = attributePainter(paint, attribute);
  return table;
}

// The renderer the host provides, resolved once: `undefined` means "not looked yet",
// `null` means "this host has none", which is a stable answer for the whole process.
let resolved = false;
let markdownClass;

/** Pi's `Markdown` class, or undefined when this host has no TUI package. Never throws. */
function loadMarkdownClass() {
  if (resolved) return markdownClass ?? undefined;
  resolved = true;
  try {
    const tui = require('@earendil-works/pi-tui');
    markdownClass = tui !== null && typeof tui === 'object' && typeof tui.Markdown === 'function' ? tui.Markdown : null;
  } catch {
    markdownClass = null;
  }
  return markdownClass ?? undefined;
}

/**
 * The document's rows, already painted by Pi's renderer, or `[]` when it cannot draw
 * one. `width` is the width the rows must fit: the renderer wraps to it, and the
 * substrate measures the result with the same ANSI-aware helpers.
 *
 * `MarkdownClass` is the renderer to use: omitted, this host's own package is resolved;
 * `null` states a host that has none, which answers no rows without asking for one.
 */
function markdownRows(source, theme, width, MarkdownClass) {
  const target = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
  if (typeof source !== 'string' || source.trim() === '' || target === 0) return [];
  const Renderer = MarkdownClass === undefined ? loadMarkdownClass() : MarkdownClass;
  if (typeof Renderer !== 'function') return [];
  try {
    const drawn = new Renderer(source, 0, 0, fileCardMarkdownTheme(theme)).render(target);
    if (!Array.isArray(drawn)) return [];
    const rows = drawn.filter((row) => typeof row === 'string');
    // A renderer that draws only blanks states nothing: the caller's plain source is
    // the better answer, so this is "no rows" rather than a body of empty lines.
    return rows.some((row) => row.trim() !== '') ? rows : [];
  } catch {
    return [];
  }
}

module.exports = {
  MARKDOWN_ATTRIBUTES,
  MARKDOWN_ROLES,
  fileCardMarkdownTheme,
  loadMarkdownClass,
  markdownRows,
};
