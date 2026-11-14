# warp-branch-field — the wizard asks for the branch, and the selector stops listing removed checkouts

## Context

The create wizard derived its branch (`<type>/<slug of the odd>`) from the two
things it asked for. The human rejected the derivation: the branch is his to
choose, so the panel takes it as an input of its own — the same input
`worktree_create` has always had. Two typed fields (`Branch`, `Odd`), two plain
lists (the eleven change types, the ODDs `main` carries).

His second report is a selector row for a checkout he had already removed
(`feat-warp-odd-picker`, `created 49m ago · modified 32m ago`). That one is an
investigation first (T6) and a change only if the row is really offered.

## Specs

- **S1** — "The agent tool takes `branch` as an input; the panel must too. The
  wizard becomes two fields." `Branch` "is the branch, composed as
  `<type>/<name>`: the type is chosen from the same list the panel shows today
  (feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert) and
  the name is typed." `Odd` is "as it is now: first entry `new odd` to type a
  name, then the ODDs that exist in main's `odd/tasks/`, sorted."
- **S2** — "Field order is `Branch` then `Odd`. No `Name` field, no `Odd:` echo
  row."
- **S3** — "Preview: `preview branch:` shows the composed `<type>/<name>`;
  `preview path:` shows `<repo-parent>/<repo-name>-worktrees/<odd>` — the branch
  names no directory."
- **S4** — "The create passes that branch through unchanged: created when
  absent, adopted when it exists. `worktree_create`'s parameters do not change."
- **S5** — The selector must never offer a checkout that no longer exists: "the
  row must be `gone`/absent, never choosable."
- **S6** — "The typed name comes first, above the type list. The field reads
  name on top, the type options below it, not the other way round." And "`feat`
  is selected by default, so an untouched form already previews `feat/<name>`
  and the user only has to type."
- **S7** — "The typed-name input is its own region. Separate it from the list —
  a blank line or a rule — so the caret line does not look like a third entry."
  "Same for the `Branch` field: the typed name and the type list are two
  regions, not one list where a name happens to sit on top." The separation
  "must survive monochrome: spacing or a rule, not colour alone."
- **S8** — "`new odd` and the branch-name input share the same design. Both are
  typed fields, so they render identically: same input style, same caret, same
  row treatment. One input look used in both fields." "The typed text lives in
  that row, not on a separate line under the list." "`new odd` selected → that
  row is the input, with the caret, typed text in place; any document selected →
  no input row below, the list stands alone; document rows stay plain, visually
  distinct from the input row by being plain."
- **S9** — "Theme roles only, no hardcoded colours; the palette comes from
  `lib/tui-paint.js`." "Keep it readable when the accent is unavailable or the
  terminal is monochrome — the distinction must survive on markers/spacing
  alone." No "special colour for `new odd` beyond the shared input design".
- **S10** — The lists stay plain: "The lists beside them — the eleven types in
  `Branch`, the existing ODDs in `Odd` — stay plain rows." And "choosing looks
  like choosing".
- **S11** — "**it must not offer an ODD that already has a worktree.**" "One ODD
  is one worktree, so an ODD whose checkout already exists is not a choice —
  offering it only leads to a refusal. Filter those out of the list, using the
  same source the create uses to refuse: the live worktrees (`git worktree list`)
  plus the registry rows, reconciled, so a stale registry row for a removed
  checkout does not hide an ODD that is free again." Still true after the
  filter: "`new odd` stays first and always available", "an empty result still
  shows `new odd`, never an error", and "a create for an ODD that somehow still
  collides keeps its existing refusal — the filter is an aid, not a replacement
  for that check."
- **S12** — "`worktree_create` called for an ODD that already has a worktree must
  fail with a message that says **that**, not a generic path collision: the ODD
  already has a worktree, it names the path, and it says to use that one instead
  of creating another." "Keep a distinct sentence for this case — the ODD owns a
  checkout and the answer is \"work there\", not \"pick another odd\". Same voice as
  the other refusals: one line naming the fact, one line naming what to do."
  "The message must be reachable from the tool and from the panel create alike,
  since both refuse for the same reason; the tool's version is what an agent
  reads." "Everything else about the refusal stays: it refuses before writing
  anything, no worktree is created, no record is written."
