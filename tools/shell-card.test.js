'use strict';
// S5 / T5a: the card drawing substrate in its TWO styles. Every case reads the
// public surface of lib/shell-card.js and pins what the source branch
// (lib/shell-card.ts and tests/shell-card.test.ts) draws — the rounded neon frame
// and the float rail. Width measurement, truncation and wrapping are the injected
// `metrics` seam, so this suite supplies deterministic fakes and never needs
// the host TUI package (this package has no node_modules).
//
// The style itself is the process-wide slot Gentle Shell publishes
// (`globalThis[Symbol.for("gentle-pi.card-style")]`) with the user's document as
// the fallback, so this suite points `GENTLE_PI_CONFIG_HOME` at a scratch
// directory: no case ever reads or writes the real user's preference, and the
// slot is cleared after each case that sets it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
	CARD_GLYPH,
	CARD_STYLE,
	CARD_TONE,
	TONE_OWNS_BOX,
	cardAwaitingResult,
	cardBodyRows,
	cardBottom,
	cardElapsed,
	cardInnerWidth,
	cardLine,
	cardMouseEvent,
	cardRunningLine,
	cardTop,
	cardTopLine,
	cardTopRows,
	floatRows,
	headingFits,
	markCardResult,
} = require('../lib/shell-card.js');
const { CARD_STYLE_SCHEMA, cardStyle } = require('../lib/card-style.js');

// ---- the style seam: the process-wide slot, and a scratch preference home ----

const CARD_STYLE_SLOT = Symbol.for('gentle-pi.card-style');

function useStyle(style) {
	if (style === undefined) delete globalThis[CARD_STYLE_SLOT];
	else globalThis[CARD_STYLE_SLOT] = style;
}

/** Runs `run` with the slot saying `style`, then clears the slot. */
function withStyle(style, run) {
	useStyle(style);
	try {
		return run();
	} finally {
		useStyle(undefined);
	}
}

let configHome;
const savedHome = process.env.GENTLE_PI_CONFIG_HOME;
const styleDocument = () => join(configHome, 'card-style.json');

function writeStyleDocument(contents) {
	writeFileSync(styleDocument(), typeof contents === 'string' ? contents : JSON.stringify(contents));
}

function removeStyleDocument() {
	try {
		unlinkSync(styleDocument());
	} catch {
		// Already absent: the missing document is the case under test.
	}
}

before(() => {
	configHome = mkdtempSync(join(tmpdir(), 'odd-shell-card-style-'));
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	useStyle(undefined);
});

