# rail-cards-fixes

Thirteen fixes across this package's surfaces: the two agent tools' exposure, the worktree
cards, the bash-card preference (which leaves the command surface for `/gentle:customize`),
the CodeGraph cards and their init output, and the issues rail and panel. The specs below
quote the user's own strings; the log holds their requests verbatim.

## Specs

**S1 — Both agent tools are `direct`.** `worktree_create` and `worktree_list` are declared
with no `exposure` (the host default, `direct`). Neither is `codemode`: the prompt names them
bare (`worktree_create`, `worktree_list`), so a bare call must resolve. No other surface
changes; the tool names, labels, parameters and results are untouched.

**S2 — The worktree cards show three info rows when collapsed, in both content levels.**
A collapsed `worktree_create` call is its heading; a collapsed `worktree_create` result is its
heading plus at most three body rows — the created path, the branch with `(created)`/`(adopted)`,
and the odd. A collapsed `worktree_list` result is its heading plus at most three body rows, the
worktree rows first (the main checkout's branch row included) and the metadata (`project:`,
`path:`) after them. `minimal` does not withhold those rows; `expanded` still shows every row.
User: "aunque este en estilo card content minimal debe ser de 3 lineas de info en collapse, como
en background jobs u otras."

**S3 — The bash-card preference is a customize row, not a command.** `/card:bash` no longer
exists: no command, no name, no message. The preference appears in Gentle Shell's
`/gentle:customize` under `Cards` as `Card tool` with the values `default` and `activity`,
`activity` the default, contributed through gentle-shell-bridge's published API only (no import
of that package, no dependency on it). Selecting a value applies it at once and it survives a
restart. Persistence keeps its one home: `<home>/card-bash.json`, written only by
`lib/card-bash-mode.js`, atomically and owner-only. There is NO legacy document and no migration
path — this package has never shipped another spelling, so a document carrying anything but
exactly `{"schema":"gentle-pi.card-bash/v1","mode":"own"|"default"}` is `malformed_file`, reads
as `activity`, and is never rewritten. Without the bridge the preference has no control surface and
the mode stays `activity`.
User: "card bash elimina comando y registrala dentro de gentle customize con el bridge en
seccions cards como 'Card tool: default | activity' con activity por defecto y arreglas la
persistencia entre sesiones y el fallo."

L6 (user, verbatim, llega después de la implementación):

> no existe plugin, no necesitamos archivo legados, si aun no lo publicamos asi que esta demas
> no dejes nunca algo legacy

Consecuencia aplicada: la tolerancia al documento `{"schema", "bash"}` se elimina del lector, de
sus tests y de las tres piezas de documentación; el archivo malformado que hoy vive en
`~/.pi/gentle-ai/card-bash.json` se borra (su contenido no es una preferencia válida para este
paquete y su ausencia lee `activity`, el default).

**S4 — A `codegraph init` result carries no plugin prose.** After a successful native
`codegraph init` the tool result gains no `pi-odd-worktree:` sentence and no second paragraph:
the tool's own content is the whole result. The one honest exception is a post-init sync that
did not complete (queued, failed, unavailable, read-only): that appends ONE short line naming
it, with no prefix and no second paragraph. The card for that call decides the outcome: collapsed
it draws one row, `→ already initialized` or `→ initialized`, at BOTH content levels (a card of
this package never loses its outcome row to `minimal`); expanded it draws that same row plus at
most the index facts, never the CLI's advisory line (`Use "codegraph index" …`). A failed init
keeps its own error and nothing else. User: "esta demas el plugin basta on decir que codegraph
se sincronize o actualizo/update. o si es posible cambiar todo el output que ve el agente y se
pinta por algo simple de codegraph inicializado y actualizado (pues con el hook siempre hace init
y sync). [Image#7] en collapse y expanded."

**S5 — Every `bash` call that runs `codegraph` is drawn as a CodeGraph card.** Any segment of
the command whose program is `codegraph` (bare, an absolute path, after `npx`/`pnpm exec`/`yarn`/
`bunx`, after `&&`/`;`/`|`, alone or with arguments) is claimed by the CodeGraph card, with the
`codegraph` identity, `operation` = the subcommand and `detail` = its arguments. When the CodeGraph
card cannot exist (no CLI, no CodeGraph tool), `lib/bash-activity.js` names the `codegraph` family
so the bash activity card still heads the row with the `codegraph` mark and word, never the generic
`$ bash`. Evidence only: nothing here executes, guards or intercepts a command.

**S6 — The CodeGraph MCP card names the checkout it explores, briefly.** The MCP explore heading
is `glyph codegraph · explore <query>` and, when the call's `projectPath` names a checkout other than
the session's cwd, it continues ` · <last path segment>` (for
`/home/jona/.pi/agent/git/github.com/Gentleman-Programming/gentle-shell` → ` · gentle-shell`). The
full path never appears. The segment is omitted when `projectPath` is absent, empty, or resolves to
the session cwd. User: "en codegraph mcp tool deberia salir en input el path pero solo si no es el
cwd … que salga solo el nombre de la carpeta/ruta no todo el path."

