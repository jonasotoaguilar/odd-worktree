'use strict';
// S5 / T5a: the card drawing substrate, outline style only. Every case reads the
// public surface of lib/shell-card.js and pins what the source branch
// (cards-bash-v2, lib/shell-card.ts and tests/shell-card.test.ts) draws with the
// rounded frame. Width measurement, truncation and wrapping are the injected
// `metrics` seam, so this suite supplies deterministic fakes and never needs
// the host TUI package (this package has no node_modules).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
	CARD_GLYPH,
	CARD_STYLE,
	CARD_TONE,
	cardAwaitingResult,
	cardBodyRows,
	cardBottom,
	cardElapsed,
	cardInnerWidth,
	cardLine,
	cardRunningLine,
	cardTop,
	cardTopLine,
	cardTopRows,
	headingFits,
	markCardResult,
} = require('../lib/shell-card.js');

// ---- the injected text seam (fakes: plain ASCII, each character one column) ----

const ANSI = /\x1b\[[0-9;]*m/g;
const stripAnsi = (value) => value.replace(ANSI, '');
const chars = (value) => [...stripAnsi(value)];

const metrics = {
	visibleWidth(value) {
		return chars(value).length;
	},
	truncateToWidth(value, width, ellipsis = '') {
		if (width <= 0) return '';
		if (this.visibleWidth(value) <= width) return value;
		const tail = ellipsis ?? '';
		const keep = Math.max(0, width - [...tail].length);
		return chars(value).slice(0, keep).join('') + tail;
	},
	wrapTextWithAnsi(value, width) {
		const words = stripAnsi(value).split(' ');
		if (width <= 0) return [stripAnsi(value)];
		const lines = [];
		let current = '';
		for (const word of words) {
			const candidate = current === '' ? word : `${current} ${word}`;
			if ([...candidate].length <= width) {
				current = candidate;
				continue;
			}
			if (current !== '') {
				lines.push(current);
				current = '';
			}
			if ([...word].length <= width) {
				current = word;
				continue;
			}
			const rest = [...word];
			while (rest.length > width) lines.push(rest.splice(0, width).join(''));
			current = rest.join('');
		}
		lines.push(current);
		return lines;
	},
};

// ---- themes: a theme is an injected fg(role, text) (and optional bg) ----

const plainTheme = {
	fg(_role, value) {
		return value;
	},
};

const taggedTheme = {
	fg(role, value) {
		return `<${role}>${value}</${role}>`;
	},
};

/** A theme that records every role it is asked to paint, so no role is invented. */
function recordingTheme() {
	const roles = [];
	return {
		roles,
		fg(role, value) {
			roles.push(role);
			return value;
		},
	};
}

function card(overrides = {}) {
	return {
		title: 'Gentle AI',
		subtitle: 'review preflight',
		body: ['Receipt-driven development is enabled, and this worktree holds an unreviewed candidate.', '', 'Call the gentle_review tool with inspect and follow the transition it returns.'],
		tone: CARD_TONE.INFO,
		...overrides,
	};
}

// ---- exports and the one style ----

test("the module exports the card surface and only the outline style", () => {
	assert.equal(CARD_GLYPH, "✿");
	assert.deepEqual(CARD_TONE, { INFO: "info", SUCCESS: "success", WARNING: "warning", ERROR: "error" });
	assert.deepEqual(CARD_STYLE, { OUTLINE: "outline" }, "the float style is not ported: one style, no customize surface");
	for (const [name, value] of Object.entries({ CARD_GLYPH, CARD_STYLE, CARD_TONE, cardAwaitingResult, cardBodyRows, cardBottom, cardElapsed, cardInnerWidth, cardLine, cardRunningLine, cardTop, cardTopLine, cardTopRows, headingFits, markCardResult })) {
		assert.ok(value !== undefined, `${name} is exported`);
	}
});

// ---- inner width and body rows ----

test("cardInnerWidth is the frame width minus the four frame columns, never below one", () => {
	assert.equal(cardInnerWidth(40), 36);
	assert.equal(cardInnerWidth(5), 1);
	assert.equal(cardInnerWidth(4), 1, "the floor is one column");
	assert.equal(cardInnerWidth(0), 1);
	assert.equal(cardInnerWidth(-7), 1);
});

test("a body row is padded to the full inner width and a wide row ends in a literal ellipsis", () => {
	const padded = cardLine("hello", CARD_TONE.INFO, plainTheme, 20, metrics);
	assert.equal(padded, `│ hello${" ".repeat(11)} │`);
	assert.equal(metrics.visibleWidth(padded), 20);

	const clipped = cardLine("x".repeat(30), CARD_TONE.SUCCESS, plainTheme, 12, metrics);
	assert.equal(clipped, `│ ${"x".repeat(7)}… │`, "the inner width clips with U+2026, never a three dot ellipsis");
	assert.equal(metrics.visibleWidth(clipped), 12);

	assert.equal(cardLine("hi", CARD_TONE.INFO, plainTheme, 0, metrics), "");
	assert.equal(cardLine("hi", CARD_TONE.INFO, plainTheme, 1, metrics), "│");
	assert.equal(cardLine("hi", CARD_TONE.INFO, plainTheme, 2, metrics), "││");
	assert.equal(cardLine("hi", CARD_TONE.INFO, plainTheme, 3, metrics), "│ │");

	const tagged = cardLine("hi", CARD_TONE.ERROR, taggedTheme, 12, metrics);
	assert.equal(tagged, `<error>│</error> hi${' '.repeat(6)} <error>│</error>`, "the sides carry the tone role and the content stays inside them");
});

test("cardBodyRows wraps, splits paragraphs and applies the preview budget", () => {
	const paragraph = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
	const rows = cardBodyRows([paragraph], CARD_TONE.INFO, plainTheme, 30, { expanded: true }, metrics);
	assert.ok(rows.length > 1, "a paragraph wider than the inner width wraps");
	for (const row of rows) {
		assert.equal(metrics.visibleWidth(row), 30, `"${row}" is not 30 wide`);
		assert.match(row, /^│ .* │$/);
	}
	const rejoined = rows.map((row) => stripAnsi(row).slice(2, -2).trim()).join(" ");
	assert.equal(rejoined, paragraph, "wrapping keeps every word");

	const multiline = cardBodyRows(["one\ntwo\nthree\nfour"], CARD_TONE.INFO, plainTheme, 30, { expanded: true }, metrics);
	assert.equal(multiline.length, 4, "each source line is its own row");
	assert.ok(multiline.every((row) => !row.includes("\n")), "each returned row is physically one terminal row");

	assert.equal(cardBodyRows(["one", "two", "three", "four"], CARD_TONE.INFO, plainTheme, 30, { expanded: false, previewRows: 3 }, metrics).length, 3, "the preview budget caps the rows");
	assert.equal(cardBodyRows(["one", "two", "three", "four"], CARD_TONE.INFO, plainTheme, 30, { expanded: false }, metrics).length, 3, "three preview rows by default");
	assert.deepEqual(cardBodyRows(["one"], CARD_TONE.INFO, plainTheme, 0, { expanded: true }, metrics), [], "no width draws nothing");
	const empty = cardBodyRows(["", "one"], CARD_TONE.INFO, plainTheme, 12, { expanded: true }, metrics);
	assert.equal(empty[0], `│${" ".repeat(10)}│`, "a blank line keeps the frame");

	assert.deepEqual(cardBodyRows(["hi"], CARD_TONE.WARNING, taggedTheme, 12, { expanded: true }, metrics), [`<warning>│</warning> hi${' '.repeat(6)} <warning>│</warning>`]);
});

// ---- the top rule ----

test("cardTop draws the rounded frame with the glyph, the title and a dot separated detail", () => {
	const row = cardTop(card(), plainTheme, 48, undefined, metrics);
	assert.match(row, /^╭─ ✿ Gentle AI · review preflight ─+╮$/);
	assert.equal(metrics.visibleWidth(row), 48);
	assert.match(row, /╭─ ✿ Gentle AI · review preflight ─{13}╮$/, "the rule fills the remaining width");

	const custom = cardTop(card({ glyph: "✎", subtitle: undefined }), plainTheme, 40, undefined, metrics);
	assert.match(custom, /^╭─ ✎ Gentle AI ─+╮$/);

	assert.equal(cardTop(card(), plainTheme, 0, undefined, metrics), "");
	assert.equal(cardTop(card(), plainTheme, 1, undefined, metrics), "╭", "a one column frame is the corner alone");
	assert.equal(cardTop(card(), plainTheme, 4, undefined, metrics), "╭──╮");
});

test("cardTop right-aligns a hint in the rule and drops it before truncating the heading", () => {
	const hinted = cardTop(card(), plainTheme, 60, "ctrl+o expand", metrics);
	assert.match(hinted, /^╭─ ✿ Gentle AI · review preflight ─+ ctrl\+o expand ╮$/);
	assert.equal(metrics.visibleWidth(hinted), 60);

	const dropped = cardTop(card(), plainTheme, 40, "ctrl+o expand", metrics);
	assert.equal(dropped, "╭─ ✿ Gentle AI · review preflight ─────╮", "the hint yields before the heading does");
	assert.equal(metrics.visibleWidth(dropped), 40);

	const narrowed = cardTop(card({ subtitle: undefined, title: "Gentle AI review" }), plainTheme, 20, undefined, metrics);
	assert.equal(narrowed, "╭─ ✿ Gentle AI rev ╮", "a heading too wide for the rule is clipped");
	assert.equal(metrics.visibleWidth(narrowed), 20);
});

test("cardTop and cardLine paint every frame cell in the tone's own role", () => {
	const roles = {
		[CARD_TONE.INFO]: { frame: "border", title: "accent" },
		[CARD_TONE.SUCCESS]: { frame: "success", title: "success" },
		[CARD_TONE.WARNING]: { frame: "warning", title: "warning" },
		[CARD_TONE.ERROR]: { frame: "error", title: "error" },
	};
	for (const [tone, expected] of Object.entries(roles)) {
		const row = cardTop({ title: "t", subtitle: undefined, body: [], tone }, taggedTheme, 30, undefined, metrics);
		assert.match(row, new RegExp(`^<${expected.frame}>╭</${expected.frame}><${expected.frame}>─ </${expected.frame}><${expected.title}>✿ t</${expected.title}>`), tone);
		assert.match(cardLine("x", tone, taggedTheme, 30, metrics), new RegExp(`^<${expected.frame}>│</${expected.frame}>`), tone);
		assert.match(cardBottom(tone, taggedTheme, 30, undefined, metrics), new RegExp(`^<${expected.frame}>╰</${expected.frame}>`), tone);
	}

	const info = cardTop(card(), taggedTheme, 80, undefined, metrics);
	assert.equal(info, "<border>╭</border><border>─ </border><accent>✿ Gentle AI</accent> <muted>·</muted> <muted>review preflight</muted><border> ─────────────────────────────────────────────</border><border>╮</border>");
	const error = cardTop(card({ tone: CARD_TONE.ERROR }), taggedTheme, 80, "ctrl+o to expand", metrics);
	assert.equal(error, "<error>╭</error><error>─ </error><error>✿ Gentle AI</error> <muted>·</muted> <muted>review preflight</muted><error> ───────────────────────────</error> <dim>ctrl+o to expand</dim> <error>╮</error>");

	// A card that names its own title role paints the label there and keeps the
	// tone on the frame.
	const labelled = cardTop(card({ glyph: "◎", title: "exploring", subtitle: "git status", tone: CARD_TONE.SUCCESS, titleRole: "mdLink" }), taggedTheme, 80, undefined, metrics);
	assert.match(labelled, /^<success>╭<\/success><success>─ <\/success><mdLink>◎ exploring<\/mdLink> <muted>·<\/muted> <muted>git status<\/muted><success> /);
});

test("the card functions never paint a role the source branch does not use", () => {
	const recorder = recordingTheme();
	const bodies = ["alpha bravo charlie", "x".repeat(120)];
	for (const tone of Object.values(CARD_TONE)) {
		for (const width of [5, 12, 30, 60]) {
			cardTop(card({ tone }), recorder, width, "ctrl+o", metrics);
			cardTopLine(card({ tone }), recorder, width, "ctrl+o", undefined, metrics);
			cardTopRows(card({ tone, title: "bash $ printf alpha bravo charlie delta" }), recorder, width, "ctrl+o", metrics);
			cardBodyRows(bodies, tone, recorder, width, { expanded: true }, metrics);
			cardBottom(tone, recorder, width, "1.2s", metrics);
			cardRunningLine(tone, recorder, width, metrics);
		}
	}
	assert.deepEqual([...new Set(recorder.roles)].sort(), ["accent", "border", "dim", "error", "muted", "success", "warning"]);
});

// ---- heading rows ----

test("a collapsed heading truncates an over-wide detail with an ellipsis and keeps the title and the hint", () => {
	const value = { title: "bash", subtitle: "printf alpha bravo charlie delta echo foxtrot golf hotel", body: [], tone: CARD_TONE.WARNING };
	const row = cardTopLine(value, plainTheme, 40, "to expand", undefined, metrics);
	assert.equal(metrics.visibleWidth(row), 40);
	assert.match(row, /^╭─ ✿ bash · printf .*….*to expand ╮$/, "the detail ends in an ellipsis instead of a second row");
	assert.doesNotMatch(row, /golf/, "only what fits stays visible");
	assert.match(row, /^╭─ ✿ bash /, "the title always survives the truncation");

	const narrow = cardTopLine(value, plainTheme, 22, "to expand", undefined, metrics);
	assert.equal(metrics.visibleWidth(narrow), 22);
	assert.match(narrow, /…/, "truncation still ends in an ellipsis");
	assert.doesNotMatch(narrow, /to expand/, "the hint yields its columns to the detail");

	assert.match(cardTopLine({ ...value, subtitle: "git diff" }, plainTheme, 40, "to expand", undefined, metrics), /^╭─ ✿ bash · git diff ─+ to expand ╮$/);
	assert.match(cardTopLine({ ...value, subtitle: "git diff\n--stat" }, plainTheme, 60, undefined, undefined, metrics), /^╭─ ✿ bash · git diff --stat ─+╮$/, "a multi-line detail collapses onto the one row");
	assert.match(cardTopLine({ ...value, subtitle: undefined }, plainTheme, 40, "to expand", undefined, metrics), /^╭─ ✿ bash ─+ to expand ╮$/, "without a detail the row is a plain top rule");
	const measured = cardTopLine(value, plainTheme, 40, undefined, (room) => `${room} files`, metrics);
	assert.match(measured, /· \d+ files/, "a caller that measures its own detail receives the room left on the row");
});

test("an expanded heading wraps onto body rows instead of losing the detail", () => {
	const detail = "printf alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
	const value = { title: "bash", subtitle: detail, body: [], tone: CARD_TONE.WARNING };
	const lines = cardTopRows(value, plainTheme, 60, "ctrl+o to expand", metrics);
	assert.match(lines[0], /^╭─ ✿ bash ─+ ctrl\+o to expand ╮$/, "the title keeps the top rule and the hint");
	assert.ok(!lines[0].includes("printf"), "a detail too wide for the rule never crowds the title");
	assert.ok(lines.length > 1, "the detail continues inside the frame");
	for (const line of lines) assert.equal(metrics.visibleWidth(line), 60, `"${line}" is not 60 wide`);
	const shown = lines.slice(1).map((line) => stripAnsi(line).slice(2, -2).trim()).join(" ").replace(/\s+/g, " ").trim();
	assert.equal(shown, `· ${detail}`, "the complete detail stays visible");

	// A detail that fits keeps travelling on the title row, as every other card does.
	const short = cardTopRows({ ...value, subtitle: "git status" }, plainTheme, 60, "ctrl+o to expand", metrics);
	assert.match(short[0], /^╭─ ✿ bash · git status ─+ ctrl\+o to expand ╮$/);
	assert.equal(short.length, 1);
});

test("a long title continues on body rows and a reserved hint never loses text", () => {
	const title = "bash $ printf alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa";
	const hint = "configured to expand";
	// At 40 columns the reserved hint leaves less than MIN_HEADING_COLUMNS for the
	// heading, so it yields its columns entirely (the source rule); no text is lost
	// at any width.
	for (const width of [40, 60, 120]) {
		const lines = cardTopRows({ title, subtitle: undefined, body: [], tone: CARD_TONE.WARNING }, plainTheme, width, hint, metrics);
		assert.match(lines[0], /^╭─ ✿ bash \$ printf /);
		if (width >= 60) assert.match(lines[0], /configured to expand ╮$/, `the hint rides the rule at ${width}`);
		else assert.doesNotMatch(lines[0], /configured/, "a hint that leaves no heading room gives way");
		assert.ok(lines.length > 1, "the long heading continues inside the same frame");
		for (const line of lines) assert.equal(metrics.visibleWidth(line), width, `"${line}" is not ${width} wide`);
		const content = lines
			.map((line, index) => (index === 0 ? line.replace(/^╭─ ✿ /, "").replace(/ ─+(?: configured to expand)? ?╮$/, "") : line.replace(/^│ /, "").replace(/ +│$/, "")))
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		assert.equal(content, title, `hint reservation must not lose any heading text at ${width}`);
	}
	for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
		const lines = cardTopRows({ title, subtitle: undefined, body: [], tone: CARD_TONE.INFO }, plainTheme, width, hint, metrics);
		assert.ok(lines.every((line) => metrics.visibleWidth(line) <= width), `width ${width}`);
		assert.ok(!lines.some((line) => line.includes("configured")), `no hint at ${width}`);
	}
	assert.deepEqual(cardTopRows({ title: "x", subtitle: undefined, body: [], tone: CARD_TONE.INFO }, plainTheme, 0, undefined, metrics), [], "no width draws no rows");
});

