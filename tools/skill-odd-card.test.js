'use strict';
// T1 (S1): which file a read/edit/write call names, and what the card that heads as
// it says — the pure classification lib/file-card.js will draw. Only the module's
// public surface is asserted: the identity a path wears, the file's name, whether it
// is Markdown, the line range only a read states, and the document a call draws.
//
// Paths are components, never substrings, so `lib/skillset/x.ts` is an ordinary file;
// both separators read alike, so a Windows path classifies exactly like a POSIX one. The
// convention is the FOLDER: everything below a `skills` folder is that skill and
// everything below an `odd` folder is an ODD artifact, whatever the file is called.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
	FILE_CARD_IDENTITY,
	ODD_FILE_CARD,
	SKILL_FILE_CARD,
	editedFragment,
	fileCardIdentity,
	fileCardLineRange,
	fileCardName,
	fileCardSkillPath,
	isMarkdownFile,
	markdownDocumentSource,
} = require('../lib/skill-odd-card.js');

const identity = (path) => fileCardIdentity(path)?.identity;

// A skill is EVERYTHING a `skills` folder holds: its document, its references, its
// scripts. The skill is the folder, so a reference file belongs to the skill it serves.
test('any file below a skills folder is a skill', () => {
	for (const path of [
		'skills/gentle-ai/SKILL.md',
		'skills/gentle-ai/references/commands.md',
		'skills/gentle-ai/references/deep/x.txt',
		'packages/gentle/skills/tdd/SKILL.md',
		'skills/tdd/references/SKILL.md',
		'skills/tdd/skill.md',
		'skills/tdd/notes.md',
		'Skills/tdd/references/chain.md',
		'C:\\repo\\skills\\tdd\\SKILL.md',
		'C:\\repo\\skills\\tdd\\references\\commands.md',
		'\\\\server\\share\\skills\\tdd\\SKILL.md',
	]) {
		assert.equal(identity(path), FILE_CARD_IDENTITY.SKILL, path);
		assert.equal(fileCardIdentity(path), SKILL_FILE_CARD, path);
	}
});

// The same convention for ODD: the folder decides, not the file's own name nor its depth.
test('any file below an odd folder is an ODD artifact', () => {
	for (const path of [
		'odd/tasks/checkout.md',
		'odd/tasks/checkout/design.md',
		'odd/tasks/checkout/references/readme.txt',
		'odd/work/a.md',
		'odd/design.md',
		'odd/tasks.md',
		'src/odd/tasks/design.md',
		'C:\\repo\\odd\\tasks\\design.md',
		'C:\\repo\\odd\\work\\design.md',
		'\\\\server\\share\\odd\\tasks\\design.md',
	]) {
		assert.equal(identity(path), FILE_CARD_IDENTITY.ODD, path);
		assert.equal(fileCardIdentity(path), ODD_FILE_CARD, path);
	}
});

// A path can name both kinds, and then the marker closest to the file decides.
test('a path both rules name is judged by the marker closest to the file', () => {
	assert.equal(identity('odd/tasks/skills/tdd/SKILL.md'), FILE_CARD_IDENTITY.SKILL);
	assert.equal(identity('odd/tasks/skills/tdd/notes.md'), FILE_CARD_IDENTITY.SKILL);
	assert.equal(identity('skills/pack/odd/tasks/SKILL.md'), FILE_CARD_IDENTITY.ODD);
	assert.equal(identity('odd/tasks/skills/x/SKILL.md'), FILE_CARD_IDENTITY.SKILL);
});

// Every other file wears nothing, because a folder name is never a substring.
test('every other file wears no card identity', () => {
	for (const path of [
		'lib/skillset/x.ts',
		'lib/my-skills/notes.md',
		'lib/odd-work/notes.md',
		'odd-work/notes.md',
		'docs/oddity.md',
		'docs/odd',
		'docs/readme.md',
		'docs/tasks.md.bak',
		'skills.md',
		'SKILL.md',
		'/home/dev/repo/SKILL.md',
		'docs/SKILL.md',
		'lib/x.ts',
	]) {
		assert.equal(fileCardIdentity(path), undefined, path);
	}
});

// Nothing to classify is not an error.
test('a non-string or an empty path is nothing, not an error', () => {
	for (const path of [undefined, null, 42, {}, [], '', '/', 'C:\\']) {
		assert.equal(fileCardIdentity(path), undefined, String(path));
	}
	assert.equal(fileCardIdentity(), undefined);
});

// Each kind ships its own label, mark and theme role; the roles are the theme's to paint.
test('each identity carries its own label, mark and theme role', () => {
	assert.deepEqual(FILE_CARD_IDENTITY, { SKILL: 'skill', ODD: 'odd' });
	assert.deepEqual(SKILL_FILE_CARD, { identity: 'skill', title: 'skill', glyph: '▤', titleRole: 'mdHeading' });
	assert.deepEqual(ODD_FILE_CARD, { identity: 'odd', title: 'odd', glyph: '📑', titleRole: 'mdHeading' });
	for (const value of [FILE_CARD_IDENTITY, SKILL_FILE_CARD, ODD_FILE_CARD]) assert.ok(Object.isFrozen(value));
	// BOTH headings wear the theme's own heading role, never a status color.
	for (const card of [SKILL_FILE_CARD, ODD_FILE_CARD]) {
		for (const role of ['warning', 'error', 'success', 'toolTitle']) assert.notEqual(card.titleRole, role, role);
	}
});