- **S13** — `/warp`'s delete confirmation. "**The top line must read as a
  confirmation.** It currently opens with a question and then a paragraph. Make
  the header say what it is — a confirm-delete — and keep the facts below it."
  And "**Drop the ignored-files sentence.** `Ignored files (deleted with the
  checkout): .atl, .codegraph/codegraph.db.` His objection: they are untracked
  ignored files, so why announce them. Remove that clause and its listing
  entirely; the pending-changes count stays." Known consequence of S13, stated
  rather than decided: the removal deletes those ignored paths permanently and
  git cannot restore them, so after this change nothing warns about them.
  Approved shape (L9): the title is `Confirm delete: worktree '<name>'`; the
  `ignored` reading stays and stays in `warpDeleteEvidenceKey` as a safety net;
  nothing discloses it in the body.

### Rules that must survive

- **R1** — `odd` is required and is the directory name; the branch never names a
  directory.
- **R2** — `Type · Odd` becomes `Branch · Odd`, and the type list keeps its
  eleven entries and its order.
- **R3** — Choosing an existing ODD writes nothing; escape cancels and writes
  nothing.
- **R4** — An absent or unreadable `odd/tasks` on `main` yields `[]` with
  `new odd` still offered, never an error.
- **R5** — Nothing creates or reports an ODD document.

## Tasks

- **T1** — `lib/warp-create-panel.js`: two fields, `Branch` then `Odd`; the
  branch composed as `<type>/<name>` with the name typed; `feat` default;
  completion `{ ok: true, branch, odd }`; the path derived from the ODD alone.
  **Done.**
- **T2** — The shared typed-row design (S8/S9): one helper renders the branch
  name input and the `new odd` input; the lists stay plain; a blank separator
  between the input region and the list region (S7). **Done.**
- **T3** — `extensions/odd-worktree-tools.ts`: `warpCreateAndEnter` passes
  `out.branch` through unchanged instead of deriving it from the type and the
  ODD. **Done.**
- **T4** — `README.md`: the `c` key row and the create prose describe the
  `Branch` field. **Done.**
- **T5** — Tests: the new branch composition, the two regions, the find/replace
  of the old `type` payload, and the preserved rules R1–R5. **Done.**
- **T6** — Investigate the removed-checkout selector row (S5): reproduce
  create → remove → open the selector; fix it if a removed checkout is still
  offered, otherwise report the reproduction and change nothing. **Done, no
  change needed** — a fresh mount offers no row; only a panel left open across
  the removal keeps it until `r`, and the pinning test is in `tools/commands.test.js`.
- **T7** — S11: filter the ODD list against the reconciled live checkouts
  (`occupiedPaths`), in the panel, fed by the extension. **Done.**
- **T8** — S12: the distinct refusal for an ODD that already owns a worktree,
  reachable from the tool and the panel create alike. **Done.**
- **T9** — S13: the delete confirmation's header and the dropped ignored-files
  sentence. **Done** (approved in L9): title is
  `Confirm delete: worktree '<name>'`, `ignoredLine` is gone from the body, the
  reading and its place in `warpDeleteEvidenceKey` stay, and
  `tools/warp-delete-confirm.test.js` — added to the surfaces by that approval —
  carries the new truth in its A2 describe and its three title assertions.

## Log

### L1 — the human's report

> Work in `/home/jona/dev/projects/odd-worktree-worktrees/warp-branch-field` (branch `feat/warp-branch-field`, base `main@2add416`). Read `AGENTS.md` first.
>
> Two things to do, both from the human's report. Create `odd/tasks/warp-branch-field.md` first, with `## Specs` quoting his words verbatim, `## Tasks`, and `## Log` whose `L1` is his message.
>
> ## 1. The wizard needs a `Branch` field (his design, not a derivation)
>
> He rejected deriving the branch from the ODD. The agent tool takes `branch` as an input; the panel must too. The wizard becomes two fields:
>
> - **`Branch`** — the branch, composed as `<type>/<name>`: the type is chosen from the same list the panel shows today (feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert) and the name is typed.
> - **`Odd`** — as it is now: first entry `new odd` to type a name, then the ODDs that exist in main's `odd/tasks/`, sorted.
>
> Field order is `Branch` then `Odd`. No `Name` field, no `Odd:` echo row.
>
> Preview: `preview branch:` shows the composed `<type>/<name>`; `preview path:` shows `<repo-parent>/<repo-name>-worktrees/<odd>` — the branch names no directory.
>
> The create passes that branch through unchanged: created when absent, adopted when it exists. `worktree_create`'s parameters do not change.
>
> ## 2. The selector showed a worktree that no longer exists
>
> His screenshot lists `feat-warp-odd-picker` as a row with `created 49m ago · modified 32m ago`, and that worktree was removed before he opened the panel. Investigate rather than guess: does the selector read the registry without reconciling against `git worktree list`, so a removed checkout keeps a row? Reproduce it (create, remove, open the list), and if a removed checkout shows as selectable, fix it — the row must be `gone`/absent, never choosable. If it is already correct and his screenshot came from a stale open panel before `r reload`, say so with the reproduction you ran and change nothing there.

### L2 — the Branch field reads name first, and `feat` is the default

> Two refinements to the `Branch` field.
>
> 1. **The typed name comes first, above the type list.** The field reads name on top, the type options below it, not the other way round.
> 2. **`feat` is selected by default**, so an untouched form already previews `feat/<name>` and the user only has to type.
>
> The composed value stays `<type>/<name>`, and the type list keeps its eleven entries and order.

### L3 — the two kinds must be distinguishable without a legend