test("headingFits says whether a composed subtitle still leaves room for the key hint", () => {
	const value = { title: "Agent status", subtitle: "explore", body: [], tone: CARD_TONE.INFO, glyph: "◎" };
	const hint = "expand";
	const needed = metrics.visibleWidth("◎ Agent status") + 3 + metrics.visibleWidth("explore") + 5 + metrics.visibleWidth(hint) + 2;
	assert.equal(headingFits(value, hint, needed, metrics), true, "exactly enough columns still shows the hint");
	assert.equal(headingFits(value, hint, needed - 1, metrics), false, "one column short is a no");
	assert.equal(headingFits(value, undefined, needed - (metrics.visibleWidth(hint) + 2), metrics), true, "without a hint the head columns are enough");
	assert.equal(headingFits(value, undefined, needed - (metrics.visibleWidth(hint) + 3), metrics), false, "and one column less is still a no");
	assert.equal(headingFits({ ...value, subtitle: undefined }, hint, needed - 9, metrics), true, "no subtitle frees its separator and columns");
});

// ---- the running row and the closing rule ----

test("a running call draws one muted running row inside the frame", () => {
	assert.equal(cardRunningLine(CARD_TONE.WARNING, plainTheme, 20, metrics), `│ running…${" ".repeat(8)} │`);
	const recorder = recordingTheme();
	assert.equal(cardRunningLine(CARD_TONE.INFO, recorder, 20, metrics), `│ running…${" ".repeat(8)} │`);
	assert.deepEqual([...new Set(recorder.roles)].sort(), ["border", "muted"], "the text is muted and the frame keeps the tone");
	for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
		assert.ok(metrics.visibleWidth(cardRunningLine(CARD_TONE.WARNING, plainTheme, width, metrics)) <= width, `width ${width}`);
	}
});