**S7 — The rail lists mine and assigned together, under a bare count.** The section's rows are the
checkout's open issues the viewer authored or is assigned, merged and deduplicated by number, ordered
by `updatedAt` descending, and still capped at seven rows with the one `and N more issues` row. The
header is the count alone (`8`), never `8 assigned`; a stale snapshot reads `8 · stale`. The user's
own phrase: "en sidebar salga tanto issues mine como assigned mejor, pero no las separe, y que
contador salga solo el n, cantidad no '7 assigned' solo '7', y sin distiguir si en mine o assigned."

**S8 — A row's pull-request marker is its number.** When a row's issue has a linked pull request the
row's right-hand mark is `#<number>` in a gray (muted/dim) role, not the icon glyph; no number, no
mark. The row keeps ONE click target — the whole row opens the issue — because the bridge's
`SectionRow` carries one `onClick` and no per-segment handler. User: "en lugar de aparecer el icono
que tiene pr deberia salir la pr el numero nomas #69, de color gris. … si no se puede dejar la linea
como esta que abre la issue clickear auqnue hay que repararlo claro."

**S9 — A rail click opens the panel on that issue, loaded.** Clicking a row dispatches
`/issues <number>` and the panel opens focused on that issue, its body on screen: no `loading…`
placeholder while the row's already-known facts are shown, and no silent refusal. The first frame
carries what the rail already knows — number, title, state, labels, assignees, author — and the
body follows when its read lands; the pane is never a bare `loading…` with no issue in it. Every
refusal a click can hit is visible to the user (one notice), never swallowed. The click does not
prove the repository a second time: the panel proves its own identity, as the section's own
contract says, so a row retained across a checkout change opens that checkout's same-numbered
issue. A number that is in `assigned` lands on `Assigned`; one that is only in `mine` lands on
`My issues`. User: "issue aparece como clickeable pero no funciona, no hace nada, y deberia
abrirme el panel de issue posicionado en esa issue, con esa issue cargada la descripcion/cuerpo …
que no salga como cargando…"

**S10 — A sub-mode's keys are in the footer, and only there.** The labels, assignees and comment
editors carry no `(space toggle · n new · ctrl+s apply · esc back)` in their title: the title is the
sub-mode's name alone. While a sub-mode is active the footer keybinding line shows that sub-mode's
own keys instead of the normal legend, and returning to the list restores the normal legend. User:
"en issue al entrar a 'labels', 'assign', 'comment', en vez de salir arriba en el titulo en
parentesis las acciones salga abajo en la keybindgs, se reemplazan las que habian por las
dispoibles en ese momento que seria las del (), al salir/volver volverian las normales claro."

**S11 — The footer only offers what works now.** A hint appears only when its action is available
at that moment: the tokens that act on the selected issue (`l labels`, `a assign`, `c comment`,
`x close`, `o web`) need both a selected, loaded issue and — for labels, assignees and close — the
literal `true` capability. With no issue focused (an empty bucket, or none selected) those five are
absent; the movement, bucket, search, `g all issues` and `esc close` hints stay. User: "aca estoy en
involved y no tengo ninguna issue focus, pues no hay ningina, asi que no deberia salir keybindg de
label, comment, assing, web pues solo aparecen con issue focus y si tengo el permiso."