> One more, visual — his screenshot shows why: `new odd` looks like just another row next to `warp-odd-picker` and `worktree-tools-v2`, and the typed-name line runs straight into the list.
>
> Make the two kinds distinguishable without a legend:
>
> 1. **`new odd` is not a document row.** Give it a distinct treatment — an accent/warm tone from the theme's role for something actionable rather than existing (not a hardcoded ANSI), or a marker glyph — so it reads as an action while the rows below read as things that exist.
> 2. **The typed-name input is its own region.** Separate it from the list — a blank line or a rule — so the caret line does not look like a third entry.
>
> Same for the `Branch` field: the typed name and the type list are two regions, not one list where a name happens to sit on top.
>
> Theme roles only, no hardcoded colours; the palette comes from `lib/tui-paint.js`. Keep it readable when the accent is unavailable or the terminal is monochrome — the distinction must survive on markers/spacing alone.

### L4 — correction: `new odd` *is* the input row

> Correction, and it simplifies: `new odd` is **not** a differently coloured action row.
>
> Choosing `new odd` *is* typing a name, so it must look **exactly like the name input** — the same row design, the caret in it. One row that is an input, then the document rows as plain list entries. No extra "action" tone, no marker invented for it.
>
> And the typed text lives **in that row**, not on a separate line under the list — which is what his screenshot shows running together and what he does not want.
>
> So the Odd field renders as:
>
> - `new odd` selected → that row is the input, with the caret, typed text in place;
> - any document selected → no input row below, the list stands alone;
> - document rows stay plain, visually distinct from the input row by being plain.
>
> The separation you add is between the input row and the list, and it must survive monochrome: spacing or a rule, not colour alone.

### L5 — one input design for both typed fields

> Correction to what I sent before — the human means something simpler and it is one rule:
>
> **`new odd` and the branch-name input share the same design.** Both are typed fields, so they render identically: same input style, same caret, same row treatment. One input look used in both fields.
>
> The lists beside them — the eleven types in `Branch`, the existing ODDs in `Odd` — stay plain rows.
>
> So: typing looks like typing in both fields; choosing looks like choosing. No special colour for `new odd` beyond the shared input design, and the caret row still sits in place rather than on a line under the list.

### L6 — the picker must not offer an ODD that already has a worktree

> Another rule for the `Odd` picker: **it must not offer an ODD that already has a worktree.**
>
> One ODD is one worktree, so an ODD whose checkout already exists is not a choice — offering it only leads to a refusal. Filter those out of the list, using the same source the create uses to refuse: the live worktrees (`git worktree list`) plus the registry rows, reconciled, so a stale registry row for a removed checkout does not hide an ODD that is free again.
>
> Still true after the filter:
> - `new odd` stays first and always available;
> - an empty result still shows `new odd`, never an error;
> - a create for an ODD that somehow still collides keeps its existing refusal — the filter is an aid, not a replacement for that check.

### L7 — the agent tool needs its own refusal, saying the ODD has a worktree

> And the agent tool has to cover it too, with its own refusal.
>
> `worktree_create` called for an ODD that already has a worktree must fail with a message that says **that**, not a generic path collision: the ODD already has a worktree, it names the path, and it says to use that one instead of creating another.
>
> Today the collision reads `worktree path already exists: <path>` / `Remove it or pass a different odd.` Keep a distinct sentence for this case — the ODD owns a checkout and the answer is "work there", not "pick another odd". Same voice as the other refusals: one line naming the fact, one line naming what to do.
>
> The message must be reachable from the tool and from the panel create alike, since both refuse for the same reason; the tool's version is what an agent reads. Everything else about the refusal stays: it refuses before writing anything, no worktree is created, no record is written.
>
> Add it to the feature document as its own `S#` with his sentence quoted verbatim, and prove it with a test that pastes the exact lines.

### L8 — the delete confirmation's header, and the ignored-files sentence

> A third item, same panel, same ODD. `/warp`'s delete confirmation, from his screenshot.
>
> 1. **The top line must read as a confirmation.** It currently opens with a question and then a paragraph. Make the header say what it is — a confirm-delete — and keep the facts below it.
> 2. **Drop the ignored-files sentence.** `Ignored files (deleted with the checkout): .atl, .codegraph/codegraph.db.` His objection: they are untracked ignored files, so why announce them. Remove that clause and its listing entirely; the pending-changes count stays.
>
> One consequence you must state in the report rather than decide yourself: the removal does delete those paths permanently — git cannot restore them. So note, without acting on it, that after this change nothing warns about them.
>
> Add both to `odd/tasks/warp-branch-field.md` as its own `S#` with his words quoted verbatim, and prove the change by pasting the confirmation as it renders now and after.

### L9 — S13 approved, with the exact shape

> Option 1, approved, exactly as you proposed.
>
> - `tools/warp-delete-confirm.test.js` is added to the allowed edit surfaces. Its A2 describe and the three title assertions are updated to the new truth; nothing else in that file is touched, and no assertion is loosened into a weaker matcher — an assertion whose only point was the ignored-files listing is replaced by one that proves the line is absent, not merely unpinned.
> - Title: `Confirm delete: worktree '<name>'`.
> - The `ignored` field stays read and stays in `warpDeleteEvidenceKey` as a safety net, and is no longer disclosed in the body.
>
> Then run the whole suite and report the counts, the confirmation as it renders after, and the exact lines you replaced in that test file with why each still proves the same thing.
>
> Do not commit or push.
