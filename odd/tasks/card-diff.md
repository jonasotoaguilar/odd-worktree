# card-diff — an IDE card for `write` and `edit`, scoped by path

The human wants the `write` and `edit` cards drawn like an IDE, in the active theme's
own colours, reusing the highlighter this package already feeds `/files`; the choice
lives in `/gentle:customize` → `Cards` as a `Card diff` line whose `default` is the
host's own card and whose `color` value is ours. The bridge refused that registration at
first (`assertToolsAreFree`), because coverage was per tool name — gentle-shell-bridge
0.9.0 fixed it with a per-`(line, tool)` scope, which is what this feature consumes.

## Specs

- **S1** — «me gustaria agregar a la herramienta write y edit diseno tipo ide segun el
  tema, pi tiene algo para eso lo usamos para la preview de files creo, seria la mismo,
  revisalo.» Therefore: the `write` and `edit` cards are drawn as an IDE pane — a
  syntax-highlighted body in the ACTIVE THEME's own roles — through the host's own
  highlighter, `agent.highlightCode(code, language)` and
  `agent.getLanguageFromPath(path)`, the two seams `extensions/odd-worktree-tools.ts`
  already wraps for `/files` (`filesAgentSeam`). No hex value, no palette and no raw
  escape sequence of ours: every colour is a theme role.

- **S2** — «Igual agregalo a gentle customize en cards diseno el diseno "Card diff":
  color, seria default (se agrega siempre) y color el nuestro». Therefore ONE new
  registration on the line `diff`, so `/gentle:customize` → `Cards` shows the row
  `Card diff`; the bridge lists `default` first for every line (the host's own card,
  stored `native`), and our value is labelled `color`. `color` is selected once on the
  first run that finds no choice — the same first-run seed `activity` does — and a later
  choice of `default` is never undone.

- **S3** — «pero la de card tools para edit y write en solo para ruta especificas, aun
  asi lo limita el bridge?» The answer is yes, and the fix is the bridge's scope, never a
  path test of ours standing in for coverage: the grouped `tools` line keeps `write` and
  gains `edit`, both with a SCOPE of `paths under skills/ or odd/`
  (`fileCardIdentity(call.args?.path) !== undefined`), so a skill or ODD artifact keeps
  the file card it has today — and `edit` reaches that surface for the first time. The
  new `diff` line is UNscoped, so it paints every other `write` and `edit`.

- **S4** — the gate MUST carry the call's args: `lib/file-card-resolver.js` asks the
  bridge on every paint, and a scope is only answered when the args travel with the
  question (`api.resolveToolDesignSelection(tool, args)`). Without that, the file card and
  the new design paint the same call twice. The args are already in hand where the gate is
  called (`lib/file-card.js` holds `ctx.args`).

- **S5** — `apply()` returns `string[]` (never `readonly`), and reads only STABLE argument
  fields (`args.path`), never a body Pi rewrites while the call streams: the args object
  arrives by reference and is re-read on every pass.

- **S6** — a RELEASE COMPARISON, one rule everywhere: an advertised release meets a cutoff by
  semver ordering — numeric components first, and a prerelease or build suffix only loses when the
  numbers are EQUAL. So `0.9.0-rc.1` and `0.9.0+build` do NOT meet `0.9.0` (unscoped `Card tags`,
  no `Card diff`), while `0.9.1-rc.1` and `0.10.0+local.2` DO, because they are newer than the
  release that introduced the feature. The same rule at the `0.6.0` cutoff means `0.6.0-rc.1` no
  longer receives the grouped line and falls back to the single `tool: "bash"` design, where the
  base commit accepted the grouped shape: a behaviour change, deliberate and more conservative,
  and it must be stated rather than discovered. (This replaces the earlier wording, which read as
  "any suffix fails any cutoff" and would wrongly deny `0.9.1-rc.1` a feature it has.)

- **S6b** — every bridge member stays OPTIONAL and defensive, as today. A bridge older than
  0.9.0 accepts no `scopes` and refuses a scoped registration WHOLE, so on that bridge the
  grouped line registers WITHOUT scopes (the file card keeps its pre-0.9.0 behaviour) and
  the `diff` line is not registered at all — an unregistered row is better than losing the
  `activity` design to a refusal.

