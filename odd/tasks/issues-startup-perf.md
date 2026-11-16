# Issues startup performance

Make the package stop paying GitHub latency on the session path: no `gh` child, no network and no blocking probe while Pi opens a session or switches to another one, and a rail/panel that paints from cache first.

Branch: `feat/issues-startup-perf`. Checkout: `<repo-parent>/odd-worktree-worktrees/issues-startup-perf`.

## Specs

S1. The complaint, verbatim: "el plugin provoca que se demore mucho mas en cargan el agente pi y los cambios de sesiones". Measured cause: `session_start` awaits `checkIssuesGate` → `ghStatus` → `gh api user` (485 ms) then `gh repo view --json nameWithOwner` (550 ms) serially, on every session start and every session switch, even with the rail hidden and `/issues` never opened. `session_start` must resolve without awaiting any child process or network call.

S2. Verbatim: "diria que fuera asincronico, que no espere para cargar, que por defecto venga con texto loading... o al asi y ya cuando este cargado lo repinta completo". The rail paints its loading state synchronously and the read never sits on the session path.

S3. Verbatim: "Si no es repo git ponia eso y lo desactiva, si no es repo ya no necesita comprobaciones frecuentes." Outside a git repository the section states it in one dim row and takes no `gh` child, no network call and no refresh; a non-repository cwd is not an error tone.

S4. Verbatim: "Igual la cache que maneja habria que revisarla si es la correcta, y cuando se usa, lo principal y activa era cuando esta sidebar Issues activas, para que al hacer click cargara panel /issues al instante". The read cache survives a session switch and a process restart, so the sidebar's first read is a delta and a rail click opens `/issues` already populated.

S5. Verbatim: "igualmente necesita todas para mostrar en sidebar el total y al hacer click venga cargadas el total y listado bien completo de las my issues, assigned y involved". The rail header keeps reporting the true total from the read's own `issueCount`, and the panel still lists `mine`, `assigned` and `involved` complete.

S6. Verbatim: "actualmente si tiene PR asociada, 1 o mucha muestra la ultima asociada (esto solo se revisaria para las 7 que muestra claramente, no es necesario para todas)". The pull-request mark stays as it is today: only for the rows the rail paints, from the timeline already carried by the same query, and it keeps showing the last associated PR.

S7. Verbatim: "quizas para que se entienda y sepa que sea pr ponerle a su izquiera un icono u texto PR  nf-dev-git_pull_request \ue726, usa ese, \" #PR\" que se vea asi icono espacio y pr numero." The rail's PR mark is rendered as U+E726, one space, then `#` and the number: `\ue726 #69`.

S8. Verbatim: "o si tiene ideas para mejorar issues panel y su sidebar igual son bienvenidas". The measured per-event tax also goes: the naming observer must not spawn git for every tool event that cannot name anything.

S9. Verbatim: "bien, arranca con las mejoras".

S10. Verbatim: "cada tool vuelve a revisar si se actualizo la issues? eso no tiene sentido diria, deberia ser algo que compruebe cada cierto tiempo nomas, como cada 10seg o 20seg, nose, algo optimo. Y que de tool solo revise tools bash, si uso algun comando git bash de creacion/update de alguna issue o pr, luego de terminar la tool ahi si podria forzar un refrezco porque sabemos que algo cambios." The rail re-reads on time, not on activity: while it is drawn, one self-scheduled read per floor; the session's own activity never adds a read on its own; and a `bash` tool whose command text mutates an issue or a pull request forces one refresh right after its result, behind a short anti-storm cap.

S11. Verbatim: "igual recuerda que la mayoria sirve solo si la sidebar de issues esta activa". Every timed read, every forced refresh and every cache write happens only while the section is drawn; a hidden section keeps spawning nothing and keeps no timer.

