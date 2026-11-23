'use strict';
// S1/S5 (skill-read-full): a skill's or an ODD's Markdown is read WHOLE.
//
// The host's `read` tool takes `offset` and `limit`, and a caller that pages through a
// long file cuts a skill in half — the half that is read then states an incomplete
// procedure, which is worse than not reading it. So this module decides one thing: when
// a `read` call names a Markdown file below a `skills` or an `odd` folder, the call's
// `offset` and `limit` are DROPPED from the input the host executes.
//
// It blocks nothing and answers nothing. The decision is a mutation of the host's own
// `event.input`, the documented seam ("`event.input` is mutable... Mutations to
// `event.input` affect the actual tool execution"), and a call that is not a skill's
// Markdown is left byte-identical.
//
// "A skill's or an ODD's Markdown" is the file card's identity, reused and never copied
// (`lib/skill-odd-card.js`): the FOLDER decides, by path components, so
// `lib/skillset/notes.md` and `docs/oddity.md` are ordinary files. The host still applies its own read
// budget (2000 lines or 50 KB); a skill is far below both, and a file that size is not
// a skill anyone can follow.

const { ODD_FILE_CARD, SKILL_FILE_CARD, fileCardIdentity, isMarkdownFile } = require('./skill-odd-card.js');

const READ_TOOL = 'read';
// The two fields that cut a file. `path` is the only required one, so these are the
// whole difference between a whole read and a partial one.
const PARTIAL_FIELDS = Object.freeze(['offset', 'limit']);

/** The two identities whose Markdown is read whole: a skill's and an ODD's. */
const WHOLE_READ_IDENTITIES = Object.freeze([SKILL_FILE_CARD, ODD_FILE_CARD]);

/** Whether a path names a skill's or an ODD's Markdown: the folder decides, then the `.md` name. */
function isArtifactMarkdown(path) {
  const identity = fileCardIdentity(path);
  return isMarkdownFile(path) && identity !== undefined && WHOLE_READ_IDENTITIES.includes(identity);
}

/**
 * Patch one `read` call before the host runs it: `{ patched, dropped }`, where `dropped`
 * lists the fields this call no longer carries. A call that is not an artifact's Markdown, or
 * that carries neither field, is untouched and reports `patched: false`. Mutates the
 * object it is given, in place, and never throws — a `tool_call` handler that threw would
 * fail the call it was only meant to improve.
 */
function keepArtifactReadWhole(toolName, input) {
  const answer = { patched: false, dropped: [] };
  try {
    if (toolName !== READ_TOOL) return answer;
    if (input === null || typeof input !== 'object') return answer;
    if (!isArtifactMarkdown(input.path)) return answer;
    for (const field of PARTIAL_FIELDS) {
      if (!Object.hasOwn(input, field)) continue;
      delete input[field];
      answer.dropped.push(field);
    }
    answer.patched = answer.dropped.length > 0;
    return answer;
  } catch {
    return answer;
  }
}

module.exports = {
  PARTIAL_FIELDS,
  READ_TOOL,
  WHOLE_READ_IDENTITIES,
  isArtifactMarkdown,
  keepArtifactReadWhole,
};