test("cardBottom closes the frame and right-aligns elapsed content only when three columns stay free", () => {
	assert.equal(cardBottom(CARD_TONE.SUCCESS, plainTheme, 20, undefined, metrics), `╰${"─".repeat(18)}╯`);
	assert.equal(cardBottom(CARD_TONE.SUCCESS, plainTheme, 20, "", metrics), `╰${"─".repeat(18)}╯`, "empty content draws the plain rule");
	assert.equal(cardBottom(CARD_TONE.SUCCESS, plainTheme, 20, "1.2s", metrics), `╰${"─".repeat(12)} 1.2s ╯`);
	assert.equal(metrics.visibleWidth(cardBottom(CARD_TONE.SUCCESS, plainTheme, 20, "1.2s", metrics)), 20);
	// 20 - 2 - 6 = 12 columns of fill, and exactly three is still enough.
	assert.equal(cardBottom(CARD_TONE.SUCCESS, plainTheme, 11, "1.2s", metrics), `╰${"─".repeat(3)} 1.2s ╯`);
	assert.equal(cardBottom(CARD_TONE.SUCCESS, plainTheme, 10, "1.2s", metrics), `╰${"─".repeat(8)}╯`, "two free columns are not enough: the plain rule wins");
	assert.equal(cardBottom(CARD_TONE.ERROR, taggedTheme, 20, "1.2s", metrics), `<error>╰</error><error>──────────── </error><dim>1.2s</dim><error> ╯</error>`);
	assert.equal(cardBottom(CARD_TONE.ERROR, plainTheme, 0, "1.2s", metrics), "");
	assert.equal(cardBottom(CARD_TONE.ERROR, plainTheme, 1, "1.2s", metrics), "╰");
});