**S12 — A checkout that is not a repository says so, briefly, in gray.** When the session's cwd is
not inside a git repository the section's one line is `not a git repository` in a gray role (dim/
muted), not the error red, and carries no path. User: "si cwd no es repo no lo ponga en rojo, solo en
gris y pon que 'not a git repository … mas breve'."

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1 | inline | `fix(tools): declare both agent tools direct` |
| T2 | S3 | worker | `feat(customize): move the bash card preference into /gentle:customize` |
| T3 | S3 | worker | same as T2 |
| T4 | S2 | worker | `feat(cards): keep three info rows on the worktree cards` |
| T5 | S4 | worker | `feat(cards): draw a codegraph init as its outcome` |
| T6 | S5 | worker | `feat(cards): claim every codegraph bash call` |
| T7 | S6 | worker | `feat(cards): name the explored checkout on the MCP card` |
| T8 | S7 | worker | `fix(issues): merge mine and assigned in the rail` |
| T9 | S8 | worker | `fix(issues): mark a row with its pull-request number` |
| T10 | S9 | worker | `fix(issues): open the panel on the clicked issue` |
| T11 | S12 | worker | `fix(issues): report a missing repository in gray` |
| T12 | S10 | worker | `feat(issues): move a sub-mode's keys to the footer` |
| T13 | S11 | worker | `feat(issues): offer only the keys that work` |
| T14 | S4, S6, S9, S10, S11 | worker | `fix(rail-cards): close the gaps verification found` |

## Log

L1 (user, verbatim):