S12. Verbatim: "Igual cambia en Sidebar que dice \"ISSUES\" por \"GITHUB\" mejor, y en numero derecha le pone \"7 issues\" por ejemplos le agregas ahi la palabra issues". The rail heading reads `GITHUB`, and the right-hand count reads `7 issues` (and `7 issues · stale` while stale), keeping the count the number the last read produced.

S13. Verbatim: "el que el panel issues y sidebar requieren claramente gh cli, si no la tiene el so nunca activa sus funciones", corrected and confirmed: "te dijke que sin gh no cargan o sea nunca se carga el comando /issues ni nunca se agrega a sidebar github sidebar, pues no serian funcionales". Without the `gh` CLI the two issues surfaces are NOT REGISTERED at all: `/issues` never loads and the `GITHUB` rail section is never added to the rail. There is no dim line, no notice and no refusal line for it — nothing appears, because nothing was registered. Every other surface keeps working. This is registration-time, decided by a local PATH lookup with no child process.

S14. Verbatim: "un detlale fix meor en warp que que ver todos seria con \"a\" no con \"v\"". The extended list's key is `a`, and every hint that names it reads `a`.

S15. Verbatim: "El selector normal muestra todos los ODD worktree de la lista, es una lista escroleable asi que deberia salir maximo 5 y si son mas abajo sale algo como flecha hacia abajo n more, y al baja sale arriba flecha para arriba y n more", corrected to: "el listado serian 7 lineas realemnte, muestra hasta 7 worktrres, asi si baja la primera seria los n more" and "claro que los more no son seleccionables logicamente, ahi nose si seria campo de lista o texto fijo posicionado arriba/abajo", and corrected again: "debe mostrar 5 worktrees maximos, con los n more daria 7 filas. Si no hay n more, si fuera 7 exactos, se veria 7". The panel's list block is SEVEN lines in total and the two hidden-count lines are drawn OUT of that same budget: both drawn → five checkout rows plus the two lines; one drawn → six rows plus one line; neither needed → seven checkout rows, or every row when there are fewer. Both lines are FIXED TEXT outside the selection space — never rows, never selectable — so the cursor only ever moves among real checkouts.

S16. Verbatim: "ademas de agregar en arriba a la derecha de Warp \"Warp  · n worktrees\", la cantida de worktrees de la lista. Y en all solo aparecia tecla y mostraria la lista de odd worktees mas los fuera de la lista, ahi igual el total a lado de warp cambiaria peus se suman estos ahora". The heading reads `Warp · n worktrees` with the number of checkouts the list holds, and in the extended (`all`) list that total includes the checkouts outside `<repo-name>-worktrees/`.

S17. Verbatim: "el readme falta en instalacion variante para gentle shell que es como con pi pero con \"gentle-shell install ...\". Y falta el pre requisito que debe tener isntalado pi install npm:gentle-shell-bridge con gentle-shell intall ... el mismo." The README documents the Gentle Shell install variant beside the Pi one, and names `gentle-shell-bridge` as the prerequisite with its own install line.

S18. Verbatim: "Igual este plugin deberia comprobar si lo tiene, creo que lo hace, si no lo tiene desactiva todo el plugin, no carga nada." When `gentle-shell-bridge` is not published, the plugin registers NOTHING: no command, no tool, no card, no rail, no hook. It only says how to install it.

S19. Verbatim: "o mejor dejalo y agrega un salto de linea abajo, entre listado y keybindigns, y el detalle del worktree focus lo mueves arriba. de modo que arriba serian 3 lineas" and "y le quitas el texto arriba de \"principal\", quedarian que muestre arriba detalle de rama principal/main y la del worktree focus que va cambiando". The blank row between the detail block and the checkout list STAYS. The word `principal` is gone from the top block: the heading is followed by the principal checkout's own detail line and then the focused checkout's detail line, which changes as the selection moves — three lines above, then the blank row, the list, another blank row, and the keybindings.

