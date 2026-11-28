# odd-dedupe — one ODD row per name across main and every worktree

Make the ODD panel and the `ODD` rail section elect ONE copy per ODD name over main + the grouped worktrees, instead of repeating a chained worktree's inherited documents.

## Specs

S1 — An ODD name appears at most once across main and every registered worktree. Quote: «un odd no puede repetirse» and «como dije solo muestra un odd entre main todos los worktree registrado».

S2 — A copy in main and a copy in a worktree with identical content: only main's copy is shown. Quote: «si un odd esta en main y en un worktree registrado, si son identicos se muestra solo el de main».

S3 — A copy in main and a copy in a worktree whose content differs: only the most recently modified copy is shown (normally the worktree's). Quote: «si difieren se muestra el mas reciente (que normalmente es el worktree)».

S4 — No copy in main, copies in several worktrees: when they are identical, the worktree that created the ODD — its origin — wins. Quote: «si no esta en main pero esta en varios worktrees, si es igual en todos los worktree gana el que lo "creo" o aplico el ultimo cambio, o sea, su origen gana». Origin is the grouped checkout whose name equals the ODD name (a worktree created by this package is named after the ODD it serves).

S5 — The reported case is the acceptance example: in a chain (`card-file` created from `feat/card-message`, so it inherits `card-message.md` and `no-bridge-naming.md`), `no-bridge-naming` is listed only under the `no-bridge-naming` worktree, `card-message` only under `card-message`, and the rail attributes each row to that worktree. Quote: «en el caso de la imagen no-bridge-naming debio salir solo en worktre no-bridge-naming y sidebar debio salir que pertence a ese worktree».

S6 — The `/odd` panel draws ONE flat listing: no division by checkout and no collapsible group headers. Every row carries at its right where its elected copy lives — `main` or the worktree's name — exactly as the `ODD` rail does, and the rows are ordered by modification time, the most recently created or modified first. Quote: «mejor camiemoslo lo de panel odd ... asi que saquemos la division.» and «en su lugar sera solo un listado, pero se vera como la sidebar, osea, que a su derecha saldra de donde es, si es de main o un wortree, ademas estara ordenado por modificado, o sea, el mas reciente creado/modificado va primero arriba». The election of S1-S5 still decides WHICH copy each row is and the `a` key still decides which checkouts are candidates; what disappears is the division the panel used to draw.

## Tasks

- T1 — `lib/odd-group.js`: elect one copy per ODD name across main + the grouped worktrees (S1-S4), with content identity and the origin tie-break, plus its suite in `tools/odd-group.test.js`. Route: gentle-ai-worker. Commit: 55c85a4.
- T2 — Docs: `docs/codebase/invariants.md`, `docs/codebase/code-map.md` and any other page stating that main's group is whole and a worktree carries only its delta. Route: docs worker. Commit: this docs slice.
- T3 — The panel's ranked-main merge must not undo the election (S3): `oddGroupsWithRankedMain` replaces main's group with a fresh full listing of main's checkout after `groupOddDocs` answered, so a main copy the election dropped comes back. Keep the elected copies, ordered by the rank. Route: gentle-ai-worker. Commit: 5ba866a.
- T4 — `lib/odd-view.js` (plus `extensions/odd-worktree-tools.ts` where the wiring feeds it): one flat listing of the elected copies, each row showing its checkout at the right, newest first (S6), with its suites `tools/odd-view.test.js` and `tools/odd-panel-wiring.test.js`. Route: gentle-ai-worker. Commit: 5ba866a.
- T5 — Docs for S6: `README.md`, `docs/reference.md`, `docs/codebase/code-map.md`. Route: docs worker. Commit: this docs slice.

## Log

L1 — user request, verbatim:
> [Image#1] [Image#2] encontre un bug como vez [Image#3] armo una cadena de worktrees en base al worktree/rama anterio, por lo que en vista panel odd el ultimo worktree tiene los odd anteriores, pero esta mal, es como lo de main, un odd no puede repetirse, si un odd esta en main y en un worktree registrado, si son identicos se muestra solo el de main, si difieren se muestra el mas reciente (que normalmente es el worktree), y si un odd esta mas de un worktree como se ve en la imagen no pueden salir en los 2, como dije solo muestra un odd entre  main todos los worktree registrado, donde si son iguales gana main, y si no esta en main pero esta en varios worktrees, si es igual en todos los worktree gana el que lo "creo" o aplico el ultimo cambio, o sea, su origen gana. En el caso de la imagen no-bridge-naming debio salir solo en worktre no-bridge-naming y sidebar debio salir que pertence a ese worktree.

L2 — evidence (T1 report): `oddGroupsWithRankedMain` (`extensions/odd-worktree-tools.ts:7016`, used at `:7149` and `:7569`) REPLACES main's `docs` with a fresh full listing of main's checkout, so in the S3 case (a worktree copy newer than main's) main's dropped copy is drawn again. T3 is that fix, same slice. Same report: `tools/odd-panel-wiring.test.js` F3 (`:1555`) and E5 (`:1698`) give two same-basename worktrees a document with the SAME name and assert two rows, which S1 forbids; their fixtures are realigned to distinct ODD names, keeping each test's point (distinct labels, each selection opens its own document).

L3 — user request (S6), verbatim:
> mejor camiemoslo lo de panel odd, dado como se veia en el ejemplo en su mayoria un worktree tiene un puro odd que es el que usa asi que queda mal o es redundante poner listado por worktrees par un solo archivos, asi que saquemos la division.
>
> en su lugar sera solo un listado, pero se vera como la sidebar, osea, que a su derecha saldra de donde es, si es de main o un wortree, ademas estara ordenado por modificado, o sea, el mas reciente creado/modificado va primero arriba

L4 — slice boundary: 316 authored changed lines in `55c85a4` (the election), then 1407 in total up to `5ba866a` (the flat panel, whose bulk is deleted fold/header code and realigned fixtures). Two code slices rather than one, because the election is readable alone; the docs slice that carries this record follows. Full suite after both code slices: tests 3563, pass 3557, fail 0, skipped 5, todo 1.

L5 — independent verification (`gentle-ai-verify`, read-only) and what it changed. Verdicts: S1 pass, S2 pass, S5 pass (live chain: one row per name, each at its own worktree, `duplicates: []`), S3 and S4 failed at one boundary, S6 failed at 80 columns.

- S4 gap, fixed: the candidate gate in `deltaOf` asked Git's delta first, so a document main had DELETED stopped competing even though every worktree still held it, and no row was drawn at all. The gate is now "Git names the path OR main's own listing has no document at that path", which is the `added` case by definition, at no extra git call and no extra byte read.
- S3 reading, pinned rather than changed: a worktree copy that differs from main only because MAIN advanced — the worktree never touched the file — never enters the election, however recent its timestamp. A stale inherited copy with a newer mtime must not win, so "si difieren" is read as "the worktree's own branch changed the document", and the rule plus its test (`S3: a worktree that never touched the document cannot win on mtime`) state it.
- S6 gap, fixed: at 80 columns the checkout cell was dropped, which removed the one thing S6 asks every row to say. The cell is now reserved and the NAME gives way, wrapped while it has room and then cut with the pane's own ellipsis.

L6 — the 15 red tests the earlier worker runs reported are environment leakage, not this change: this Pi session exports `GENTLE_PI_*` (and `GENTLE_PI_CONTROLLED_ENGINEERING`) into the child test processes, and the guard and identity suites read them. With those six variables unset the whole suite is green (`tests 3567, pass 3561, fail 0, skipped 5, todo 1`); the same names fail on a base-code copy under the leaked environment.

L7 — native review, for the record: the full-range candidate (14 files) was stopped by `lens_context_budget_exceeded` (terminal, no authority created), and the panel commit alone came back `consent-declined-this-candidate` through the provider's own consent step (no lineage). The parent offered a retry and the human chose to leave this candidate unreviewed; delivery stays a separate human decision.
