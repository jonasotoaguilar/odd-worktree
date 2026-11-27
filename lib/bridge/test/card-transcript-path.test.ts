/**
 * T1: the path and the grammar, proven against the fixture (S4, S3).
 *
 * No feature code is exercised here — there is none yet (T3 owns the transformer). What is pinned
 * is the two facts the transformer will be written against:
 *
 * 1. **The walk.** From the captured `tui`, the component whose `render(width)` produces the
 *    conversation is reachable through `tui.layoutRoot` → its layout entries → the primary
 *    `ScrollView` → its child, and through the public `tui.children[0]` → the document → its third
 *    child. Both must land on the SAME object as the fixture's card component, and both must fail
 *    cleanly (no throw, no invented object) when the tree is not mounted or not fullscreen.
 * 2. **The grammar.** The fixture's lines are what `float` actually produces: opener/header/body/
 *    closer in that order, bars in column 1, the hint right-aligned in the dim role, and an
 *    empty-body card folded to three rows. `neon` must be visibly different, or detection would
 *    confuse the two.
 *
 * The real host is never imported: `test/fake-transcript.ts` documents where each shape comes from.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BASH_CARD,
  CONVERSATION,
  LAYOUT_NODE,
  NEON_CARD,
  PROSE_LINE,
  READ_CARD,
  createFakeTranscriptTui,
  layoutNodeOf,
  stripAnsi,
  type FakeComponent,
  type FakeDocument,
  type FakeTui,
} from "./fake-transcript.ts";

/**
 * Candidate (a), as `src/card-styles.ts` documents it: `layoutRoot` is TS-`private` on Pi's
 * fullscreen renderer (`pi-tui/dist/tui-alt-screen.d.ts:44`), so the walk reads it through a
 * widened cast. Everything after that hop uses the PUBLIC layout protocol.
 */
function conversationViaLayoutRoot(tui: FakeTui): FakeComponent | undefined {
  const root = (tui as { layoutRoot?: unknown }).layoutRoot;
  const rootNode = layoutNodeOf(root);
  if (rootNode === undefined) return undefined;
  const first = rootNode.entries?.[0]?.component;
  if (first === null || typeof first !== "object") return undefined;
  // A ScrollView is the component that owns a scrollbar and can set it (scroll-view.d.ts:24-40).
  const scroll = first as { scrollbar?: unknown; setScrollbar?: unknown };
  if (typeof scroll.setScrollbar !== "function" || !("scrollbar" in scroll)) return undefined;
  return layoutNodeOf(first)?.component as FakeComponent | undefined;
}

/** Candidate (b): public `children[0]` is the document container, in either renderer mode. */
function documentViaChildren(tui: FakeTui): FakeComponent | undefined {
  const children = (tui as { children?: unknown }).children;
  if (!Array.isArray(children) || children.length === 0) return undefined;
  const document = children[0] as { children?: unknown };
  if (document === null || typeof document !== "object") return undefined;
  if (!Array.isArray(document.children)) return undefined;
  // Candidate (c): the conversation cards are the document's third child (interactive-mode.js:407).
  return document.children[2] as FakeComponent | undefined;
}

test("both documented walks reach the conversation component", () => {
  const tui = createFakeTranscriptTui();

  // The layout walk lands on the document container (the ScrollView's child).
  assert.equal(conversationViaLayoutRoot(tui), tui.document, "layoutRoot → ScrollView → document");
  // From there — and independently through `children[0]` — the card component is the third child.
  assert.equal(documentViaChildren(tui), tui.chat, "children[0] → document → children[2]");
  assert.equal(
    (conversationViaLayoutRoot(tui) as unknown as FakeDocument).children[2],
    documentViaChildren(tui),
    "both walks agree on the object: the exact identity a wrapper must not duplicate",
  );
  assert.equal(tui.chat.render(40).length, CONVERSATION.length, "it renders the fake conversation");
});

test("the transcript renders the document at the content width, not the viewport width", () => {
  const tui = createFakeTranscriptTui();
  assert.ok(tui.transcript !== undefined);

  const lines = tui.transcript.render(40);

  assert.deepEqual(tui.chat.widths, [39], "the scrollbar column is taken out before the cards see it");
  assert.equal(lines.length, CONVERSATION.length + 2, "header and resources rows precede the chat");
  assert.equal(lines[2], `${PROSE_LINE} `, "and the scrollbar column is padded back on");
});

test("regular mode has no layout root, so that walk finds nothing and the other still works", () => {
  const tui = createFakeTranscriptTui({ mode: "regular" });

  assert.equal("layoutRoot" in tui, false, "TuiMainScreen has no layoutRoot field at all");
  assert.equal(conversationViaLayoutRoot(tui), undefined);
  assert.equal(documentViaChildren(tui), tui.chat, "children are mounted in both modes");
});