- **S7** — `default` on `Card diff` gives the host's own card back for every `write` and
  `edit`, and an absent, `native`, `missing` or `not-covered` answer keeps today's drawing.
  Nothing about the `activity` line's own behaviour changes.

- **S8b** — applying the design to a row it already painted must answer that row BYTE-IDENTICAL,
  with real SGR and not markup: `docs/reference.md` says so and the module's own comment does, so
  a second application may not add an escape or a reset. A test using fake role tags cannot prove
  this, because the parser skips real SGR escapes and sees markup tags as text.

- **S8** — tests: the scoped claim reaches the file card on a skill or ODD path and only
  there; the gate passes the args through; the diff design's rows are theme roles and the
  injected highlighter's own lines; a bridge without `scopes` keeps today's registration;
  and every existing card test still passes.

- **S9** — docs: the README surface table (a `Card diff` row) and `docs/reference.md` (a
  section beside "the cards the `activity` design paints"), plus
  `docs/codebase/invariants.md` if a new invariant enters.

- **S10** — «Y la que era "Card tools" cambiale el nombre a "Card tags"». The row name is the
  bridge's, derived from the LINE KEY, so this is a rename of the line from `tools` to `tags`.
  It must NOT cost a user the choice they already made: the bridge keeps the line's value at
  `selections.$lines[lineKey]`, its own `migrateLegacySelection` treats an absent key as "inherit
  the seeded per-tool `bash` value", and there is no rename or alias path anywhere in its API. So
  before registering, the package carries `$lines.tools` over to `$lines.tags` itself — copy,
  then delete, and only when `tags` is absent — so the bridge finds the key taken, its migration
  stays a no-op, and a user who chose `default` stays on `default`. A store of another shape, an
  unreadable document or a refusing `createStore` is no migration at all: nothing is thrown and
  the line still registers.

- **S11** — the rename is documented wherever the row is named (`README.md`,
  `docs/reference.md`, `docs/codebase/invariants.md`, `docs/codebase/mental-model.md`,
  `docs/codebase/code-map.md`) together with the one-time carry-over, so a reader of the release
  is not surprised that `Card tools` became `Card tags`.

- **S12** — «si te fijas write tiene una linea divisoria entre codigo y numeracion ver si se puede
  poner en edit igual». Therefore an `edit` row carries the same divider the `write` pane draws
  between the line-number gutter and the code, in the same theme role, so the two cards read as one
  design. The row keeps the width the host gave it: the divider is measured as PLAIN text and the
  code is clipped or wrapped to what remains, never overflowing the frame.

- **S13** — «en edit se ve bien los colores pero ver si se puede poner tipo git diff, que la linea
  quitada sea toda roja no solo la numeracion y la agregada toda verde. No esos colores, siguen el
  tema es el color rol que ya usas». Therefore a removed row is painted ENTIRELY in the theme's
  `toolDiffRemoved` role and an added row ENTIRELY in `toolDiffAdded` — marker, number, divider and
  code — not only the marker and the number; context rows keep today's drawing. The colours are the
  theme roles the design already uses, never a hex value. A changed row therefore carries no syntax
  colour of its own: the role's colour is the whole point, as in `git diff`.

- **S14** — the S8b guarantee is unchanged by S12 and S13: applying the design to a row it already
  painted answers that row BYTE-IDENTICAL (real SGR, several passes), so the divider is never added
  twice, and a skill or an ODD path still comes back byte-identical on both halves.

## Tasks

- T1: `lib/bash-design.js`, `lib/file-card-resolver.js`, `lib/file-card.js` — the scoped
  claim for `write` and `edit` on the `tools` line, `edit` added, args through the gate,
  version-gated on bridge 0.9.0. Route: writer. Commit: `feat(cards): scope the file card to skill and ODD paths`.
- T2: `lib/diff-design.js` + wiring in `extensions/odd-worktree-tools.ts` — the `diff`
  line, label `color`, the IDE rows, the one-row preview, the first-run seed. Route:
  writer. Commit: `feat(cards): draw write and edit as a diff card`.
- T3: `README.md`, `docs/reference.md`, `docs/codebase/invariants.md` — the new row and the
  new card. Route: writer. Commit: `docs(cards): document the diff card`.
- T4: verification — the suite green on `/home/jona/dev/projects/odd-worktree-worktrees/card-diff`,
  plus the S8 cases and a differential check that `read`'s card did not change.
