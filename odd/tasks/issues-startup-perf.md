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

## Tasks

T1 — S1, S2 · route: worker · commit 1: `perf(issues): take the gh gate off the session path`
T2 — S3 · route: worker · commit 1
T3 — S4 · route: worker · commit 1: `perf(issues): keep and persist the issues cache`
T4 — S5, S8 · route: worker · commit 2: `perf(issues): read only the buckets the rail paints`
T5 — S6, S7 · route: worker · commit 2: `feat(issues): mark a rail PR row with the pull-request icon`
T6 — S8 · route: worker · commit 3: `perf(issues): stop probing git on every tool event`
T7 — S1-S12 · route: worker · commit 4: docs + invariants + suite
T8 — S10, S11 · route: worker · commit 3: `perf(issues): refresh the rail on time and after a mutating bash`
T9 — S10 · route: worker · commit 3: the `bash` command classifier that forces a refresh
T10 — S12 · route: worker · commit 2: `feat(issues): head the rail GITHUB and count it in issues`

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