// The file's own name is the last component on either separator, and nothing else.
test('the collapsed heading can name the file itself', () => {
	assert.equal(fileCardName('odd/work/design.md'), 'design.md');
	assert.equal(fileCardName('C:\\repo\\odd\\work\\design.md'), 'design.md');
	assert.equal(fileCardName('odd/my design doc.md'), 'my design doc.md');
	assert.equal(fileCardName('odd/work/'), 'work', 'a trailing separator names no empty file');
	assert.equal(fileCardName('design.md'), 'design.md');
	// A drive with no file after it still names its last component, and never a blank.
	assert.equal(fileCardName('C:\\'), 'C:');
	// Nothing to name is nothing, never an invented file.
	for (const value of ['', '/', undefined, null, 7]) assert.equal(fileCardName(value), '', String(value));
});

// A skill's collapsed heading names the path from the skill's own folder down, however
// deep the file sits: the folders above `skills` are what a reader already knows.
test('a skill card can name its path from its skill folder down', () => {
	assert.equal(fileCardSkillPath('/x/skills/gentle-ai/SKILL.md'), 'gentle-ai/SKILL.md');
	assert.equal(fileCardSkillPath('/x/skills/gentle-ai/references/chain.md'), 'gentle-ai/references/chain.md');
	assert.equal(fileCardSkillPath('/x/skills/gentle-ai/references/deep/x.md'), 'gentle-ai/references/deep/x.md');
	// Both separators are read, so a Windows path names the same components.
	assert.equal(fileCardSkillPath('C:\\repo\\skills\\tdd\\SKILL.md'), 'tdd/SKILL.md');
	assert.equal(fileCardSkillPath('\\\\server\\share\\skills\\tdd\\references\\chain.md'), 'tdd/references/chain.md');
	// The folder is a component, never a substring, and any case reads alike.
	assert.equal(fileCardSkillPath('Skills/one/SKILL.md'), 'one/SKILL.md');
	// A path with no `skills` folder names its file, exactly as the collapsed heading did.
	for (const path of ['docs/readme.md', 'C:\\repo\\docs\\readme.md', 'lib/skillset/x.ts', 'design.md', 'skills']) {
		assert.equal(fileCardSkillPath(path), fileCardName(path), path);
	}
	// Nothing to name is nothing, never an invented path.
	for (const value of ['', '/', undefined, null, 7]) assert.equal(fileCardSkillPath(value), '', String(value));
});

// Markdown is the shape a document is written in: the extension, and the extension alone.
test('only a .md file is a Markdown file', () => {
	for (const path of ['skills/a/SKILL.md', 'odd/work/a.md', 'odd/work/a.MD', 'C:\\repo\\odd\\a.Md']) {
		assert.equal(isMarkdownFile(path), true, path);
	}
	for (const path of ['skills/a/notes.markdown', 'odd/work/a.md.bak', 'lib/x.ts', 'a.md/x.ts', '', '/', undefined, 7]) {
		assert.equal(isMarkdownFile(path), false, String(path));
	}
});

// Only a read states a line range, and a range it cannot read states nothing.
test('a read names the line range it asked for, and no other tool states one', () => {
	assert.equal(fileCardLineRange('read', { path: 'a.md', offset: 142, limit: 4 }), ':142-145');
	assert.equal(fileCardLineRange('read', { path: 'a.md', limit: 4 }), ':1-4');
	assert.equal(fileCardLineRange('read', { path: 'a.md', offset: 5 }), ':5');
	assert.equal(fileCardLineRange('read', { path: 'a.md' }), undefined);
	assert.equal(fileCardLineRange('read', { path: 'a.md', offset: 2, limit: 1 }), ':2-2');
	// Half a range is never guessed at: a malformed offset or limit states nothing.
	assert.equal(fileCardLineRange('read', { offset: '2', limit: 3 }), undefined);
	assert.equal(fileCardLineRange('read', { offset: 2, limit: 3.5 }), undefined);
	assert.equal(fileCardLineRange('read', { offset: 0, limit: 2 }), undefined);
	assert.equal(fileCardLineRange('read', { offset: 2, limit: 0 }), undefined);
	assert.equal(fileCardLineRange('read', { offset: 2, limit: -1 }), undefined);
	// A write and an edit know how many lines they write, never where those lines land.
	assert.equal(fileCardLineRange('write', { path: 'a.md', content: 'one\ntwo' }), undefined);
	assert.equal(fileCardLineRange('edit', { path: 'a.md', oldText: 'a', newText: 'b' }), undefined);
	assert.equal(fileCardLineRange('grep', { path: 'a.md', limit: 2 }), undefined);
	assert.equal(fileCardLineRange('read', undefined), undefined);
});

