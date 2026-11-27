# odd-panel-groups — the ODD panel names its groups, folds them and counts them

Feature branch `feat/odd-panel-groups`, worktree `../odd-worktree-worktrees/odd-panel-groups`.
Owner request: the panel of `/odd` and the ODD sidebar section must fold, indent, count and
re-elect ownership after a pull. Five behaviors, one model.

## Specs

- **S1 — the panel opens folded.** Every group comes collapsed, never expanded. Only the group
  that OWNS the ODD the panel was opened on is expanded; every other group stays collapsed. A
  panel opened with no target expands nothing.
- **S2 — clicking a sidebar ODD opens the panel ON that ODD.** The panel opens with the pointer
  on that document and its owner group expanded, and only that one: "si es de un worktree solo
  ese estaria desplegado".
- **S3 — a child's text aligns with its group's text.** The disclosure marker sits in its own
  column, so a document's name starts where the group's name starts — "actualemte esta alineado
  al icono de despliegue y deberia ser al texto, falta espacio ahi" — the way the `CHANGES`
  panel already draws `▾ feat/identity-command` over `U identity-command.md`.
- **S4 — each group header carries its count.** `main (40 odd)` and `<worktree> (N odd)`, one
  count per group, taken from the documents that group actually lists.
- **S5 — the panel title counts every document shown.** "si muestra 40 de main y 1 de un
  worktree el total de arriba seria 41": the title number is the sum of every group's count, never
  a deduplicated name count and never the main group alone.
- **S6 — main wins after a pull.** When main and a worktree both hold the same ODD name, the
  copy in main is the one that counts — "si el odd de main y el del worktree es igual se queda el
  de main" — including an exact mtime tie. A worktree left with **0** documents draws **no**
  group, and a listing with no worktree group is drawn flat, "sin division". The refresh that
  makes this visible re-runs the group model: the rail on its own floor and session events, the
  panel on `r` and every time it mounts.
- **S7 — the sidebar section header carries the count.** "arriba derecha `1 odd`, en minuscula
  gris": the `ODD` section header shows how many ODDs it is listing, lowercase, in the muted
  role, like `CHANGES` shows `1 file`.

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S6 | inline: verified already pinned by `tools/odd-group.test.js` ("a byte-identical copy is not a difference…", the empty group) + `tools/odd-view.test.js` S13; no code | — |
| T2 | S1, S2 | inline: fold by default, expand only the owner group (`lib/odd-view.js`) | 8855cd1 |
| T3 | S3 | inline: child text aligned to group text (`lib/odd-view.js`) | 8855cd1 |
| T4 | S4, S5 | inline: per-group counts and the summed title (`lib/odd-view.js`) | 8855cd1 |
| T5 | S7 | inline: the `N odd` header meta (`lib/odd-rail-section.js` + wiring) | 16e2311 |
| T6 | S1-S7 | inline: `docs/reference.md` and invariant 31 | 465c52f |

## Log

- **L1** — «otro detalle, lo de odd panel funciona bien, detecta worktrees, pero en este caso
  deberia venir colapsado no desplegado, solo se despliega si tengo focus en un odd, por ejemplo
  presisiono un odd de la sidebar ODD ahi me tiene que abrir panel en ese ODD por lo que en ese
  caso vendria desplegado pero solo el del ODD, si es de un worktree solo ese estaria desplegado.
  Ademas el marge del listado esta mal, deberia ser asi [Image#3], como ves el texto esta
  alineado, actualemte esta alineado al icono  de despliegue y deberia ser al texto, falta
  espacio ahi. Ademas en caso de listado al lado de cada uno deberia salir la cantida de odd,
  como "main (40 odd)". tambien debe detectar update, como por ejemplo el odd esta en un worktree
  pero luego hago pr y merge y hago pull a main trayendo a main ese odd, como dije el odd de main
  gana, si el odd de main y el del worktree es igual se queda el de main, ahi por ejjemplo si el
  worktree tiene 1 odd y tras el pr/merge pull main se va a main, ahora en sidebar saldria que es
  de main [Image#4] y en panel odd ya no saldria worktree pues ahora pertence a main quedando 0
  odd en worktree por lo que ya no se muestra y sin nigun worktree se ve listado normal, sin
  division. Tambien el total de arriba es el total de todos los odd mostratos, si muestra 40 de
  main y 1 de un worktree el total de arriba seria 41»
- **L2** — «y en sidebar ODD falta cantidad commo en changes. [Image#5] ahi hay 1 odd, por lo que
  deberia decir arriba derecha "1 odd", en minuscula gris.»
- **L3 (evidence).** RED against base `main@0dc3bc3`: the new `tools/odd-view.test.js` cases failed 8/8, and `tools/odd-panel-wiring.test.js` went 43/43 green on base and red on the change (11 cases asserted the old expanded default, all rewritten to read a scope from the group HEADERS, which a folded listing still paints). GREEN: `tools/odd-*.test.js` 402/402; full suite 3381 tests, 3380 pass, 0 fail, 1 todo (pre-existing). `standalone` note: the /changes panel is external (gentle-shell); the in-repo reference for the child indent is `lib/files-picker-view.js` (MARKER_WIDTH 3, GROUP_INDENT 2).
- **L4 (decision).** Two checkouts with the same basename became indistinguishable the moment groups fold, so a header whose name repeats among the drawn groups is qualified with its parent directory (`a/same checkout (1 odd)`). Found by `tools/odd-panel-wiring.test.js` F3.
- **L5 (limit).** Nothing polls for an open panel: the pull case (S6) is visible on `r` or on the next mount, and the rail's own floor. No new timer was added.