S20. Verbatim: "view all worktrees en listado ya no va, dijimos que es solo un atajo con \"a\" y que aparece solo ahora si exiten worktrees fuera de listado del plugin. Y arriba falta la cantida \"Warp  · n worktrees\" con n la cantidad del listado y si entro a all el total seria todos, listado y fuera, seria el comando git supongo para calcularlo nomas". There is NO `view all worktrees` row in the selector: the extended list is reached by the `a` key alone, and the `a` hint is drawn ONLY when checkouts exist outside `<repo-name>-worktrees/`. The heading's count is computed from the same git read the panel already performs: the rows the current list holds, and, in `all`, those rows plus the outside checkouts.

## Tasks

T1 — S1, S2 · route: worker · commit 1: `perf(issues): take the gh gate off the session path`
T2 — S3 · route: worker · commit 1
T3 — S4 · route: worker · commit 1: `perf(issues): keep and persist the issues cache`
T4 — S5, S8 · route: worker · commit 2: `perf(issues): stop paying for the bucket the rail never paints`
T5 — S6, S7 · route: worker · commit 2: `feat(issues): mark a rail PR row with the pull-request icon`
T6 — S8 · route: worker · commit 3: `perf(issues): stop probing git on every tool event`
T7 — S1-S12 · route: worker · commit 4: docs + invariants + suite
T8 — S10, S11 · route: worker · commit 3: `perf(issues): refresh the rail on time and after a mutating bash`
T9 — S10 · route: worker · commit 3: the `bash` command classifier that forces a refresh
T10 — S12 · route: worker · commit 2: `feat(issues): head the rail GITHUB and count it in issues`
T11 — S13 · route: worker · commit 4: `feat(issues): register no issues surface without the gh CLI`
T12 — S14, S15, S16, S19, S20 · route: worker · commit 5: `feat(warp): scroll the selector and count its checkouts`
T13 — S17 · route: worker · commit 4: `docs: install the package under Gentle Shell and name the bridge`
T14 — S18 · route: worker · commit 4: `feat: load nothing without gentle-shell-bridge`
T15 — S8 · route: worker · commit 2: `revert: keep the rail's involved page whole`

## Log

L1 (user, verbatim): "el plugin provoca que se demore mucho mas en cargan el agente pi y los cambios de sesiones, investiga el motivo.

teorizo que uno de ellos es por las issues, nose si la sidebar o panel . Investiga como funciona, diria que fuera asincronico, que no espere para cargar, que por defecto venga con texto loading... o al asi y ya cuando este cargado lo repinta completo. Si no es repo git ponia eso y lo desactiva, si no es repo ya no necesita comprobaciones frecuentes. Igual la cache que maneja habria que revisarla si es la correcta, y cuando se usa, lo principal y activa era cuando esta sidebar Issues activas, para que al hacer click cargara panel /issues al instante, igual considera que dado que el panel sidebar issues muestra un maximo de 7, nose si precargar solo esas, igual necesita todas para mostrar en sidebar el total y al hacer click venga cargadas el total y listado bien completo de las my issues, assigned y involved. Igual actualmente si tiene PR asociada, 1 o mucha muestra la ultima asociada (esto solo se revisaria para las 7 que muestra claramente, no es necesario para todas), las demas ya recien en focus en panel issues creo que carga el detalle, entre ellos las pr relacionadas. igual cutalmente si tiene muesta \"#PR\" quizas para que se entienda y sepa que sea pr ponerle a su izquiera un icono u texto PR  nf-dev-git_pull_request \ue726, usa ese, \" #PR\" que se vea asi icono espacio y pr numero.

igual esto es lo que pienzo, pero investiga otras posibles causas, le falta optimizacion al plugin"

L2 (user, verbatim): "o si tiene ideas para mejorar issues panel y su sidebar igual son bienvenidas"

L3 (user, verbatim): "analiza/investiga"

L4 (user, verbatim): "bien, arranca con las mejoras"