- T5: the line rename `tools` -> `tags`, the carry-over of a stored line selection, and every
  doc that names the row. Route: writer. Commit: `feat(cards): rename the Card tools row to Card tags`.
- T6: the five defects the independent verifier raised (S1 stale syntax memo, S5 pane memo keyed
  on length, S6 a prerelease read as the cutoff, S10 an invalid stored id carried over, S11 the
  doc set), plus the misleading extension comment. Route: writer. Commit: folded into the unit it
  belongs to, or its own `fix(cards):` commit.
- T7: the second verification round. The ANSI idempotence defect (S8b), the release rule pinned to
  semver by test (S6), the 0.6.0-rc.1 consequence stated, and the docs that contradict the code
  (S11). Route: writer. Commit: `fix(cards): repaint an edit row byte-identically` plus a docs
  commit.

- T8: the two refinements the human asked for after trying the shipped card: the divider (S12) and
  the whole-row `toolDiffAdded` / `toolDiffRemoved` colouring (S13), keeping S14. Route: writer.
  Commit: `feat(cards): draw an edit like git diff, with the gutter divider`.

## Log

- L1: «me gustaria agregar a la herramienta write y edit diseno tipo ide segun el tema, pi
  tiene algo para eso lo usamos para la preview de files creo, seria la mismo, revisalo.

  Igual agregalo a gentle customize en cards diseno el diseno "Card diff": color, seria
  default (se agrega siempre) y color el nuestro»
- L2: «pero la de card tools para edit y write en solo para ruta especificas, aun asi lo
  limita el bridge?»
- L3: «abri una sesion ahi, explicale lo que queremos hacer y la limitacion del bridge para
  que investigue e implemente una solucion»
- L4: «en gentle-shell-bridge»
- L5: bridge session `75b86d60` shipped gentle-shell-bridge 0.9.0 (npm latest + GitHub
  Release v0.9.0, PR #21 merged): `scopes` per `(line, tool)`, `scope` shorthand,
  `resolveToolDesignSelection(tool, args?)` answering per call, a scoped claim that is
  `native` declines the call, api v1 unchanged. Known limit: a rejected batch still leaves
  an earlier entry's legacy migration written (documented in contract §14, already true on
  0.8.0).
- L7: «Y la que era "Card tools" cambiale el nombre a "Card tags"». Before implementing it,
  the bridge's own answer was read: the row name is `Card ` + the line key (`tool-design-rows.ts`),
  a line has no separate label, and there is no rename/alias path. The stored choice lives at
  `bridge-tool-designs` -> `selections.$lines[lineKey]` (`tool-designs.ts:81-84, 1122-1131`), and
  `migrateLegacySelection` (`:1012-1032`) only runs when the NEW key is absent, copying the legacy
  per-tool `bash` entry — which is the value this package seeds on a first run. A bare rename
  therefore resurrects a stale `activity` over a user's real `default`. Hence S10's carry-over.
- L6: verified locally: `/home/jona/dev/projects/gentle-shell-bridge` is at 0.9.0
  (`cc36e88`) and `~/.pi/agent/npm/node_modules/gentle-shell-bridge` is 0.9.0, so the
  scope path is live, not theoretical.