test("cardElapsed reads milliseconds and seconds and is omitted when the duration is unknown", () => {
	assert.equal(cardElapsed(0), "0ms");
	assert.equal(cardElapsed(42), "42ms");
	assert.equal(cardElapsed(999), "999ms");
	assert.equal(cardElapsed(1200), "1.2s");
	assert.equal(cardElapsed(60000), "60.0s");
	for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -5]) assert.equal(cardElapsed(value), undefined, String(value));
});

// ---- the shared row state ----

test("a call card awaits its result until the host finishes the row or a result renderer marks it", () => {
	const state = {};
	assert.equal(cardAwaitingResult({ isPartial: true, state }), true);
	assert.equal(cardAwaitingResult({ state }), true, "an unknown lifecycle is still pending");
	assert.equal(cardAwaitingResult({ isPartial: true }), true, "no shared state: only the final flag closes it");
	assert.equal(cardAwaitingResult({ isPartial: false, state }), false, "a final result always exists");
	markCardResult(state);
	assert.equal(cardAwaitingResult({ isPartial: true, state }), false, "a partial result component closes the frame");
	assert.deepEqual(Object.keys(state), [], "the mark never shows up as ordinary row state");
	for (const value of [undefined, null, 1, "state"]) {
		assert.doesNotThrow(() => markCardResult(value));
		assert.equal(cardAwaitingResult({ isPartial: true, state: value }), true);
	}
});