L5 (parent, evidence): measured on this machine, this repo — `gh api user` 485 ms, `gh repo view --json nameWithOwner` 550 ms, `gh issue list --limit 1` 764 ms, `git rev-parse --show-toplevel` 1 ms, all 71 `lib/` modules 39 ms, `spawnSync git worktree list` 1.9 ms. The gate alone is ≈1.03 s per session start and per session switch.

L6 (parent, decision): the cache stays PURE. `lib/related-issues-cache.js` keeps "no imports, no child process, no disk" and its existing suite; persistence is a new `lib/issues-cache-store.js` invoked only from the async loader, never from the paint path and never from `session_start`.

L8 (user, verbatim): "cada tool vuelve a revisar si se actualizo la issues? eso no tiene sentido diria, deberia ser algo que compruebe cada cierto tiempo nomas, como cada 10seg o 20seg, nose, algo optimo. Y que de tool solo revise tools bash, si uso algun comando git bash de creacion/update de alguna issue o pr, luego de terminar la tool ahi si podria forzar un refrezco porque sabemos que algo cambios.\n\no es mi idea, nose que tenias planeado, quizas lo mio te sirva para complementar\n\nigual recuerda que la mayoria sirve solo si la sidebar de issues esta activa\n\nIgual cambia en Sidebar que dice \"ISSUES\" por \"GITHUB\" mejor, y en numero derecha le pone \"7 issues\" por ejemplos le agregas ahi la palabra issues"

L7 (parent, decision): `clearIssuesSidebarCache` on `session_shutdown` stops clearing entries. The generation still advances, so an answer from the ended session still lands nowhere, and the snapshot is still dropped so a frame after shutdown never shows the old rows.