test("before mounting there is no transcript by any path, and no throw", () => {
  const tui = createFakeTranscriptTui({ mounted: false });

  assert.equal(conversationViaLayoutRoot(tui), undefined);
  assert.equal(documentViaChildren(tui), undefined);
  assert.deepEqual(tui.children, []);
});

test("float cards are padding, header, padding, body rows, padding — in that order", () => {
  const rows = READ_CARD.map(stripAnsi);

  assert.equal(rows.length, 5);
  // Opener and closer are `cardBottom` with no content: the accent bar and spaces.
  const padding = /^ ▎ +$/u;
  assert.match(rows[0] ?? "", padding, "opener: margin, bar, spaces");
  assert.match(rows[2] ?? "", padding, "separator between header and body");
  assert.match(rows[4] ?? "", padding, "closer");
  // Header: bar, one space, glyph + title, then the hint in the dim role.
  // One margin column, bar, one space, glyph + title, fill, one space, hint, then the tail space,
  // the two-column float `topRight` and the trailing margin: four spaces after the hint.
  assert.match(rows[1] ?? "", /^ ▎ ✿ read +ctrl\+o {4}$/u, "title left, hint right-aligned");
  // Body: bar, one space, the text, then the float right rail (a space inside the margin).
  assert.match(rows[3] ?? "", /^ ▎ config\.ts +$/u);
  assert.equal(rows.every((row) => [...row].length <= 40), true, "nothing exceeds the width");
});

test("the hint is the only dim segment on the header row; without one the row ends in spaces", () => {
  assert.match(READ_CARD[1] ?? "", /\u001b\[2mctrl\+o\u001b\[39m/u, "hint painted HINT_ROLE=dim");
  assert.match(READ_CARD[1] ?? "", /\u001b\[95m✿ read\u001b\[39m/u, "title painted the title role");

  const withoutHint = stripAnsi(BASH_CARD[1] ?? "");
  assert.match(withoutHint, /^ ▎ ✿ bash +$/u);
  assert.equal(BASH_CARD[1]?.includes("\u001b[2m"), false, "no dim segment at all");
});

test("an empty body folds the card to three rows: padding, header, padding", () => {
  assert.equal(BASH_CARD.length, 3);
  assert.equal(stripAnsi(BASH_CARD[0] ?? ""), stripAnsi(READ_CARD[0] ?? ""), "opener is identical");
  assert.equal(stripAnsi(BASH_CARD[2] ?? ""), stripAnsi(READ_CARD[4] ?? ""), "closer is identical");
});

test("neon is a different grammar: no margin, no bar, no background", () => {
  const rows = NEON_CARD.map(stripAnsi);

  assert.match(rows[0] ?? "", /^╭─ ✿ read ─+ ctrl\+o ╮$/u);
  assert.match(rows[1] ?? "", /^│ config\.ts +│$/u);
  assert.match(rows[2] ?? "", /^╰─+╯$/u);

  for (const row of NEON_CARD) {
    assert.equal(row.includes("▎"), false, "no float accent bar in an outlined card");
    assert.equal(row.includes("\u001b[48;5;236m"), false, "and no tone background");
  }
  for (const row of [...READ_CARD, ...BASH_CARD]) {
    assert.equal(row.startsWith(" "), true, "every float row starts with the one-column margin");
    assert.equal(stripAnsi(row).includes("╭"), false, "and none of them carries outline chrome");
  }
});

test("the conversation interleaves card rows with rows a repaint must leave alone", () => {
  const lines = CONVERSATION.map(stripAnsi);
  const index = lines.indexOf(PROSE_LINE);

  assert.ok(index >= 0);
  assert.equal(lines[index]?.startsWith(" ▎"), false, "prose is not card chrome");
  assert.ok(lines.includes(""), "blank rows separate the cards");
  assert.equal(lines.filter((line) => line.startsWith(" ▎ ✿ ")).length, 3, "three card headers");
});

test("the layout protocol is what makes the walk independent of concrete classes", () => {
  const tui = createFakeTranscriptTui();
  const node = layoutNodeOf(tui.layoutRoot);

  assert.equal(node?.type, "vstack");
  assert.equal(node?.entries?.length, 2, "transcript first, dock second (chat-viewport.js:22-25)");
  const transcript = node?.entries?.[0]?.component as Record<symbol, unknown>;
  assert.equal(typeof transcript[LAYOUT_NODE], "function");
  assert.equal(layoutNodeOf(transcript)?.type, "scroll");
  assert.equal(layoutNodeOf(transcript)?.component, tui.document);
});
