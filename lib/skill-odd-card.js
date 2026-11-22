'use strict';
// T1 (S1): the file a `read`/`edit`/`write` call names — a skill or an ODD artifact —
// as the card identity that call heads with. Pure classification and the two call
// shapes a file card states: the line range only a read asked for, and the Markdown
// document a read, a write or an edit draws.
//
// The classification is about path components, never substrings: `skills` and `odd`
// are folder names, so `lib/skillset/notes.md` and `docs/oddity.md` are ordinary
// files. Both separators are read, so a Windows path classifies like a POSIX one.
//
// The CONVENTION is the folder. Everything below a `skills` folder belongs to that
// skill — its `SKILL.md`, its references, its scripts — so every one of those files
// is a skill; everything below an `odd` folder is that ODD's, whatever the file is
// called and however deep it sits. The file's own name decides nothing.

const FILE_CARD_IDENTITY = Object.freeze({ SKILL: 'skill', ODD: 'odd' });

// What one file kind contributes to a card heading: the name the heading leads with,
// the mark that leads it, and the theme role it is painted in. Both identities wear the
// theme's own `mdHeading` role, so the theme at hand decides the color and no card
// carries one of its own.
const SKILL_FILE_CARD = Object.freeze({
	identity: FILE_CARD_IDENTITY.SKILL,
	title: 'skill',
	glyph: '▤',
	titleRole: 'mdHeading',
});

const ODD_FILE_CARD = Object.freeze({
	identity: FILE_CARD_IDENTITY.ODD,
	title: 'odd',
	// The artifact mark: a document, wide enough that the row budgets count it as the
	// two columns it really occupies.
	glyph: '📑',
	titleRole: 'mdHeading',
});

const SKILL_FOLDER = 'skills';
const ODD_FOLDER = 'odd';
const MARKDOWN_NAME = /\.md$/i;

// The three tools a file card claims, and the one source of that claim: this module
// states which files wear an identity, and a card may only head a call whose path has
// one. `lib/file-card.js` registers exactly these, and `lib/bash-design.js` asks the
// same list so the two designs never disagree about who owns a row.
const FILE_CARD_TOOLS = Object.freeze(['read', 'edit', 'write']);

/** The path's components, split on both separators so every platform reads the same path. */
function pathComponents(path) {
	return path.split(/[\\/]+/u).filter((component) => component.length > 0);
}

/**
 * The card a file path wears, or undefined for a file that is neither a skill nor an
 * ODD artifact.
 *
 * Identity is the FOLDER the file sits in, and nothing else: everything below a
 * `skills` folder is that skill — its `SKILL.md`, a reference, a script — and
 * everything below an `odd` folder is that ODD, so `odd/work/a.md` is an ODD artifact
 * like `odd/tasks/a.md`. The file's own name never decides, which is why
 * `docs/SKILL.md` is an ordinary file while `skills/x/references/commands.md` is a
 * skill's.
 *
 * A path can name both, and then the marker closest to the file decides: a reference
 * below `skills/` is a skill even when an `odd/tasks/` folder sits above it, while a
 * file whose closest marker is `odd` is an ODD artifact.
 */
function fileCardIdentity(path) {
	if (typeof path !== 'string') return undefined;
	const components = pathComponents(path);
	if (components.length === 0) return undefined;
	// Only the folders decide, and the last one above the file wins; a file whose own
	// name is `odd` or `skills` is not inside one.
	for (let index = components.length - 2; index >= 0; index -= 1) {
		const component = (components[index] ?? '').toLowerCase();
		if (component === SKILL_FOLDER) return SKILL_FILE_CARD;
		if (component === ODD_FOLDER) return ODD_FILE_CARD;
	}
	return undefined;
}

/**
 * The file's own name — the last component of the path — for the collapsed heading of
 * a card that names the file rather than the whole path it sits in.
 *
 * It splits on both separators and on nothing else, so a name with spaces stays whole
 * (`odd/my design doc.md` is `my design doc.md`), a trailing separator does not name an
 * empty file, and a Windows path is read exactly like a POSIX one. A path that names no
 * component is the empty string, which callers treat as "nothing to show" rather than
 * inventing a name.
 */
function fileCardName(path) {
	if (typeof path !== 'string') return '';
	const components = pathComponents(path);
	return components.at(-1) ?? '';
}

/**
 * The path a collapsed SKILL heading names: the components from the skill's own folder —
 * the one right after the `skills` folder that holds it — through the file's name,
 * however deep that is.
 *
 * A skill's folders are its own namespace, so `…/skills/gentle-ai/SKILL.md` is
 * `gentle-ai/SKILL.md` and `…/skills/gentle-ai/references/deep/x.md` is
 * `gentle-ai/references/deep/x.md`: the folders above `skills` are what a reader of the
 * workspace already knows. Components are joined on `/` so a POSIX and a Windows path
 * read alike. The marker is the LAST `skills` folder, which is the one the identity
 * itself comes from, and a path with no such folder (or nothing after it) falls back to
 * the file's own name — exactly what the collapsed heading named before.
 */