> aun no implementes pero hay que hacer ciertos ajustes.
>
> primero fallo worktree create por
>
> 2. El segundo intento falló porque invoqué mal la herramienta
>
> Llamé worktree_create como herramienta directa y devolvió Tool worktree_create not found. No está declarada directamente en esta sesión: vive dentro de codemode, así que se llama
> tools.worktree_create(...). Cuando la llamé así, creó el worktree en menos de un segundo. la tool no seria .worktree_create sino que tools.worktree_create. ahi nose si es correcto que este create en codemode y list directo, si deberian estar ambas en codemode o ambas en directo.
>
> eso nose si es una fallo en las reglas odd worktree o algo mas o error puntual del agente.
>
> tambien el diseno de wortree creae y cworktree list, aunque este en estilo card content minimal debe ser de 3 lineas de info en collapse, como en background jobs u otras.
>
> otro error es que card activy diseno no esta funcionando, se implemento mal
>
> issue aparece como clickeable pero no funciona, no hace nada, y deberia abrirme el panel de issue posicionado en esa issue, con esa issue cargada la descripcion/cuerpo tipo [Image#5] que no salga como cargando...
>
> pi-odd-worktree: after that `codegraph init`, one coordinated index sync completed. esta demas el plugin basta on decir que codegraph se sincronize o actualizo/update. o si es posible cambiar todo el output que ve el agente y se pinta por algo simple de codegraph inicializado y actualizado (pues con el hook siempre hace init y sync). en collapse y expanded.
>
> falta las tools bash, debe ser cualquier codegraph de tool bash hasta los no contemplados, es generico que ocupe se pinte igual y salga tipo basg. codegraph - input... . Como el diseno de las cards bash activity pero aqui el activity seria comando codegraph, de hecho hasta podria entrar en bash activity diria que calza mejor ahi y reutiliza diseno de codegraph nativo/mcp.
>
> en codegraph mcp tool deberia salir en input el path pero solo si no es el cwd o sea exploro otro path y seria como 󰆼 codegraph · explore codeGraphCollapsedRows codegraphCallDetail codegraph card · ../gentle-shell.
>
> que salga solo el nombre de la carpeta/ruta no todo el path.
>
> en lugar de aparecer el icono que tiene pr deberia salir la pr el numero nomas #69, de color gris. Y nose si es posible como esa linea que sale issue y pr separalas o sea, en esa misma linea si clickeo la issue abre la issue en panel y si clickeo la pr abre la pr en el navegador, o sea, tener 2 elementos clickeables en la misma linea, si no se puede dejar la linea como esta que abre la issue clickear auqnue hay que repararlo claro.
>
> en issue al entrar a "labels", "assign", "comment", en vez de salir arriba en el titulo en parentesis las acciones salga abajo en la keybindgs, se reemplazan las que habian por las dispoibles en ese momento que seria las del (), al salir/volver volverian las normales claro. Asi no mezclamos posiciones y centramos la keybindings en punto fijo y mostramos solo disponibls en cada momento.
>
> igual que aca, por ejemplo ahi estoy en involved y no tengo ninguna issue focus, pues no hay ningina, asi que no deberia salir keybindg de label, comment, assing, web pues solo aparecen con issue focus y si tengo el permiso (para label y assing ya estaba eso si)
>
> lo otro es que en sidebar salga tanto issues mine como assigned mejor, pero no las separe, y que contador salga solo el n, cantidad no "7 assigned' solo "7", y sin distiguir si en mine o assigned. Si una es ambas, clickear la abre en panel issues en tab assigned, assigned tiene prioridad.
>
> Son varios fix/feat primero entiende y planificalo, aun no implemenetes

L2 (user, verbatim):

> A me parece. B card bash elimina comando y registrala dentro de gentle customize con el bridge en seccions cards como "Card tool: default | activity" con activity por defecto y arreglas la persistencia entre sesiones y el fallo.
> C me parece bien.
>
> otro detalle es que si cwd no es repo no lo ponga en rojo, solo en gris y pon que "not a git repository
> mas breve

L3 (user, verbatim):

> bien, comienza a implementar todo el plan

L4 (decisiones tomadas al planificar, evidencia en el repo):
- `worktree_create` declaraba `exposure: "codemode"` (`extensions/odd-worktree-tools.ts:923`) y
  `worktree_list` no declaraba ninguna, o sea `direct`: la asimetría es la causa del "Tool not found".
- El card de worktree vacía el cuerpo en `minimal` (`lib/worktree-cards.js:255`), mientras el card de
  bash nunca lee el nivel y siempre dibuja tres filas.
- `~/.pi/gentle-ai/card-bash.json` contiene `{"schema":"gentle-pi.card-bash/v1","bash":"activity"}`:
  ninguna de las dos bases de código produce esa forma, y el writer tiene prohibido pisar un documento
  que no puede parsear, así que el toggle no puede guardar.
- El click del rail sí llega a `dispatchIssuesPanel`, pero hace una prueba asíncrona de identidad y
  tiene cinco salidas tempranas silenciosas (`lib/issues-section.js:285-287`), contra el contrato que
  el propio módulo declara ("the panel proves its own repository").
- El bridge (v0.3.2) no tiene API de settings, pero `registerRows` alcanza para un `Card tool` con dos
  valores; el host fuerza `applyOnMove: false` y el plugin conserva la persistencia.
- El número de PR no viene en la respuesta: la query pide `source { __typename }` y nada más.
- Una fila del bridge tiene un solo `onClick`: dos objetivos clickeables en una línea no existen hoy.

L5 (verificación independiente de las cinco slices, hallazgos que se corrigen en T14):
- `package.json` todavía anunciaba `/card:bash` en su descripción: un comando eliminado no puede quedar
  en el texto que se publica.
- S4: el resultado de un init exitoso seguido de un sync que NO completó seguía ganando prosa del
  plugin, y el nivel `minimal` escondía la fila de resultado del init. La excepción quedó escrita en
  la spec y la fila se dibuja en los dos niveles.
- S6: la comparación del `projectPath` normalizaba separadores pero no `.`/`..`, así que
  `/work/repo/../repo` contra el cwd `/work/repo` mostraba un checkout que no era otro.
- S10: los sub-modos anidados (crear una label, descartar un comentario) seguían con su lista de
  teclas entre paréntesis en el cuerpo, contra la regla "las acciones van al footer".
- S11: con el editor de labels/assignees todavía cargando, el footer ofrecía toggle/apply que los
  handlers no aceptan: ahí solo funciona `esc back`.
- Límites aceptados, no defectos: con la preferencia en `default` y un host stock cuyo row de bash no
  se enmarca a sí mismo, la fila `codegraph …` la dibuja el host (nuestra tarjeta se aparta antes de
  reclamarla); el `meta` de una fila es gris (`muted`) en reposo y `warning` bajo el hover, porque el
  rol lo decide el bridge; y una fila retenida tras un cambio de checkout abre la issue del mismo
  número del checkout nuevo, que es la consecuencia directa de S9.