L9 (parent, decision): the refresh floor while drawn is 20 s (S10's own range), and a forced refresh after a mutating `bash` is capped to one per 5 s so a script that runs several `gh` writes cannot storm the API. A read is never started while the section is not drawn (S11).

L10 (parent, decision, T4 narrowed): the rail does NOT drop `involved` from the one combined query. The cache's `apply` holds all three buckets to one contract, and a partial answer would have forced a change to `lib/related-issues-cache.js` and its invariants for a payload saving on one round trip. Instead the rail asks `involved` for the DELTA size only (20), so the hundred rows it never paints leave the payload; the panel's own prefetch still reads all three in full, which is what S5 asks for.

L11 (parent, evidence): commit 1 `8cab67b` closes T1-T3 (S1-S4): 1288 insertions, 657 of them tests, 8 files. It is over the ~400-line reviewable slice because the tests and the comments that carry the new contract came with it; the slice boundary is this commit.

L12 (user, verbatim): "otro detalle el que el panel issues y sidebar requieren claramente gh cli, si no la tiene el so nunca activa sus funciones\n\n[imagen: gh no instalado, mensaje de GitHub CLI] y un detlale fix meor en warp que que ver todos seria con \"a\" no con \"v\". Ademas en warp solo salen los de worktree list, si existen fuera de worktree list aparecen solo en all porque lo que lal se habilita cuando la lista es extensa o cuando tiene worktree fuera de la lista. Pues wapr normal tenia un tope de los que mostrba, cantidad.\n\ny otro detalle es el readme falta en instalacion variante para gentle shell que es como con pi pero con \"gentle-shell install ...\". Y falta el pre requisito que debe tener isntalado pi install npm:gentle-shell-bridge con gentle-shell intall ... el mismo. Igual este plugin deberia comprobar si lo tiene, creo que lo hace, si no lo tiene desactiva todo el plugin, no carga nada."

L13 (user, answers to the two decision questions, verbatim): "Desactivar todo el plugin" for the missing-bridge policy; for the warp list: "El selector normal muestra todos los ODD worktree de la lista, es una lista escroleable asi que deberia salir maximo 5 y si son mas abajo sale algo como flecha hacia abajo n more, y al baja sale arriba flecha para arriba y n more, ademas de agregar en arriba a la derecha de Warp \"Warp  · n worktrees\", la cantida de worktrees de la lista. Y en all solo aparecia tecla y mostraria la lista de odd worktees mas los fuera de la lista, ahi igual el total a lado de warp cambiaria peus se suman estos ahora"

L14 (parent, evidence, T15): T4 as delivered damages an invariant I did not weigh: `apply` holds a bucket to `issueCount`, so a FULL rail read that replaces `involved` with 20 rows marks the entry `inconsistent` whenever the real count is 21..100, and `plan` then answers a FULL read forever — the steady state becomes 100+100+20 rows per rail read instead of today's 20+20+20. The payload saving was never worth it (one round trip either way), so T4 is REVERTED: the rail asks the full page again and `involvedFirst` is not kept as dead code.

L15 (user, verbatim): "igual warp tiene como un espacio entre repo main y lista, lo sacaria para que se vea parejo, saca ese espacio/salto de linea"

L16 (parent, evidence): commit 2 `3712249` closes T5 and T10 (S6, S7, S12) — the `GITHUB` heading, `7 issues` / `7 issues · stale`, and the `\ue726 #69` mark — 149 insertions, 125 of them tests. T4 was reverted and left no trace: `lib/gh-issues.js`, `extensions/odd-worktree-tools.ts` and `tools/gh-issues.test.js` are byte-identical to HEAD, `git grep involvedFirst` answers nothing outside this log. Slice boundary: this commit.

L17 (user, verbatim, revises L15): "o mejor dejalo y agrega un salto de linea abajo, entre listado y keybindigns, y el detalle del worktree focus lo mueves arriba. [Image#5] de modo que arriba serian 3 lineas." and then, after the layout question was cancelled with the answer below: "y le quitas el texto arriba de \"principal\", quedarian que muestre arriba detalle de rama principal/main y la del worktree focus que va cambiando". L15 is superseded: the blank row stays.

L18 (user, verbatim, closes the extended list): "view all worktrees en listado ya no va, dijimos que es solo un atajo con \"a\" y que aparece solo ahora si exiten worktrees fuera de listado del plugin.\n\nY arriba falta la cantida  \"Warp  · n worktrees\" con n la cantidad del listado y si entro a all el total seria todos, listado y fuera, seria el comando git supongo para calcularlo nomas". This also answers the open question in L17: with the row gone the selection only ever lands on a real checkout, so the third header line always has a checkout to describe.

L19 (user, verbatim, corrects S15's count): "el listado serian 7 lineas realemnte, muestra hasta 7 worktrres, asi si baja la primera seria los n more\n\n↑ n more\n     feat-issues-startup-perf\n     feat-bash-activity-card\n     temp/pr-marker-check\n     feat-worktree-guards\n     fix-cards-tone-codegraph\n ↓ n more\n\nclaro que los more no son seleccionables logicamente, ahi nose si seria campo de lista o texto fijo posicionado arriba/abajo". Seven checkout rows, and the two hidden-count lines are fixed text, not rows.

L21 (parent, process defect, mine): I ran two writers at once in this one worktree with disjoint edit surfaces (warp view vs. the issues refresh/tax files) but both were told to run `node --test tools/*.test.js`. The suite is shared state, so each worker's full-suite picture included the other's half-written tree — the warp unit reported 7 then 1 failures in `tools/commands.test.js` and `tools/issues-section.test.js` that belong to the other unit's in-flight edits. Disjoint surfaces are not enough: a suite run is a shared resource. From here the parent runs the full suite once, after the last writer settles, and a worker's full-suite total is evidence only when it is the only writer in the worktree.

L22 (parent, evidence): slices 3 and 5 landed with the tree quiet and the parent's own run behind them. `73bf186` closes T8/T9/T6 (S8, S10, S11) after the parent closed one real defect the worker left: the forced-refresh handler read `event.toolName`/`event.input` directly while every other handler goes through `oddToolNameOf`/`oddArgsOf`, so a result spelled `tool`/`args` forced nothing; a RED test pinned it and the handler now uses the shared accessors. `055c2e4` closes T12 (S14-S16, S19, S20). Parent's suite after both: 2102/2102.

L23 (parent, evidence): `c6cde14` closes T11 and T14 (S13, S18) — a local PATH lookup replaces any `gh` child on the gate path, and the whole surface registers only when `gentle-shell-bridge` is published, deferred and once. The suite is 2115/2115 on three consecutive runs the parent made after the last writer settled. Two re-scoping rounds were needed and both were the fixture, not the policy: a default fake bridge in `tools/fixtures/load-extension.js` with an explicit opt-out, plus one line in each of the two own-loader suites (`warp-busy-guard`, `codegraph-card`) that had been invisible to the first grant. The four re-scoped assertions are listed in the worker's report and were reviewed here: two in `files-bridge`, two in `issues-section`, each keeping its subject and replacing only the policy it asserted.

L24 (parent, evidence, slice boundaries for delivery): five commits, 4554 authored changed lines — well past the ~400-line slice. The slices are `8cab67b` (S1-S4), `3712249` (S6, S7, S12), `73bf186` (S8, S10, S11), `055c2e4` (S14-S16, S19, S20) and `c6cde14` (S13, S18), and the docs pass is the last one. They are already reviewable one by one on the branch; publishing them as a chain is the delivery decision and it belongs to the human, not to this log.

L25 (parent, evidence + human decision): `ba96dac` closed T7 (S1-S20) — 52 files against `main`, which looked like 5004 deletions until I checked: `main` advanced 28 commits after this branch's base (`c9d131d`), including the bash/cards refactor that moved behaviour into `lib/bash-frame.js` and deleted `lib/card-files-mode.js` and `lib/cards-customize.js`. Those "deletions" were main's newer work missing here, not work removed. `git rebase main` conflicted on the FIRST commit and would have required resolving the same seven files seven times, so the rebase was aborted and, when asked, the human chose "Integrar main ahora, con verificación completa": one `git merge main`, both behaviours preserved, suite green, merge commit rather than rewritten commits (T16).

L20 (user, verbatim, corrects L19's arithmetic): "no me entediste, debe mostrar 5 worktrees maximos, con los n more daria 7 filas. Si no hay n more, si fuera 7 exactos, se veria 7". The list block is a budget of SEVEN lines shared with the two `n more` lines: 5 checkouts + 2 lines, or 6 + 1, or a full 7 checkouts when nothing is hidden — and with 7 checkouts or fewer, every row shows and no `n more` line exists at all (no padding, no `0 more`).

L26 (user, verbatim, new requirement): "igual en panel issues, tiene la funcion de assigned, poder asignar o desasignar, ahi se da el caso que me la asigne a mi o me quite la asignacion, por la cache o no estoy seguro no se represca altiro los tabs, porque ah ideberia reconoceer el cambio para actualizar rapido si me la asigno seria una mas en assigned y si me saco asignacion una menos y sacarla, actualmente eso demora o no refrezca de hecho hasta que lo cierro y abro panel". Today a self-assignment becomes visible only by closing and reopening the panel: the bucket that gained or lost the row is answered from the page state the panel already holds, and nothing invalidates it when the write lands.

L27 (parent, decision, S13 correction): the human corrected my reading twice and the second one is the contract — "te dijke que sin gh no cargan o sea nunca se carga el comando /issues ni nunca se agrega a sidebar github sidebar, pues no serian funcionales". S13 as first implemented (registered, refuses with one line, dim rail line, session notice) was wrong: without `gh` the command is never registered and the section is never added. The runtime read guards stay as defence in depth only.