function fileCardSkillPath(path) {
	if (typeof path !== 'string') return '';
	const components = pathComponents(path);
	for (let index = components.length - 1; index >= 0; index -= 1) {
		if ((components[index] ?? '').toLowerCase() !== SKILL_FOLDER) continue;
		const named = components.slice(index + 1);
		return named.length > 0 ? named.join('/') : fileCardName(path);
	}
	return fileCardName(path);
}

/** Whether the path names a Markdown document, which is the only shape a card renders as Markdown. */
function isMarkdownFile(path) {
	if (typeof path !== 'string') return false;
	const name = pathComponents(path).at(-1) ?? '';
	return MARKDOWN_NAME.test(name);
}

/**
 * The file line range a card names after the path, as `:start-end`. Only a read states
 * one, because only a read asks for one: a write or an edit knows how many lines it
 * writes, never where in the file those lines land, so it names no range at all — the
 * real range of an edit is the diff its result carries. Nothing is invented for a call
 * that states no range, and a malformed one states nothing either.
 */
function fileCardLineRange(tool, args) {
	if (tool !== 'read' || args === undefined || args === null) return undefined;
	if (args.offset === undefined && args.limit === undefined) return undefined;
	// A range the call states in a shape the card cannot read is not guessed at: half a
	// range would name lines the call never asked for.
	if (args.offset !== undefined && !Number.isInteger(args.offset)) return undefined;
	if (args.limit !== undefined && !Number.isInteger(args.limit)) return undefined;
	const start = typeof args.offset === 'number' ? args.offset : 1;
	const limit = typeof args.limit === 'number' ? args.limit : undefined;
	if (start < 1) return undefined;
	if (limit !== undefined && limit < 1) return undefined;
	return limit === undefined ? `:${start}` : `:${start}-${start + limit - 1}`;
}

/**
 * The Markdown fragment an `edit` call leaves behind, or undefined when it leaves no text.
 *
 * An edit states its answer as the text it produced, never as the change it made: the
 * harness hands one `edits` array over (one entry per replacement, a legacy top-level
 * pair folded into it), so those entries are read in their OWN order and joined with one
 * newline — two replacements read as the two paragraphs they leave. A call that states
 * no array is the legacy flat pair, whose one `newText` is the fragment. `oldText` is
 * never read, because it names exactly what this document must not show.
 *
 * An entry that states no string is skipped rather than stringified, and a fragment that
 * holds no non-whitespace text is no fragment at all: a pure deletion leaves nothing to
 * draw, and the caller keeps the rows it already has instead of an invented placeholder.
 */
function editedFragment(args) {
	const call = args !== null && typeof args === 'object' ? args : undefined;
	const entries = Array.isArray(call?.edits) ? call.edits : undefined;
	const stated = entries === undefined ? [call?.newText] : entries.map((entry) => entry?.newText);
	const fragment = stated.filter((text) => typeof text === 'string').join('\n');
	return fragment.trim().length > 0 ? fragment : undefined;
}

/**
 * The Markdown document a call draws instead of its result rows, or undefined when the
 * call draws rows.
 *
 * Markdown is the shape a document is written in, not a property of where it lives: an
 * expanded read of any `.md` file, an expanded write to one, and an expanded edit of one,
 * render as a document whatever folder holds them. Everything else keeps its rows — a
 * collapsed card, because the preview is the first rows of the file; a failed call,
 * because its rows are the error; a pure deletion, whose `editedFragment` is undefined
 * and whose rows are therefore the diff; and every non-Markdown file. A write draws the
 * content it wrote and an edit the fragment it left, both carried by the call, which the
 * result neither echoes nor states.
 */
function markdownDocumentSource(tool, args, resultText, options) {
	const settings = options !== null && typeof options === 'object' ? options : {};
	if (settings.expanded !== true || settings.isError === true) return undefined;
	if (tool !== 'read' && tool !== 'write' && tool !== 'edit') return undefined;
	const call = args !== null && typeof args === 'object' ? args : undefined;
	if (!isMarkdownFile(call?.path)) return undefined;
	if (tool === 'edit') return editedFragment(call);
	const source = tool === 'write' ? call?.content : resultText;
	return typeof source === 'string' && source.trim().length > 0 ? source : undefined;
}

module.exports = {
	FILE_CARD_IDENTITY,
	FILE_CARD_TOOLS,
	SKILL_FILE_CARD,
	ODD_FILE_CARD,
	fileCardIdentity,
	fileCardName,
	fileCardSkillPath,
	isMarkdownFile,
	fileCardLineRange,
	editedFragment,
	markdownDocumentSource,
};