- L8: audit of every other bridge consumer against the `v0.8.0..v0.9.0` diff, because the human
  asked whether the API change touches the rest of the package ("revisá las otras
  implementaciones que usan bridge, cómo cambió la api"). Result: NOTHING else needs to change.
  The published symbol, schema `v1`, member set, sidebar section, `createStore`/`requestRepaint`
  semantics, store shape and repaint cost are untouched; the card-style and card-content slots are
  gentle-shell's and never the bridge's. The release is additive on `registerToolDesign`
  (`scope`/`scopes`, new types) and on `resolveToolDesignSelection` (optional second argument);
  no breaking change. Its one BEHAVIOURAL change is that resolution is per CALL — a scoped claim
  whose `matches` answers true precedes the unscoped claim — which is what S3/S4 consume, plus a
  scoped line's customize preview gaining a `— scope: …` suffix on the SAME row. A scope that
  throws or answers a non-boolean declines and is recorded in `/bridge-status`; our `matches`
  only calls `fileCardIdentity`, which cannot throw. Nothing the package registers can be refused
  by the new validation, and no member became required. Batched registrations are all-or-nothing
  but may leave an earlier entry's legacy migration written; the package registers one object at a
  time and never a batch, so it cannot be half-applied.
- L9: independent verification (gentle-ai-verify) COULD NOT RUN any test: its isolation helper
  refused this linked worktree ("unsupported repository: ordinary single-root Git directory
  required"), so S7 and S8 have NO execution evidence and are not a pass. Its source review
  raised five defects, all accepted after triage: (a) the highlighted-rows memo omits the active
  syntax theme, so a theme switch repaints stale colours — the one requirement the feature exists
  for; (b) the pane memo is keyed on the LENGTH of \`args.content\` rather than its value, so a
  same-length streaming change reuses the stale pane; (c) a release such as \`0.9.0-rc.1\` parses as
  at-or-above the 0.9.0 cutoff and a test pins that reading; (d) the carry-over copies ANY stored
  value, including one the bridge's own \`storedId\` rejects (\`42\`), writing garbage under the new
  key and deleting the old; (e) three docs still describe the pre-rename world. A sixth finding is
  a comment in the entry point that promises no seam work when \`registerToolDesign\` is absent while
  the code queues the seam first. T6 fixes all six, and the verification has to be re-run on a
  plain single-root checkout — a clone of the branch — before anything is claimed as verified.
- L10: the re-verification ran (a scratch clone, the real 0.9.0 bridge, 2449 tests: 2432 pass, 17
  skipped for the absent \`@earendil-works/pi-tui\`, one of them in tools/file-card.test.js:1116,
  0 fail). Its differential of the shared tools was CLEAN: 16 cases, 32 call and result arrays,
  zero differences for read/bash/grep/find/ls across active and native selection, a recognized and
  an unrecognized command, and ordinary, skill and ODD read paths. Three findings stand: (a) a real
  defect — recolouring an edit row twice duplicates the escapes, so the design is not idempotent
  although it and the reference say it is, and the test missed it because it used markup tags
  instead of SGR; (b) S6 read as "any suffix fails" would deny \`0.9.1-rc.1\` a feature it has, so the
  spec is corrected to semver ordering and the \`0.6.0-rc.1\` consequence is stated as deliberate;
  (c) docs that still contradict the code. One skipped test sits in a file this change touches and
  passes in the worktree, where the peer dependency resolves.
- L11: closing evidence. Commits on `feat/card-diff` (base `4a93f56`): `726778c` scope the file card
  and rename the line to `tags` (T1, T5), `defe2e0` the diff card (T2, T2b, T6), `4940c94` docs
  (T3), `e6104da` repaint an edit row byte-identically (T7, S8b, S6 pins), `591b212` docs corrected
  against the code (T7, S11). Verification: `npm test` 2457/2457 in the worktree, and 2457 with 17
  skips (the absent `@earendil-works/pi-tui` peer, none of them in a file whose behaviour changed
  here) in a fresh single-root clone; the independent verifier's differential for
  read/bash/grep/find/ls was 16 cases / 32 arrays / 0 differences against `4a93f56`; and the seven
  probes that failed in the second round (semver rule at 0.9.0 and 0.6.0, ANSI idempotence over four
  passes, equal-length write panes, invalid and valid carry-over) were re-run by the parent in a
  clean clone and all pass. NOT verified: a live Pi terminal with a real theme. Slice boundary: 2516
  authored changed lines in five commits, well past ~400, so delivery must be a chained PR, not
  one.
- L12: follow-up from the human after trying 3.1.0 in a live Pi session with their own theme (a
  screenshot of a `write` and an `edit` card; the first live rendering this feature had had).
  Verbatim: «funciona perfecto pero 2 detalles, primero si te fijas write tiene una linea
  divisoria entre codigo y numeracion ver si se puede poner en edit igual. Y lo otro, en edit se ve
  bien lo colores pero ver si se puede poner tipo git diff, que la linea quitada sea toda roja no
  solo la numeracion y la agregada toda verde. No esos colores, siguen el tema es el color rol que
  ya usas, es para que me entiendas». What the screenshot shows: the write pane draws
  `N │ code`; the edit card draws `- 5 for (…)` with only the marker and the number in the diff
  role, the code keeping its syntax colours and no divider. This is also the first evidence that
  the card renders as intended in a real terminal, which the 3.1.0 notes had listed as unverified.

