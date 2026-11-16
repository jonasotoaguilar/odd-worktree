'use strict';
// T1 (S1): the file a `read`/`edit`/`write` call names — a skill or an ODD artifact —
// as the card identity that call heads with. Pure classification and the two call
// shapes a file card states: the line range only a read asked for, and the Markdown
// document an expanded read or write draws.
//
// The classification is about path components, never substrings: `skills` and `odd`
// are folder names, so `lib/skillset/notes.md` and `docs/oddity.md` are ordinary
// files. Both separators are read, so a Windows path classifies like a POSIX one.

const FILE_CARD_IDENTITY = Object.freeze({ SKILL: 'skill', ODD: 'odd' });

// What one file kind contributes to a card heading: the name the heading leads with,
// the mark that leads it, and the theme role it is painted in. A skill keeps the read
// card's own color — only its name and mark change. An ODD artifact wears the theme's
// own `mdHeading` role, so the theme at hand decides the color and no card carries
// one of its own.
const SKILL_FILE_CARD = Object.freeze({
	identity: FILE_CARD_IDENTITY.SKILL,
	title: 'skill',
	glyph: '▤',
	titleRole: 'toolTitle',
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
const ODD_TASKS_FOLDER = 'tasks';
const SKILL_DOCUMENT = 'skill.md';
const MARKDOWN_NAME = /\.md$/i;

/** The path's components, split on both separators so every platform reads the same path. */
function pathComponents(path) {
	return path.split(/[\\/]+/u).filter((component) => component.length > 0);
}

/**
 * The card a file path wears, or undefined for a file that is neither a skill nor an
 * ODD artifact.
 *
 * Identity is where the file sits together with what it is called. An ODD artifact is
 * any file inside an `odd/tasks/` folder — the `odd` folder alone is not enough, so
 * `odd/work/a.md` is an ordinary file. A skill is a document whose own name is
 * `SKILL.md` held by a `skills` folder — the folder alone is not enough, so the notes
 * beside a skill are ordinary files, and a `SKILL.md` outside a `skills` folder is not
 * a skill either.
 *
 * A path can name both, and then the marker closest to the file decides: a `SKILL.md`
 * below a `skills` folder is a skill even when an `odd/tasks/` folder sits above it,
 * while anything else below `odd/tasks/` is an ODD artifact.
 */
function fileCardIdentity(path) {
	if (typeof path !== 'string') return undefined;
	const components = pathComponents(path);
	if (components.length === 0) return undefined;
	const isSkillDocument = (components.at(-1) ?? '').toLowerCase() === SKILL_DOCUMENT;
	// Only the folders decide; a file whose own name is `odd` is not inside one.
	for (let index = components.length - 2; index >= 0; index -= 1) {
		const component = (components[index] ?? '').toLowerCase();
		const next = (components[index + 1] ?? '').toLowerCase();
		if (component === SKILL_FOLDER && isSkillDocument) return SKILL_FILE_CARD;
		if (component === ODD_FOLDER && next === ODD_TASKS_FOLDER) return ODD_FILE_CARD;
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
 * The Markdown document a call draws instead of its result rows, or undefined when the
 * call draws rows.
 *
 * Markdown is the shape a document is written in, not a property of where it lives: an
 * expanded read of any `.md` file, and an expanded write to one, render as a document
 * whatever folder holds them. Everything else keeps its rows — a collapsed card,
 * because the preview is the first rows of the file; a failed call, because its rows
 * are the error; an edit, because its rows are the diff; and every non-Markdown file.
 * A write draws the content it wrote, which the call carries and the result does not
 * echo.
 */
function markdownDocumentSource(tool, args, resultText, options) {
	const settings = options !== null && typeof options === 'object' ? options : {};
	if (settings.expanded !== true || settings.isError === true) return undefined;
	if (tool !== 'read' && tool !== 'write') return undefined;
	const call = args !== null && typeof args === 'object' ? args : undefined;
	if (!isMarkdownFile(call?.path)) return undefined;
	const source = tool === 'write' ? call?.content : resultText;
	return typeof source === 'string' && source.trim().length > 0 ? source : undefined;
}

module.exports = {
	FILE_CARD_IDENTITY,
	SKILL_FILE_CARD,
	ODD_FILE_CARD,
	fileCardIdentity,
	fileCardName,
	isMarkdownFile,
	fileCardLineRange,
	markdownDocumentSource,
};