// The fragment source itself, as the one answer both the document and its plain fallback
// are drawn from.
test('the fragment an edit leaves is every `newText` it states, and nothing else', () => {
	assert.equal(editedFragment({ edits: [{ newText: 'a' }, { newText: 'b' }] }), 'a\nb');
	assert.equal(editedFragment({ newText: 'a' }), 'a');
	assert.equal(editedFragment({ edits: [{ oldText: 'gone', newText: '' }] }), undefined);
	assert.equal(editedFragment(undefined), undefined);
});

// A Markdown document is drawn as a document only when expanded and successful; a read
// draws what it returned, a write what its call carried, an edit the fragment it leaves
// behind, and nothing to draw keeps the rows.
test('an expanded, successful read, write or edit of a Markdown file draws a document', () => {
	const markdown = '## Handoff\n\nBody.';
	const draw = (tool, args, result, options = {}) =>
		markdownDocumentSource(tool, args, result, { expanded: true, ...options });
	assert.equal(draw('read', { path: 'docs/a.md' }, markdown), markdown);
	assert.equal(draw('write', { path: 'docs/a.md', content: markdown }, 'Successfully wrote 20 bytes'), markdown);
	// An edit's document is the text it leaves behind, never what it removed or its diff.
	assert.equal(draw('edit', { path: 'docs/a.md', oldText: 'a', newText: markdown }, 'Applied'), markdown);
	// Collapsed, failed, non-Markdown and every other tool keep their rows.
	assert.equal(draw('read', { path: 'docs/a.md' }, markdown, { expanded: false }), undefined);
	assert.equal(draw('read', { path: 'docs/a.md' }, markdown, { isError: true }), undefined);
	assert.equal(draw('write', { path: 'docs/a.md', content: markdown }, 'ok', { isError: true }), undefined);
	assert.equal(draw('edit', { path: 'docs/a.md', oldText: 'a', newText: markdown }, 'Applied', { isError: true }), undefined);
	assert.equal(draw('grep', { path: 'docs/a.md' }, markdown), undefined);
	assert.equal(draw('read', { path: 'docs/a.txt' }, markdown), undefined);
	assert.equal(draw('write', { path: 'lib/x.ts', content: markdown }, 'ok'), undefined);
	// Nothing to draw is not a document: an empty body keeps the result it has.
	assert.equal(draw('read', { path: 'docs/a.md' }, ''), undefined);
	assert.equal(draw('read', { path: 'docs/a.md' }, '   \n\n'), undefined);
	assert.equal(draw('write', { path: 'docs/a.md', content: '' }, 'Successfully wrote 0 bytes'), undefined);
	assert.equal(draw('write', { path: 'docs/a.md' }, 'Successfully wrote 0 bytes'), undefined);
	assert.equal(draw('read', undefined, markdown), undefined);
});

// An edit's document is the fragment its call leaves behind: every `newText` it states, in
// the call's own order, and nothing it removed.
test('an edit draws the fragment it leaves behind, in either call shape', () => {
	const draw = (args, options = {}) => markdownDocumentSource('edit', args, 'Applied', { expanded: true, ...options });
	// The shape the harness hands over: one `edits` array, joined in its own order.
	assert.equal(
		draw({ path: 'odd/a.md', edits: [{ oldText: 'one', newText: '# One' }, { oldText: 'two', newText: '## Two' }] }),
		'# One\n## Two',
	);
	assert.equal(draw({ path: 'odd/a.md', edits: [{ newText: 'b' }, { newText: 'a' }] }), 'b\na', 'the array order, never a sort');
	// The legacy flat shape: the one pair at the top level.
	assert.equal(draw({ path: 'odd/a.md', oldText: 'one', newText: '# One' }), '# One');
	assert.equal(draw({ path: 'odd/a.md', edits: 'not an array', newText: '# One' }), '# One', 'an `edits` that is not an array is the flat shape');
	// An entry that states no string is skipped, never stringified: the fragment is text.
	assert.equal(
		draw({ path: 'odd/a.md', edits: [{ newText: 7 }, null, 'text', { newText: '# One' }, {}, { newText: ['x'] }] }),
		'# One',
	);
	// A pure deletion leaves no fragment, so there is no document and the rows stay.
	assert.equal(draw({ path: 'odd/a.md', edits: [{ oldText: '# Gone', newText: '' }] }), undefined);
	assert.equal(draw({ path: 'odd/a.md', edits: [{ oldText: '# Gone', newText: '  \n ' }] }), undefined);
	assert.equal(draw({ path: 'odd/a.md', oldText: '# Gone' }), undefined, 'no newText states nothing');
	// A collapsed or failed edit, and a path that is no Markdown, keep their rows too.
	assert.equal(draw({ path: 'odd/a.md', edits: [{ newText: '# One' }] }, { expanded: false }), undefined);
	assert.equal(draw({ path: 'odd/a.json', edits: [{ newText: '# One' }] }), undefined);
	// Nothing to read is no document, and no throw either.
	assert.equal(draw(undefined), undefined);
});