after(() => {
	useStyle(undefined);
	if (savedHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
	else process.env.GENTLE_PI_CONFIG_HOME = savedHome;
	rmSync(configHome, { recursive: true, force: true });
});

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

// The background reset a Pi theme hands back at the end of `bg(role, "")`. It is
// spelled here, in the test, so the module under test can stay free of raw escapes.
const BG_RESET = '\x1b[49m';

/** A theme that records every role it paints and can paint the float background. */
function floatTheme() {
	const roles = { fg: [], bg: [] };
	return {
		roles,
		fg(role, value) {
			roles.fg.push(role);
			return `<${role}>${value}</${role}>`;
		},
		bg(role, value) {
			roles.bg.push(role);
			return `\x1b[48;5;240m${value}${BG_RESET}`;
		},
	};
}

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

// ---- exports and the two styles ----

test("the module exports the card surface and both styles", () => {
	assert.equal(CARD_GLYPH, "✿");
	assert.deepEqual(CARD_TONE, { INFO: "info", SUCCESS: "success", WARNING: "warning", ERROR: "error" });
	assert.deepEqual(CARD_STYLE, { NEON: "neon", FLOAT: "float" }, "the two styles the shell offers, nothing else");
	for (const [name, value] of Object.entries({ CARD_GLYPH, CARD_STYLE, CARD_TONE, cardAwaitingResult, cardBodyRows, cardBottom, cardElapsed, cardInnerWidth, cardLine, cardRunningLine, cardTop, cardTopLine, cardTopRows, floatRows, headingFits, markCardResult })) {
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
	assert.equal(tagged, `<error>│</error> <text>hi</text>${' '.repeat(6)} <error>│</error>`, "the sides carry the tone role, the content the body role and nothing is padded twice");
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

	assert.deepEqual(cardBodyRows(["hi"], CARD_TONE.WARNING, taggedTheme, 12, { expanded: true }, metrics), [`<warning>│</warning> <text>hi</text>${' '.repeat(6)} <warning>│</warning>`]);
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

test("cardTop, cardLine and cardBottom paint the frame and the label in the tone's role", () => {
	// The reference tables (lib/shell-card.ts TITLE_ROLE / FRAME_ROLE): every tone
	// paints its own label, and INFO alone opens the accent its plain border cannot
	// carry. The frame and the label therefore agree for every tone but INFO.
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

	// INFO is the one card whose frame and label differ: the plain border with the
	// accent label every informational card uses.
	const info = cardTop(card(), taggedTheme, 80, undefined, metrics);
	assert.equal(info, "<border>╭</border><border>─ </border><accent>✿ Gentle AI</accent> <muted>·</muted> <muted>review preflight</muted><border> ─────────────────────────────────────────────</border><border>╮</border>");
	// A success card labels itself in its own role, not in the accent.
	const success = cardTop(card({ tone: CARD_TONE.SUCCESS }), taggedTheme, 80, undefined, metrics);
	assert.match(success, /^<success>╭<\/success><success>─ <\/success><success>✿ Gentle AI<\/success> <muted>·<\/muted> <muted>review preflight<\/muted><success> ─+<\/success><success>╮<\/success>$/);
	assert.equal(success.includes("<warning>"), false, "a settled success is never labelled in the accent");
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
	assert.deepEqual([...new Set(recorder.roles)].sort(), ["accent", "border", "dim", "error", "muted", "success", "text", "warning"]);
});

test("a body row is clipped and padded on plain text and painted only afterwards", () => {
	// The order the substrate guarantees: the text is measured and clipped first, and
	// the role wraps the RESULT. So a clipped row is a complete paint of a plain clip,
	// never a clip of a painted string.
	assert.equal(cardLine("alpha bravo", CARD_TONE.INFO, taggedTheme, 16, metrics), `<border>│</border> <text>alpha bravo</text>  <border>│</border>`, "a row that fits is painted whole, inside its padding");
	assert.equal(cardLine("x".repeat(30), CARD_TONE.SUCCESS, taggedTheme, 12, metrics), `<success>│</success> <text>xxxxxxx…</text> <success>│</success>`, "the clip happens before the paint, so the mark closes the text and the role closes the mark");
	const recorder = recordingTheme();
	cardBodyRows(["alpha", "", "bravo"], CARD_TONE.INFO, recorder, 20, { expanded: true }, metrics);
	assert.deepEqual(recorder.roles, ["border", "text", "border", "border", "border", "border", "text", "border"], "the body borrows neither the frame's tone nor the label's role, and a blank row is painted in no role at all");
});

test("no painted string is ever measured, clipped or padded", () => {
	// The seam records every string the substrate asks it to measure. A theme that
	// tags its roles makes a painted input unmistakable: none may ever arrive.
	const seen = [];
	const seam = {
		visibleWidth(value) {
			seen.push(String(value));
			return metrics.visibleWidth(value);
		},
		truncateToWidth(value, width, ellipsis) {
			seen.push(String(value));
			return metrics.truncateToWidth(value, width, ellipsis);
		},
		wrapTextWithAnsi(value, width) {
			seen.push(String(value));
			return metrics.wrapTextWithAnsi(value, width);
		},
	};
	for (const width of [60, 30, 22, 14]) {
		cardTop(card({ title: "Gentle AI review", subtitle: "a detail far too wide for this rule", tone: CARD_TONE.WARNING }), taggedTheme, width, "ctrl+o to expand", seam);
		cardTopLine(card({ title: "bash", subtitle: "printf alpha bravo charlie delta echo", tone: CARD_TONE.WARNING }), taggedTheme, width, "to expand", undefined, seam);
		cardTopRows(card({ title: "bash $ printf alpha bravo charlie delta", subtitle: "and a detail", tone: CARD_TONE.WARNING }), taggedTheme, width, "ctrl+o", seam);
		cardBodyRows(["alpha bravo charlie delta echo", ""], CARD_TONE.WARNING, taggedTheme, width, { expanded: true }, seam);
		cardRunningLine(CARD_TONE.WARNING, taggedTheme, width, seam);
		cardBottom(CARD_TONE.WARNING, taggedTheme, width, "1.2s", seam);
	}
	assert.ok(seen.length > 0, "the seam was exercised");
	for (const value of seen) assert.equal(/<\/?[a-z]+>/.test(value), false, `a painted string reached the seam: ${value}`);
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

// ---- the float style, and the one style decision ----

// A card whose content is short enough that neither style's column difference can
// move a wrap boundary: this is the "same text, different chrome" card.
const SHORT_CARD = card({
	subtitle: 'review preflight',
	body: ['alpha bravo', 'charlie delta'],
});

/** A plain theme that can also paint the float background, so the text stays readable. */
function paintTheme() {
	const roles = { fg: [], bg: [] };
	return {
		roles,
		fg(role, value) {
			roles.fg.push(role);
			return value;
		},
		bg(role, value) {
			roles.bg.push(role);
			return `\x1b[48;5;240m${value}${BG_RESET}`;
		},
	};
}

/** One card component's parts, at the width the substrate hands the renderer. */
function partsAt(theme, value = SHORT_CARD, elapsed = '1.2s') {
	return (width) => ({
		head: [cardTop(value, theme, width, undefined, metrics)],
		body: cardBodyRows(value.body, value.tone, theme, width, { expanded: true }, metrics),
		bottom: cardBottom(value.tone, theme, width, elapsed, metrics),
	});
}

/** The card's text with every chrome cell removed: what the reader actually reads. */
function contentOf(rows) {
	return rows
		.map((row) => stripAnsi(row).replace(/[╭╮╰╯─│▎]/g, ' ').replace(/\s+/g, ' ').trim())
		.filter((text) => text.length > 0)
		.join(' | ');
}

test('the float style draws the accent rail, the tone background and the two padding rows, and no box', () => {
	const theme = floatTheme();
	const rows = withStyle(CARD_STYLE.FLOAT, () => floatRows(CARD_TONE.WARNING, theme, 40, partsAt(theme)));
	assert.equal(rows.length, 6, 'padding row, heading, padding row, two body rows and the closing row');
	const visible = rows.map((row) => stripAnsi(row).replace(/<\/?[a-z:]+>/g, ''));
	for (const row of rows) {
		assert.equal(metrics.visibleWidth(stripAnsi(row).replace(/<\/?[a-z:]+>/g, '')), 40, 'every row is exactly the width the host asked for');
		assert.ok(row.startsWith(' \x1b[48;5;240m'), 'every row is painted behind the tone background, inside the margin');
		assert.ok(row.endsWith('\x1b[49m '), 'the background is closed before the right margin');
	}
	assert.equal(visible[0].trim(), '▎', 'the padding row above the heading keeps the rail');
	assert.equal(visible[2].trim(), '▎', 'the separator between the heading and the body keeps it too');
	assert.match(visible[1], /^ ▎ ✿ Gentle AI · review preflight +$/, 'the heading rides the rail with no corners');
	assert.match(visible[3], /^ ▎ alpha bravo +$/, 'the body rides the rail with no sides');
	assert.match(visible[5], /^ ▎ +1\.2s +$/, 'the closing row right-aligns the elapsed time');
	for (const row of visible) assert.doesNotMatch(row, /[╭╮╰╯─│]/, 'the float style draws no box');
	assert.deepEqual(theme.roles.bg, ['toolPendingBg'], 'the warning tone paints its own background role');
});

// ---- the rail role: one card, one role for its whole closed box ----

// The reference's `Card.railRole` (lib/shell-card.ts `frameRole`): a card with
// nothing left to report may name the role of its whole box — corners, rules, sides
// and rail — so the box reads as part of the label it belongs to. A tone that owns
// the box (a call still running, a call that failed) keeps its own frame role, and
// a card that names nothing keeps today's drawing byte for byte.
const RAIL_CARD = { title: 'codegraph', subtitle: 'init', body: ['→ initialized'], tone: CARD_TONE.INFO, glyph: '◎', titleRole: 'mdCode', railRole: 'mdCode' };

/** The card's rows with the fake theme taken out, so a width can be measured. */
const untag = (value) => stripAnsi(value).replace(/<[^>]*>/g, '');

function railParts(theme, value = RAIL_CARD) {
	return (width) => ({
		head: [cardTop(value, theme, width, undefined, metrics)],
		body: cardBodyRows(value.body, value.tone, theme, width, { expanded: true }, metrics),
		bottom: cardBottom(value.tone, theme, width, '1.2s', metrics),
	});
}

test('a card that names a rail role paints its whole box there, and a status tone still owns it', () => {
	// The reference's own table, which decides between the two: only a call still
	// running or one that failed speaks for its box.
	assert.deepEqual(TONE_OWNS_BOX, { info: false, success: false, warning: true, error: true });
	const top = cardTop(RAIL_CARD, taggedTheme, 60, undefined, metrics);
	assert.match(top, /^<mdCode>╭<\/mdCode><mdCode>─ <\/mdCode><mdCode>◎ codegraph<\/mdCode> <muted>·<\/muted> <muted>init<\/muted><mdCode> /, 'the corners and the lead carry the card role');
	assert.match(top, /<mdCode> ─+<\/mdCode><mdCode>╮<\/mdCode>$/, 'and so do the rule and the closing corner');
	assert.equal(top.includes('<border>'), false, 'no cell of the box keeps the tone role');

	// A card that names no rail role is drawn exactly as before: the tone owns the box.
	const described = cardTop({ ...RAIL_CARD, railRole: undefined }, taggedTheme, 60, undefined, metrics);
	assert.match(described, /^<border>╭<\/border><border>─ <\/border>/);
	assert.equal(described.includes('<mdCode>╭'), false);

	// An active state speaks for the call: a running card keeps the warning role and a
	// failed one the error role, whatever identity the card named.
	assert.match(cardTop({ ...RAIL_CARD, tone: CARD_TONE.WARNING }, taggedTheme, 60, undefined, metrics), /^<warning>╭<\/warning>/);
	assert.match(cardTop({ ...RAIL_CARD, tone: CARD_TONE.ERROR }, taggedTheme, 60, undefined, metrics), /^<error>╭<\/error>/);
});

test('the float style paints the rail, the padding rows and the closing rule in the card role', () => {
	const theme = floatTheme();
	const rows = withStyle(CARD_STYLE.FLOAT, () => floatRows(CARD_TONE.INFO, theme, 40, railParts(theme), 'mdCode'));
	assert.equal(rows.length, 5, 'padding row, heading, padding row, one body row and the closing row');
	for (const row of rows) {
		assert.ok(row.includes('<mdCode>▎</mdCode>'), `"${row}" does not paint its rail in the card role`);
		assert.equal(metrics.visibleWidth(untag(row)), 40, 'every row is the width the host asked for');
	}
	assert.equal(rows.join('\n').includes('<border>'), false, 'no cell of the band keeps the tone role');
	assert.deepEqual(theme.roles.bg, ['toolSuccessBg'], 'the tone still decides the band the rail rides on');

	// Without a rail role the float card is unchanged: the tone paints its rail.
	const byTone = withStyle(CARD_STYLE.FLOAT, () => floatRows(CARD_TONE.INFO, theme, 40, railParts(theme)));
	assert.ok(byTone.join('\n').includes('<border>▎</border>'));

	// A running card keeps its own tone on the rail, and a failed one its error role.
	const running = withStyle(CARD_STYLE.FLOAT, () => floatRows(CARD_TONE.WARNING, theme, 40, railParts(theme, { ...RAIL_CARD, tone: CARD_TONE.WARNING }), 'mdCode'));
	assert.ok(running.join('\n').includes('<warning>▎</warning>'));
	assert.equal(running.join('\n').includes('<mdCode>▎</mdCode>'), false);
	const failed = withStyle(CARD_STYLE.FLOAT, () => floatRows(CARD_TONE.ERROR, theme, 40, railParts(theme, { ...RAIL_CARD, tone: CARD_TONE.ERROR }), 'mdCode'));
	assert.ok(failed.join('\n').includes('<error>▎</error>'));
});

test('the float rail and the label take the tone role, and INFO its accent, never a colour of their own', () => {
	// The reference contract (lib/shell-card.ts frame() and TITLE_ROLE): the float
	// chrome paints the same FRAME_ROLE[tone] the neon frame does, and the label
	// carries TITLE_ROLE[tone] — the tone, or the accent for INFO.
	const expected = {
		[CARD_TONE.INFO]: { frame: 'border', title: 'accent', bg: 'toolSuccessBg' },
		[CARD_TONE.SUCCESS]: { frame: 'success', title: 'success', bg: 'toolSuccessBg' },
		[CARD_TONE.WARNING]: { frame: 'warning', title: 'warning', bg: 'toolPendingBg' },
		[CARD_TONE.ERROR]: { frame: 'error', title: 'error', bg: 'toolErrorBg' },
	};
	for (const [tone, roles] of Object.entries(expected)) {
		const theme = floatTheme();
		const rows = withStyle(CARD_STYLE.FLOAT, () => floatRows(tone, theme, 40, partsAt(theme, { ...SHORT_CARD, tone })));
		const painted = rows.join('\n');
		assert.ok(painted.includes(`<${roles.frame}>▎</${roles.frame}>`), `${tone}: the rail carries the tone role`);
		assert.ok(painted.includes(`<${roles.title}>✿ Gentle AI</${roles.title}>`), `${tone}: the label carries its title role`);
		assert.deepEqual([...new Set(theme.roles.fg)].sort(), [...new Set(['dim', 'muted', 'text', roles.frame, roles.title])].sort(), `${tone}: no role outside the tone, the label, the body text, the detail and the hint`);
		assert.deepEqual(theme.roles.bg, [roles.bg], `${tone}: the float band paints its own tone background`);
	}
});

test('the same card is the same text in both styles, and only the chrome differs', () => {
	const theme = paintTheme();
	const neon = withStyle(CARD_STYLE.NEON, () => floatRows(CARD_TONE.INFO, theme, 60, partsAt(theme)));
	const float = withStyle(CARD_STYLE.FLOAT, () => floatRows(CARD_TONE.INFO, theme, 60, partsAt(theme)));
	assert.equal(contentOf(float), contentOf(neon), 'same heading, same body, same elapsed time');
	assert.match(stripAnsi(neon[0]), /^╭─ ✿ Gentle AI/);
	assert.match(stripAnsi(float[1]), /^ ▎ ✿ Gentle AI/);
	assert.equal(neon.some((row) => row.includes('▎')), false, 'the neon style draws no rail');
	assert.equal(float.some((row) => /[╭╮╰╯─│]/.test(row)), false, 'the float style draws no box');
	assert.equal(float.length, neon.length + 2, 'float adds its two padding rows, and nothing else');
});

test('the style decision is read once per render: the slot wins over the document, live', () => {
	const theme = paintTheme();
	const render = () => floatRows(CARD_TONE.INFO, theme, 40, partsAt(theme, { ...SHORT_CARD, tone: CARD_TONE.INFO }));

	writeStyleDocument({ schema: CARD_STYLE_SCHEMA, style: CARD_STYLE.FLOAT });
	assert.equal(cardStyle(), CARD_STYLE.FLOAT, 'the document answers when no host published a slot');
	assert.match(stripAnsi(render()[0]), /▎/, 'the document says float: the rail');

	useStyle(CARD_STYLE.NEON);
	try {
		assert.equal(cardStyle(), CARD_STYLE.NEON);
		const neon = render();
		assert.match(stripAnsi(neon[0]), /^╭─ /, 'the live slot wins over the float document');
		assert.equal(neon.some((row) => row.includes('▎')), false);
	} finally {
		useStyle(undefined);
	}
});

test('a malformed or missing document renders float, and a theme without the role renders neon', () => {
	const theme = paintTheme();
	const render = () => floatRows(CARD_TONE.INFO, theme, 40, partsAt(theme, { ...SHORT_CARD, tone: CARD_TONE.INFO }));

	writeStyleDocument('{"schema":"gentle-pi.card-style/v1","style":"neon","extra":true}');
	assert.equal(cardStyle(), CARD_STYLE.FLOAT, 'an extra key is not the document: float');
	assert.match(stripAnsi(render()[0]), /▎/);

	writeStyleDocument('not json at all');
	assert.equal(cardStyle(), CARD_STYLE.FLOAT);
	assert.match(stripAnsi(render()[0]), /▎/);

	removeStyleDocument();
	assert.equal(cardStyle(), CARD_STYLE.FLOAT, 'no document at all is float, the default');
	assert.match(stripAnsi(render()[0]), /▎/);

	// A theme that cannot paint the background (no `bg` at all) keeps the neon
	// outline instead of a broken float card.
	const plain = withStyle(CARD_STYLE.FLOAT, () => floatRows(CARD_TONE.INFO, plainTheme, 40, partsAt(plainTheme, { ...SHORT_CARD, tone: CARD_TONE.INFO })));
	assert.match(stripAnsi(plain[0]), /^╭─ /, 'no background role: the neon frame');

	// So does a `bg` that answers without the reset the float card needs to close
	// its paint.
	const hostile = { fg: (_role, value) => value, bg: () => 'not a background' };
	const fallback = withStyle(CARD_STYLE.FLOAT, () => floatRows(CARD_TONE.INFO, hostile, 40, partsAt(hostile, { ...SHORT_CARD, tone: CARD_TONE.INFO })));
	assert.match(stripAnsi(fallback[0]), /^╭─ /);

	const throwing = { fg: (_role, value) => value, bg: () => { throw new Error('no such role'); } };
	const caught = withStyle(CARD_STYLE.FLOAT, () => floatRows(CARD_TONE.INFO, throwing, 40, partsAt(throwing, { ...SHORT_CARD, tone: CARD_TONE.INFO })));
	assert.match(stripAnsi(caught[0]), /^╭─ /, 'a hostile theme never breaks the card');
});

test('too narrow for float, the neon outline answers instead of a broken rail', () => {
	const theme = paintTheme();
	const render = (width) => withStyle(CARD_STYLE.FLOAT, () => floatRows(CARD_TONE.INFO, theme, width, partsAt(theme, { ...SHORT_CARD, tone: CARD_TONE.INFO })));
	assert.match(stripAnsi(render(10)[0]), /▎/, 'ten columns is the narrowest float card');
	const narrow = render(9);
	assert.match(stripAnsi(narrow[0]), /^╭/, 'nine columns is the neon frame');
	assert.equal(narrow.some((row) => row.includes('\x1b')), false, 'and no background is painted there');
	assert.deepEqual(render(0).filter((row) => row !== ''), [], 'no width draws no content');
});

// ---- the card's one click area ----

// The installed Pi build delivers a click only to the component that CLAIMED the
// press (pi-tui tui-alt-screen.js records `mousePressTarget` from the press
// dispatch and retargets the synthesized `click` to it), so a card claims the
// cells it wants and nothing else. The whole drawn card is that area, and the
// click calls the card's own callback — the substrate decides no expansion of its
// own, so a card that flips only itself passes a callback that moves only itself.
const ROWS = ['abcdef', 'ghijkl'];

function mouseEvent(patch) {
	return { type: 'click', button: 'left', x: 0, y: 0, width: 6, height: 2, screenX: 0, screenY: 0, shift: false, alt: false, ctrl: false, ...patch };
}

function countingToggle() {
	const toggle = () => {
		toggle.calls += 1;
	};
	toggle.calls = 0;
	return toggle;
}

test('a left press claims the card so the click that follows can toggle it', () => {
	const toggle = countingToggle();
	assert.deepEqual(cardMouseEvent(mouseEvent({ type: 'press', x: 3, y: 0 }), ROWS, toggle), { handled: true, render: false }, 'the press claims the gesture without repainting the row it measured');
	assert.equal(toggle.calls, 0, 'a press alone never toggles');
	assert.deepEqual(cardMouseEvent(mouseEvent({ type: 'click', x: 3, y: 0 }), ROWS, toggle), { handled: true }, 'the retargeted click is handled');
	assert.equal(toggle.calls, 1, 'the click on the heading toggles once');
});

test('every cell of the drawn card is the click area, not only the hint', () => {
	const toggle = countingToggle();
	for (let y = 0; y < ROWS.length; y += 1) {
		for (const x of [0, 3, 5]) {
			assert.deepEqual(cardMouseEvent(mouseEvent({ x, y }), ROWS, toggle), { handled: true }, `cell ${x},${y} is on the card`);
		}
	}
	assert.equal(toggle.calls, ROWS.length * 3, 'each click toggled exactly once');
});

test('nothing outside the card and no other gesture is claimed', () => {
	const toggle = countingToggle();
	assert.equal(cardMouseEvent(mouseEvent({ y: ROWS.length }), ROWS, toggle), undefined, 'a row below the card belongs to the host');
	assert.equal(cardMouseEvent(mouseEvent({ y: -1 }), ROWS, toggle), undefined, 'a row above the card belongs to the host');
	assert.equal(cardMouseEvent(mouseEvent({ x: 6 }), ROWS, toggle), undefined, 'a column right of the card belongs to the host');
	assert.equal(cardMouseEvent(mouseEvent({ x: -1 }), ROWS, toggle), undefined, 'a column left of the card belongs to the host');
	assert.equal(cardMouseEvent(mouseEvent({ button: 'right' }), ROWS, toggle), undefined, 'the right button is the host\'s paste');
	assert.equal(cardMouseEvent(mouseEvent({ button: 'middle' }), ROWS, toggle), undefined);
	for (const type of ['move', 'drag', 'release', 'wheel']) {
		assert.equal(cardMouseEvent(mouseEvent({ type }), ROWS, toggle), undefined, `a ${type} is not a click`);
		assert.equal(cardMouseEvent(mouseEvent({ type: 'press' }), ROWS, toggle).handled, true, `a press is still claimed before a ${type}`);
	}
	assert.equal(cardMouseEvent(mouseEvent({ x: 'one' }), ROWS, toggle), undefined, 'a cell that is not a number is not a hit');
	assert.equal(cardMouseEvent(undefined, ROWS, toggle), undefined, 'no event, nothing to claim');
	assert.equal(cardMouseEvent(mouseEvent({}), [], toggle), undefined, 'nothing drawn, nothing claimed');
	assert.equal(cardMouseEvent(mouseEvent({ width: 0 }), ROWS, toggle), undefined, 'a zero-width card has no cell');
	assert.equal(toggle.calls, 0, 'none of the above toggled anything');
});

test('a hostile toggle never breaks the card or the transcript', () => {
	const boom = () => {
		throw new Error('host callback failed');
	};
	assert.deepEqual(cardMouseEvent(mouseEvent({}), ROWS, boom), { handled: true }, 'the click stays handled even when the toggle throws');
});

test('the card source writes no colour and no raw escape literal', () => {
	for (const file of ['shell-card.js', 'worktree-cards.js', 'card-style.js']) {
		const source = readFileSync(join(__dirname, '..', 'lib', file), 'utf8');
		assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, `${file} names no hex colour`);
		assert.doesNotMatch(source, /\b(?:rgb|rgba|hsl|hsla)\(/, `${file} composes no colour function`);
		assert.equal(source.includes('\x1b'), false, `${file} holds no raw escape character`);
		assert.doesNotMatch(source, /\\x1b|\\u001b/, `${file} holds no escape sequence literal`);
	}
});

test('the tone to background table has exactly one owner in lib/', () => {
	// S5/S6: the visible cards (/warp included) name a tone and nothing else. The
	// role a tone paints behind a float card is decided in `shell-card.js`, once, so
	// no card can drift into its own palette.
	//
	// `file-card.js` is the one exception, and for a different job: it names the HOST's
	// own three box roles (`toolPendingBg`, `toolErrorBg`, `toolSuccessBg`) only to
	// reproduce the box the host itself draws around a row this card hands back (a
	// `registerToolRenderer` resolver runs per tool name, so its `renderShell: 'self'`
	// would otherwise strip the host's box from every forwarded read/write row). Every
	// tone role `file-card.js` DRAWS still comes from here.
	const lib = join(__dirname, '..', 'lib');
	const source = (file) => readFileSync(join(lib, file), 'utf8');
	const roles = /tool(?:Success|Pending|Error)Bg/;
	const owners = readdirSync(lib)
		.filter((file) => file.endsWith('.js'))
		.filter((file) => roles.test(source(file)));
	// A THIRD module naming one of these roles is a second palette.
	assert.deepEqual(owners, ['file-card.js', 'shell-card.js']);

	// The host box names each of the host's roles exactly once IN CODE, inside its own
	// table: a fourth background role, a copy of ours, or a second table would all
	// break it. Prose is not a palette, so comments are stripped first.
	const card = source('file-card.js')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
	const named = [...card.matchAll(/\btool(?:Success|Pending|Error)Bg\b/g)].map((match) => match[0]).sort();
	assert.deepEqual(named, ['toolErrorBg', 'toolPendingBg', 'toolSuccessBg'], 'file-card.js names the host box roles and no other');
	assert.match(
		card,
		/const HOST_BOX = Object\.freeze\(\{[\s\S]*?PENDING: 'toolPendingBg',[\s\S]*?ERROR: 'toolErrorBg',[\s\S]*?SUCCESS: 'toolSuccessBg',?[\s\S]*?\}\);/,
		'the roles belong to the host box table, keyed by the host\'s own states',
	);
	// And no tone is mapped to a background role there: that would be a tone table of
	// its own, which is exactly what this assertion protects.
	assert.doesNotMatch(card, /(?:CARD_TONE\.\w+|['"]?(?:info|success|warning|error)['"]?)\s*:\s*['"]tool\w+Bg['"]/, 'file-card.js owns no tone -> background table');
	assert.doesNotMatch(card, /['"]tool\w+Bg['"]\s*:\s*(?:CARD_TONE|[A-Z_]{2,})/, 'no background role is a key of a table of its own');
});
