# /files — the file picker panel, ported from the gentle-shell branch

Branch: feat/files-picker · Delivery: single PR, no push · Tests: `node --test tools/*.test.js`

Reference (read-only): `/home/jona/dev/projects/gentle-shell-worktrees/file-picker` — branch
`feat/file-picker`, its own spec document `odd/tasks/file-picker.md`, and the sources
`lib/file-index.ts`, `lib/file-picker-view.ts`, `lib/file-scope-view.ts`,
`lib/file-scope-detail.ts`, `lib/file-picker-insert.ts` plus the `/gentle:files` wiring in
`extensions/gentle-shell.ts`. That branch was not accepted upstream, so the feature is
re-implemented here in plain JS on this package's own substrate: `lib/shell-card.js` (frame,
tones, `cardMouseEvent`), `lib/tui-paint.js` (roles, `legendRow`), `lib/view-layout.js`
(pane maths, `measure`, window helpers), `lib/open-external.js` (the editor), and
`lib/worktree-git.js` (`runArgvAsync`) for every Git read. Nothing is copied verbatim without
replacing those seams.

## Specs

- S1: **Panel chrome.** A `/files` overlay panel centered by the host, drawn as this package's
  card: rounded frame, `Files` at the top-left, the `esc` hint at the top-right, and the path
  being listed at the top-right next to that hint with its own elision at narrow widths.
- S2: **Two panes.** A file list on the left and a file preview on the right, separated by a
  vertical rule, the list showing repository-relative paths. «arriba titulo a la izquierda el
  listado de archivos y derecha preview, todo clickeable y el preview scrolleable».
- S3: **Search is always active.** A `›` prompt row sits directly under the title and shows the
  query (with a placeholder when empty), followed by a blank row and then the list: the same
  shape as the Commands palette and fzf. «ahi directamente el search esta siempre activo, las
  keybindings serian combinaciones para no chocar con search». Typing filters immediately, there
  is no mode to enter and no "type to search" hint, and a query that matches nothing paints an
  explicit empty-state line. Navigation and scrolling therefore use modifier combinations, so
  plain characters always reach the query.
- S4: **One option per key in every hint line.** The footer names a single binding per action even
  when several work: `esc` (not `esc/ctrl+c`), arrows for move, `ctrl+j/k` for preview scroll (not
  the `ctrl+shift` fallback). Both keys keep working. «no pongas atajos dobles ... esta bien poner
  2 atajos compatibles pero deja en el texto solo una opcion». The footer lists: move, `tab`
  select, `ctrl+j/k` scroll, `ctrl+o` order, `space` fold, `ctrl+u` clear, `ctrl+e` edit,
  `enter` insert, `esc`.
  `home`/`end` (first/last file) and `ctrl+home`/`ctrl+end` (preview first/end) are compatibility
  bindings and are never named in the footer: «No lo pongas en keybinding solo pon compatibilidad».
- S5: **Everything is clickable.** Clicking a list row selects it; the wheel over the list moves the
  selection; the wheel over the preview scrolls the preview; clicking the preview never breaks the
  panel. Painting and hit-testing read one geometry, rebuilt on every render, so a click always
  lands on the row it looks like.
- S6: **Changed files first, with badge and age.** Files changed in the working tree sort above
  unchanged ones, and each paints the change letter this package already uses for changes — `M`
  for a tracked file with an uncommitted change, `U` for an untracked file — with its age at the
  right in `s`/`h`/`d` units. Ages are computed once when the panel opens and never refreshed live.
  «si es un archivo nuevo creado sale N/U, si se actualizo sale M, en ambos casos a su derecha sale
  hace cuanto tiempo, en s/h/d (esto se calcula al abrir, no se recalcula en vivo)».
- S7: **Tab multi-select, Enter inserts all.** `Tab` toggles the highlighted file in a selection
  drawn distinctly from the plain highlight, in place and with a constant marker width so a marked
  row never shifts. `Enter` inserts every selected file plus the highlighted one, never duplicating,
  in list order, space-separated, then closes the panel and leaves focus in the input. It does not
  send the message. «con "tab" como keybinding select como en fzf ... los seleccionados los resalta
  y luego con enter manda todos los seleccionados (incluyendo al que le dio enter, enter lo agrega
  seleccionado y manda el focus ... no se agrega seleccionado uno que ya esta)».
- S8: **Reference form.** A file of the session's own checkout is inserted as `@` plus its path
  relative to the session cwd (`@AGENTS.md`, `@lib/view-layout.js`). A file of another worktree is
  inserted as its full absolute path, because `@` resolves against the current path and would point
  at the wrong file: «si manda el de un worktree es diferente, ahi el "@" no sirve pues es otra
  ruta, en ese caso debe mandar/pegar la ruta completa».
- S9: **Worktree scope step, with its data.** When the clone has more than the principal checkout,
  `/files` first shows a scope selector: `main` first, then every other checkout this package
  created, most recently modified first, each row showing `±n files` (singular `±1 file`) for its
  uncommitted files. Above the footer sits the focused scope's detail line, led by the last commit
  subject and then `±n files`, the age of the last modification, and `↑n main` / `↓n main` (the
  `main` row reads `origin/main`). A field whose value is zero or absent is not painted. With no
  other checkout the picker opens directly on the session's own path, so the extra step never
  appears when it has nothing to offer. «main siempre va arriba primero, luego se ordenan del cambio
  mas reciente ... si alguno es 0 ... no sale ese campo ... en la data el ultimo commit siempre
  primero y luego lo demas».
  *Superseded by S20 (round L9): the step always opens, `main` included. Kept as the record of the first cut.*
- S10: **Listing orders.** `ctrl+o` cycles the order and the footer names it: `modified` (the
  *Renamed by S33 (round L11): the flat order is `files`; `modified` named it imprecisely.*
  default, most recently modified first, painted as a flat file list), `path` (an IDE-style folder
  tree: inside a folder its subfolders come first and then its own files, so at the top level every
  folder group paints first and the files at the repository root last) and `ext` (one group per
  extension named with its dot, alphabetical by path inside, the extensionless group last). The
  active order is always visible. In `path` and `ext` the list is foldable: groups start expanded,
  the fold state is kept per order while the panel is open, `space` toggles the focused group and is
  named in the footer as `space fold`, and `enter` on a group also toggles it while `enter` on a
  file still inserts. A non-empty query forces every group open, and the fold keys do nothing until
  the query is cleared. Group rows paint only their name at their depth, with no badge and no age.
  In `modified` and `ext` a file row paints its parent directory at the right; in `path` it does
  not, because the tree already places it under that folder.
- S11: **The preview.** It sits inside its own rounded box, with the position of the top visible
  line embedded at the right of that box's top border as `line/total`, and a left gutter numbering
  each line. A line wider than the pane wraps onto continuation rows instead of being truncated with
  an ellipsis, and the gutter numbers the line once, its continuation rows aligning under the same
  text column. Reading is bounded: a fixed byte budget, an explicit truncation notice, and a binary
  file painted as a notice instead of bytes, so no file can stall the render. When the body is too
  short for the box plus one content row, the preview paints unbordered rather than squeezing its
  content. «si la linea es muy larga ... deberia hacer como el salto de linea ... cn los numeros sabe
  que es la misma o continuacion».
- S12: **Coloured preview, from the active theme.** The preview paints the file's syntax through the
  host's own `highlightCode` / `getLanguageFromPath`, so the colours are the active theme's and never
  a foreign palette. The highlighter is injected, so the view is testable without a live theme, and a
  wrapped line goes through an ANSI-aware wrapper so a colour run survives the break. The gutter keeps
  its dim tone and is never highlighted. An unknown language, a grammar the host has not loaded, an
  absent highlighter and a highlighter that throws all degrade to plain text: never blank, never an
  error, never a partial line. Highlighting runs once per preview load, never per repaint.
- S13: **Listing source and empty states.** The list comes from Git, so tracked files and
  untracked-but-not-ignored files appear and `.gitignore` is respected: «igual ... agrega que
  respete gitignore». Outside a Git repository, or with an empty result, the panel says so explicitly
  instead of painting an empty card.
- S14: **Open in the editor.** `ctrl+e` opens the highlighted file with `$VISUAL`/`$EDITOR` through
  this package's `lib/open-external.js`, reports its own failure sentence when neither is set, and
  never leaves a dead overlay behind. The handoff must not add a full repaint before the terminal is
  stopped: «al abrir con edit el archivo y luego cerrarlo da un tiron, no es muy fluido».
- S15: **Geometry and tones.** The card uses the vertical room the terminal offers instead of a short
  card, the list pane takes 45% of the content width with a 64-column cap so longer names and paths
  fit, and the preview takes the rest. A file row paints its name in the row's role and its trailing
  directory in `dim`, the two tones the rest of this package uses for that pair, because «nombre texto
  y ruta no se distinguen, mira en son distintos tonos de grises usa los mismos». A file at the
  repository root paints no directory.
- S16: **Read-only.** The panel reads and paints. It never writes the repository, never stages, never
  opens the network, and every child is a fixed argv with a bounded timeout (invariant 9).
- S18: **A keymap action in Gentle Shell, via the bridge.** When `gentle-shell-bridge` publishes its API,
  `/files` contributes the keymap action `files` (label "File picker", env `GENTLE_PI_FILES_KEY`,
  default `alt+p`, command `files`) through `api.registerKeymap`, so the action appears in Gentle
  Shell's Customize → Keymaps and is overridable there and through that environment variable. The
  extension then binds the effective key itself: `api.resolveKeymap("files")` gives `{ key }` (bind it
  with `pi.registerShortcut`) or `{ unavailable }` (bind nothing and say nothing). Registration is
  idempotent and comes from both `session_start` and the `gentle-shell-bridge:ready`
  announcement, with the stable id the bridge replaces in place; without a bridge nothing is
  registered, nothing is bound and no other surface changes. The action's default is a convenience,
  never a requirement: `/files` stays reachable from the palette with no key at all.
- S19: **A palette entry in the host's "Session" section.** The same bridge contribution adds
  `{ id: "files", label: "File picker", command: "files", section: "Session" }` through
  `api.registerCommands`, so `/files` joins Gentle Shell's command palette under Session, after that
  section's own entries. The section is the host's title, matched exactly — proved at
  `gentle-shell/lib/command-palette-catalog.ts:83` (`sectionOf` compared with `group.title`) and in its
  catalog's `Session` group. The host lists the row only while the `files` command is registered, so
  the entry can never be a dead row.
- S17: **The shipped surface, documented.** `/files` is a fifth command: `package.json`'s
  `pi.extensions` is untouched and `extensions/` still holds one file, but AGENTS.md invariant 3 and
  its layout table, README, `docs/reference.md` and `tools/package-surface.test.js` all state the new
  command and its modules. The whole suite stays green: `node --test tools/*.test.js`.

Round L9 (all reopen the delivered surfaces: S1, S3, S4, S9, S13, S18, S19):

- S20: **The scope step always opens.** Every `/files` invocation opens the checkout selector first, `main`
  included, even when nothing is registered, instead of jumping straight into the picker on the session
  checkout. The default rows are the session checkout plus the worktrees this session registered, and `a`
  toggles the step between that list and every worktree of the clone, discovered the way `worktree_list`
  discovers them. The footer names the list the key switches to (`a all`, then `a registered`), and a scope
  both lists carry keeps the cursor. "haremos un ajuste porque en el worktree si no tenia ninguno registrado
  lo saltaba y habria directo cwd actual, mejor hagamos que siempre abra primero el selector del
  worktree/path (que incluye main), pero que por defecto muestre en la opciones el checkout actual y
  worktrees registrado y con keybindig "a" muestra todos los worktrees."
- S21: **The listing path follows the title.** The title row paints the path being listed immediately after
  the panel's name, elided from its left when the card is narrow, and `esc` keeps the far-right corner
  alone — instead of pairing the path with `esc` at the edge, which is what made that corner read as
  "only esc". "otro punto es que a la ruta sala a la derecha de file, junto a titulo, extremo derecho solo
  dice esc."
- S22: **`listed/total (selected)` and the order at the list's edge.** Between the search row and the list,
  the picker paints how many files the active query lists out of the whole listing (`2/202` filtered,
  `202/202` unfiltered), the Tab selection count in parentheses, and the active order right-aligned at the
  list pane's edge behind a `─` fill (`202/202 (4) ─────── tree`). This is a new row: the picker has none
  today. "Tambien como en este ejemplo [Image#2] entre search y listado debe salir el total de archivos y si
  filtra search sale 2/202 (n), o sea cuantos son filtrados respecto al total, y dentro del paretesis el
  numero de seleccionados."
- S23: **The folder order is named `tree`.** The order S10 called `path` is `tree` in the footer, the code
  and the docs; the listing it paints is unchanged. "otro punto es que en orden por carpeta (que no salle
  path, se llame tree ese orden, arregallo)"
- S24: **Only file rows take the cursor.** In `tree` and `ext` the highlighted row is always a file: arrows,
  page moves, `home`/`end`, the wheel, a click and a query never park the cursor on a group row, and a
  group row is never marked, inserted or opened. `space` folds the group that holds the highlighted file
  (its parent folder in `tree`, its extension group in `ext`) and a click on a group row folds it without
  focusing it. The one exception, documented and pinned: with every group folded and no file row left, the
  cursor may rest on a group row so `space` can reopen the tree. "en ese modo [Image#4] no deberia dejar
  seleccionar la carpeta pues no es un file, en el listado esos campos no pueden estar select, se los debe
  saltar, lo mismo para orden por extension, las extension no son seleccionables, no pueden estar focus al
  moverse nunca."
- S25: **The preview uses the body's whole height.** The search row narrows to the list pane's width, the
  preview's box rides the new info row on top and closes on the list's last row, so the preview spans the
  body beside the list instead of sitting below the search row; a full-width rule then closes the body
  under both columns, aligning the separation below the list with the preview. The search row's right
  column stays blank. "si es posible, solo si se puede, como en el ejemplo, el preview, cuadrado de preview
  usa todo el alto, en el actual es debajo de search, la idea es ahicar search al ancho de la lista y
  agrandar alto el preview. y una linea abajo de listado para separa que se alinie con preview"
- S26: **The Tab mark reads in a theme role.** The bar a marked row paints uses a role of the active theme
  rather than an unstyled cell, focused or not. "el selector con tab, la linea tambien debe ser de color del
  tema, no blanca."
- S27: **`ctrl+e` returns to a live session.** Opening the highlighted file in the editor closes the panel,
  hands the terminal over, and gives it back with a repaint that leaves the prompt responsive as soon as
  the editor exits; the panel's view is disposed once the handoff returns instead of living on. "Otro bug es
  que con ctrl+e lo abre en editor, pero al cerra edit se bugea, pi queda congelado para siempre, es un
  claro bug. ... changes panel tiene algo similar para abrir en editor, podrias revisarlo para ver que
  diferencia hay que causa que pi se congele al retornar."
- S28: **The default key is `alt+f`.** The `files` keymap default becomes `alt+f`, still overridable through
  `GENTLE_PI_FILES_KEY` and assignable in the bridge's Keymaps page, because Pi claims `alt+p` for
  `app.model.cycleBackward` on Windows and WSL. "alt+f mejor"

Round L11 (all reopen the delivered surfaces: S3, S4, S10, S22, S24):

- S29: **`tree` and `ext` start folded, and say so.** Both tree orders open with every group collapsed, and every
  group row paints a chevron at its left — `▾` expanded, `▸` collapsed — so the state is visible without
  folding anything to find out. "Ademas que en ese orden vienen por defecto todas collapsadas. [Image#1] y deben
  tenr ese icono ▾ a su izquierda de si esta collapsado o expandido"
- S30: **Only the focused file's path opens on an order change.** Switching order or complementing the listing
  leaves expanded exactly the groups holding the highlighted file — `src` and `web` for `src/web/test.ts` in
  `tree`, only `ts` in `ext` — and every other group collapsed. "al cambiar todas se collapsan excepto la del
  que tengo focus claro, o sea si el archivo focus est src/web/tes.ts al cambiar a tree src y web nomas quedarian
  expandidos y si cambio a exp solo ts extension quedaria expandido todo lo demas colapsado"
- S31: **Group rows read in the grey role.** A folder or extension row paints in the theme's neutral grey rather
  than the text tone a file row uses, so the tree's structure is distinguishable at a glance from its files.
  "las extension y carpeta en eso orden tenga otro color para que se distinga, el rol gris tipico diria"
- S32: **`space fold` belongs to the trees.** The footer names `space fold` only while the active order paints
  groups, and in the flat order `space` does nothing at all instead of folding something invisible.
  "ademas keybinding space fold solo se verian por logica si el orden es tree o ext, en el base no hace nada en
  \"modified\""
- S33: **The flat order is `files`.** The order S10 called `modified` is named `files` in the footer, the code and
  the docs: it is the listing without groups, not a filter by modification. The ordering it paints (changed
  first, newest first) is unchanged. "y no lo llamaria modified, es impreciso, diria que se llame \"files\" u otro
  porque ese orden es el de mostrar por file (sin subcarpetas o cosas asi)"
- S34: **`shift+space` folds or unfolds every other group.** In `tree` and `ext`, `shift+space` toggles the whole
  tree: when every group except the highlighted file's own is already expanded, it collapses them; otherwise it
  expands them. The highlighted file's groups stay as they are, so the cursor never loses its row. The footer
  names it in those orders only. "Ademas en tree y ext falta un atajo para expadir todas (excepto la del focus o
  seleecion del file claro) y si estan todas expandidad (excepto la del file focus) el mismo cambiaria a
  collapsar todas."

- S35: **The default scope list is the session's, not the clone's.** The default rows of the scope step are `main`,
  the session's own checkout (deduplicated when it *is* `main`) and the worktrees this session registered through
  `worktree_register` — never every worktree the package created for an ODD. `a` is what widens the list to every
  worktree Git reports, which includes the ODD worktrees and the ones created outside this package. S20's "always
  opens" and its `a` toggle stand; this supersedes only which rows are built for the default list, and S20's own
  reading of "the worktrees this session registered" is now explicit instead of inferred from ownership.
  "que por defecto muestre ciempre main + el checkout actual (que puede ser main ahi no se duplica) y los worktrees
  registratos con worktree_register, y al presionar atajo \"a\" se ven todos, pues actualmente en ambos se ven todos,
  no confundir worktree register con worktree list. worktree register es por sesion y es para registar los worktree
  que trabaja la sesion, worktree list son todo asociados a un odd, por eso por defecto son los register nomas pues
  son los asociados a la sesion, con all ya ve todos los worktree"

- S36: **`/files` does not use the bridge for a keymap row or a palette row.** The `files` action no longer goes
  through `registerKeymap` and the `files` palette item no longer goes through `registerCommands`: the installed
  host has no reader for the bridge's plugin surface, so neither row can ever be listed and registering them is a
  claim the package cannot keep. The key itself stays: `/files` binds its shortcut directly through the host's
  `registerShortcut`, `alt+f` by default (S28) and `GENTLE_PI_FILES_KEY` as the override. The command stays
  reachable as `/files`. No legacy is kept: no dead constants, no bridge gate for this surface and no
  `resolveKeymap` read. This supersedes S18 and S19 and the "Keymaps/palette" part of S28; the bridge reads the
  issues rail and the bash design still use stay as they are. "bien, sacalo entonces, saca el uso de bridge para
  command y keymap de momento, sin dejar legacy, pues no es viable actualmente, es un falso"

Round L12 (reopen S21, S24, S28, S34):

- S37: **The path rides the panel's own title.** The title row paints `Files · <path of the checkout being
  listed>` at the left — the panel's name, one space, `·`, one space, then the path — elided from its left when
  the card is too narrow for it, and `esc` keeps the far-right corner alone. S21 asked for exactly this and the
  shipped row painted the path beside `esc` instead; that is the defect this round fixes. «la ruta no se arreglo
  igual, dije que fuera a la izquierda, al lado de File titulo "FIle · ruta"»
- S38: **Group rows take the cursor, and `tab` on them does nothing.** Every row of `tree` and `ext` is
  focusable: ↑/↓, the page moves, `home`/`end`, the wheel and a click park the cursor on a folder or extension
  row exactly as on a file row, which is what makes `space`/`enter` on it usable (S10, S32 stand). `tab` on a
  group row marks nothing and never adds it to the payload, and `enter` on a group row with no Tab mark inserts
  nothing and keeps the panel open. This supersedes S24's "only file rows take the cursor"; S24's mark, insert
  and open rules for a group row stand. «otro bug es que hicimos a carpeta y extension no seleccionable pero eso
  proboco que no pueda piscionarme para expandirla, el diseno correcto seria que si se pueda seleccionar/focus
  pero tab en ella no hace nada, no la selecciona para enviar»
- S39: **`shift+space` is one toggle over every group and leaves the cursor on the group it came from.** In
  `tree` and `ext`, `shift+space` collapses every group of the active order — the ones holding the highlighted
  file included — and parks the cursor on the group row that held that file, so the row the reader was reading
  from stays under the cursor; when every group is already collapsed the same key expands every group instead.
  No group is held open across the toggle: S34's "except the highlighted file's own" is superseded. «De ese modo
  la tecla colapsar todo antes colapsaba todo excepto carpeta actual del archivo, ahora tambien la colapsa y nos
  deja el focus en esa carpeta, seria el correcto funcionamiento replicando a un IDE.»
- S40: **The `shift+space` hint states the action, not the key.** The footer labels it `shift+space expand all`
  while every group of the active order is collapsed and `shift+space collapse all` otherwise, so the legend
  always names what pressing it does; it is still painted only in `tree` and `ext` (S32). «Ademas texto shfit
  space debe cambiar, si estan todas collapsadas seria para expandir todas, y si estan todas expandidas seria
  para collpasar todas, y solo aparece logicamente en tree/ext orden»
- S41: **The default key is `alt+p`.** The `files` shortcut's default is `alt+p`, bound the same way through the
  host's `registerShortcut`, with `GENTLE_PI_FILES_KEY` still the override. Supersedes S28: `alt+p` is unclaimed
  on Linux and macOS, where `app.model.cycleBackward` is `shift+ctrl+p`; on Windows and WSL it is that action's
  key and the host reports the conflict, which is the trade the human chose over `alt+f`'s collision with
  `tui.editor.cursorWordRight`. «cabimeoslo a alt p el default.»
- S42: **The scope detail line's age says it is an age.** The field S9 painted as a bare `33s` reads `33s ago`,
  in the same `s`/`m`/`h`/`d` units and from the same fixed-at-open clock, so the line identifies the number
  without a legend beside it; the file rows' own age column is unchanged. «otro punto es ue sale 33s pero no se sabe
  de que es, me imagino o recuerdo que era de cuando se modifico, falta algo visual, un icono que lo identifique o
  sino el texto, 33s solo uno no sabe que significa»

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S6, S13, S16 | worker: `lib/files-index.js` + `tools/files-index.test.js` — the Git listing (status porcelain, change state, mtime, age) and the bounded preview reader (byte budget, binary, truncation). Landed at `c9a48e8` (27/27 focused) |
| T2 | S7, S8 | inline: `lib/files-insert.js` + `tools/files-insert.test.js` — the reference form (`@`-relative vs absolute) and the space-separated join. Landed at `9580c3e` (13/13 focused) |
| T3 | S9 | worker: `lib/files-scope-detail.js`, `lib/files-scope-view.js` and their two test files — the scope step, its rows, the detail line and the Git reads behind them. Landed at `b770e54` (18/18 + 36/36 focused) |
| T4 | S10 | worker: `lib/files-orders.js` + `tools/files-orders.test.js` — the pure row builder for the three orders and their foldable trees. Landed at `a2aaae2` (32/32 focused) |
| T5 | S11, S12 | worker: `lib/files-preview.js` + `tools/files-preview.test.js` — the pure preview pane: box, gutter, position, ANSI-aware wrapping and the injected highlighter. Landed at `fd01e17` (18/18 focused) |
| T6 | S1-S6, S14, S15 | worker: `lib/files-picker-view.js` + `tools/files-picker-view.test.js` — the view composing T1, T4 and T5: chrome, search row, panes, keys, mouse, badges, ages, selection, insert/close/open. Landed at `8010bb5` (54/54 focused); the footer's `ctrl+j/k scroll` token was added at the parent's round (S4 names it, the first cut dropped it) |
| T7 | S17, S14, S9 | worker: the `files` command in `extensions/odd-worktree-tools.ts` — scopes from Git, `ctx.ui.custom`, `pasteToEditor`, `openExternal`, the lazy highlighter — plus AGENTS.md, README, `docs/reference.md` and `tools/package-surface.test.js` . Landed at `3c200d5` (the command, 11/11 in `tools/files-command.test.js`) and `30ac701` (AGENTS.md, README, `docs/reference.md`, `tools/package-surface.test.js`) |
| T8 | S18, S19 | worker: the bridge integration — `registerKeymap` (`files`, `GENTLE_PI_FILES_KEY`, `alt+p`), `registerCommands` with `section: "Session"`, `resolveKeymap` + `pi.registerShortcut`, registered from `session_start` and the ready event, with its tests (a fake bridge, an absent bridge, a bridge that publishes later) and the docs . Landed at `2167362` (11/11 in `tools/files-bridge.test.js`) with its docs in the commit after it |
| T9 | S22, S23, S24, S25, S26 | worker: `lib/files-picker-view.js`, `lib/files-orders.js` and their tests — the info row with the order at the list's edge, `path` renamed `tree`, a cursor that only rests on file rows, the full-height preview geometry and the rule row, and the mark bar in a theme role . Landed at `91245c2` (188/188 focused across the six picker suites) |
| T10 | S20, S27, S28 | worker: `lib/files-scope-view.js`, `extensions/odd-worktree-tools.ts` and their tests — the scope step that always opens with `a` for every worktree, the `ctrl+e` handoff that repaints and disposes, and `alt+f` as the default key . Landed at `cb6954a` (command 12/12, scope 42/42, bridge 11/11) |
| T11 | S17, S20-S28 | parent: docs truth — README, `docs/reference.md`, `docs/codebase/invariants.md` and `docs/codebase/code-map.md`, plus S9 marked superseded . Landed at this commit |
| T12 | S29, S30, S31, S32, S33, S34 | worker: `lib/files-orders.js`, `lib/files-picker-view.js` and their tests — folded-by-default trees with chevrons, the focused path as the only expansion, group rows in the grey role, `space fold` only in the trees, `modified` renamed `files`, and `shift+space` as the fold-all toggle . Landed at `d2cc328` (orders 50/50, view 88/88) |
| T14 | S35, S20 | worker: `extensions/odd-worktree-tools.ts`, `lib/files-scope-view.js` and their tests — the default list built from the session's own registration (`main`, the session checkout, `worktree_register` entries) and `a` alone widening it to every Git worktree root . Landed at `7933a79` (command 15/15, scope 42/42) |
| T15 | S36, S28 | worker: `extensions/odd-worktree-tools.ts`, the files bridge/command tests, and every doc that names the keymap row or the palette row — the `files` shortcut bound directly (`alt+f`, `GENTLE_PI_FILES_KEY`) and the bridge keymap and palette registration removed without a trace . Landed at `dd6b8f4` (bridge 10/10, command 15/15, package surface 21/21; full suite 2205/2205) |
| T13 | S17, S29-S34 | parent: docs truth in README, `docs/reference.md`, `docs/codebase/code-map.md` and the footer tables . Landed at this commit |
| T16 | S37 | worker: `lib/files-picker-view.js` and `tools/files-picker-view.test.js` — the title row carrying `Files · <path>` at the left with its left elision, and `esc` alone at the right |
| T17 | S38 | worker: `lib/files-picker-view.js`, `lib/files-orders.js` (only if a helper is missing) and their tests — every row focusable, `tab` inert on a group row, `enter` with no mark inserting nothing, and the preview settling when the cursor rests on a group |
| T18 | S39, S40 | worker: `lib/files-orders.js`, `lib/files-picker-view.js` and their tests — `shift+space` collapsing or expanding every group in one toggle with the cursor left on the group that held the file, and the footer legend stating the action it will perform |
| T19 | S41 | worker: `extensions/odd-worktree-tools.ts`, `tools/files-bridge.test.js`, `tools/files-command.test.js` and every doc naming the default key — `alt+p` as the `files` keymap default |
| T21 | S42 | worker: `lib/files-scope-detail.js` + `tools/files-scope-detail.test.js` — the scope detail's age painted as `33s ago` |
| T20 | S17, S37-S42 | parent: docs truth in README, `docs/reference.md`, `docs/codebase/invariants.md`, `docs/codebase/code-map.md` and `docs/codebase/mental-model.md`, plus this document's Log evidence and the work-unit commits |

### Module contracts (fixed here so T6 can be written against T1, T4 and T5)

Plain JS, no dependencies, every child injected. Shapes:

- **T1 `lib/files-index.js`**
  - `listRepositoryEntries({ run, cwd, now })` → `{ ok: true, entries } | { ok: false, message }`;
    `run(args, { cwd })` → `Promise<{ status, stdout, stderr }>` (the `runArgvAsync` result shape);
    `entries: Array<{ path, state: "new" | "updated" | "clean", mtimeMs?, age? }>`, changed first by
    recency then clean, ties by path.
  - `listRepositoryFiles({ run, cwd })` → `{ ok: true, files } | { ok: false, message }`.
  - `readFilePreview(root, relativePath, opts?)` → `{ kind: "text", lines, truncated } |
    { kind: "binary", message } | { kind: "error", message }`, bounded by
    `FILE_PREVIEW_LIMITS`; `FILE_PREVIEW_BINARY_NOTICE` is the binary sentence.
  - `formatAge(mtimeMs, nowMs)` → `s`/`m`/`h`/`d` label.
- **T4 `lib/files-orders.js`**
  - `ORDERS = ["modified", "path", "ext"]`, `nextOrder(order)`.
  - `buildRows(entries, { order, folded, query })` → `ListRow[]`, where
    `{ kind: "group", key, label, depth, folded }` or
    `{ kind: "file", entry, depth, showDirectory }`; pure, no painting, no state mutation.
  - `toggleFold(row, foldedSet)` and `groupKey(row)` for the view's per-order fold state.
- **T3 `lib/files-scope-detail.js` / `lib/files-scope-view.js`` (landed, `b770e54`)**
  - `orderScopes(scopes)`, `parseAheadBehind(stdout)`, `countCell(n)`,
    `scopeDetailLine(detail, now)`, `loadScopeDetail({ run, cwd, comparison })`,
    `LOCAL_MAIN`/`REMOTE_MAIN`; the age comes from T1's `formatAge`.
  - `createFilesScopeView({ scopes, theme, rowsAvailable, helpers, now?, onSelect, onClose, requestRender })`
    → `{ render(width), handleInput(data), handleMouse(event), invalidate(), dispose() }`; `onSelect`
    receives the original scope object. The wiring must supply `changedFiles` and `lastModifiedMs` per
    scope, and the runner it injects must be `run(args, { cwd })`.
- **T5 `lib/files-preview.js`**
  - `previewRows(preview, { width, height, scroll, highlight, languageForPath, path, metrics })` →
    `{ rows: Array<{ cells: Array<{ text, role }> }>, maxScroll, boxed }`, `role` one of
    `"dim"`, `"border"`, `"text"`; `metrics` is `{ visibleWidth, truncateToWidth, wrapTextWithAnsi }`.
    Pure: it reads no file and paints nothing itself.

## Log

- L1 (user, verbatim): «/home/jona/dev/projects/gentle-shell-worktrees/file-picker en ese worktree hice un file picker nativo para gentle shell pero no lo aceptaron, asi que lo agregaremos a ete plugin, revisalo y replicalo»
- L2 (parent, decisions): the source is a reference, not a copy. Its five modules and its
  `/gentle:files` wiring were mapped with path:line evidence; the portable parts are the pure
  `file-index`, `file-scope-detail` and `file-picker-insert` behaviour plus the view logic, and the
  replaced parts are gentle-shell's own overlay and palette substrate (`renderPaletteCard`,
  `paintHoverable`, `terminal-theme`, its `/changes` tracker). This package already owns equivalents
  (`lib/shell-card.js`, `lib/tui-paint.js`, `lib/view-layout.js`, `lib/worktree-git.js`), so the port
  reuses them instead of importing a foreign vocabulary. Host capabilities confirmed in the installed
  Pi 1.5.2: `ctx.ui.custom(factory, {overlay, overlayOptions})` (types.d.ts:132-150),
  `ctx.ui.pasteToEditor(text)` (:153), and `highlightCode`/`getLanguageFromPath` exported from the
  `@earendil-works/pi-coding-agent` package root (index.d.ts:38).
- L3 (parent, decisions): three calls the requirement leaves open. (a) The command is `files` — this
  package registers bare names (`warp`, `odd-list`, `issues`, `card:bash`), so no `gentle:` prefix.
  (b) There is no keymap surface here (invariant 2 keeps one preference only), so `/files` opens from
  the command palette and gets no `alt+p` shortcut: a shortcut is a second configuration surface this
  package refuses. (c) The highlighter is resolved lazily at open time (`await import` inside the
  command handler, try/catch, plain text on failure) and injected into the view, so the test loader's
  two static import stubs stay untouched and the view never needs a live theme.
- L5 (user, verbatim): «tambien integralo con gentle shell usando gentle bridge, le agregas el atajo a customize keymap para poder modificarlo y a panel commands seccion "Session" para atajo»
- L6 (parent, decisions): L5 supersedes L3(b), which had refused any keymap surface; recorded as S18, S19
  and T8. The bridge's own contract fixes the shape, read at
  `/home/jona/.pi/agent/npm/node_modules/gentle-shell-bridge/docs/contract.md` §9/§15 and
  `src/plugin-surface.ts:24-49`: `registerKeymap({ id, label, env, defaultKey, command })` and
  `registerCommands({ id, label, command, section })` both return a disposer, both are optional
  members on the one gated object at `Symbol.for("gentle-shell-bridge/api/v1")` (schema
  `gentle-shell-bridge/api`, version `1`), both carry no handler — only a slash command — and a
  keymap action's effective key comes from `resolveKeymap(id)` (env → saved binding → default), which
  the plugin binds itself with `pi.registerShortcut`. The action id is `files` (a `command:` prefix is
  refused by the bridge, that namespace belongs to the palette) and the env name follows Gentle
  Shell's own convention (`GENTLE_PI_COMMANDS_KEY`, `GENTLE_PI_AGENTS_VIEW_KEY` →
  `GENTLE_PI_FILES_KEY`). T8 runs after T7 because the palette row appears only while the `files`
  command is registered, and both touch `extensions/odd-worktree-tools.ts`.
- L4 (parent, decisions): the scope step reads this package's own worktree set through
  `lib/worktree-git.js` / `lib/worktree-registry.js` — the principal checkout first, then the
  checkouts under `<repo-name>-worktrees` by recency — instead of gentle-shell's session worktree
  registry, which this package does not have. Ported source behaviours kept because the reference
  states them: the preview is read-only and bounded, the age is fixed at open, the fold state is per
  order, and a query forces every group open.
- L7 (parent, closing evidence): the unit set T1-T8 is landed on `feat/files-picker`, one commit per work unit: `9580c3e` (T2), `c9a48e8` (T1), `a2aaae2` (T4), `b770e54` (T3), `fd01e17` (T5), `8010bb5` + `cf657ff` (T6), `3c200d5` (T7 command), `30ac701` (T7 docs), `2167362` (T8). Full unit stage on the final tree, `node --test --test-timeout=120000 tools/*.test.js`: 1952 tests, 1952 pass, 0 fail (baseline 1732 before the feature). Defects found by the parent while closing T7, each pinned by its test: the command tests awaited the handler before driving the overlay it was waiting on (a deadlock, not a slow test), the fake host owed the panels Pi's `matchesKey` seam, and the fake `wrapTextWithAnsi` stripped the very colour the highlighter test looks for. Bridge 0.4.0 (the shared `Sections` preview) was checked against this package: `SidebarSection` and `plugin-surface` are byte-identical to 0.3.2, so nothing here changed except the sentence in AGENTS.md and `docs/reference.md` that the issues section declares no preview. Known limits, stated honestly: the host's `registerShortcut` returns `void`, so a key changed in Customize applies after `/reload`; and the worker that first wired T7 stalled, so its half-finished tests were repaired inline rather than re-delegated. `Risk: none` — no irreversible data, security surface, concurrency, delivery or consumed contract changed, and every new behaviour is pinned by the suites above. Nothing was pushed; push, PR creation and merge remain the human's decisions.
- L8 (parent, slice boundary): `feat/files-picker` stands at 12 commits against `origin/main`, past the ~400-line review slice, because the feature is nine independent modules plus their suites. Delivery therefore follows `gentle-ai-chained-pr` when the human asks for it: a tracker PR plus one chained PR per work unit in dependency order (T2, T1, T4, T3, T5, T6, T7, then T8 last, because it is the only unit that touches Gentle Shell's surface). The unrelated `docs(issues)` commit `f4b0d5c` belongs to the issues-sidebar area and travels in its own PR. Nothing is pushed.
- L9 (user, verbatim): the round is reported in the conversation that produced it: the picker differs from the
  reference in the eight ways recorded as S20-S28, all of them in this repository. The parent's first attempt
  applied them to a `gentle-shell` worktree instead, opened `jonasotoaguilar/gentle-shell#81` and closed it
  unmerged on the human's instruction; nothing in this document, this branch or this package was lost in that
  detour, and the specs above are the ported set.
- L10 (parent, closing evidence): round L9 landed on `feat/files-picker` in three units, each with its tests and docs: `91245c2` (T9, S22-S26), `cb6954a` (T10, S20, S27, S28) and this docs commit (T11). Full stage on the final tree, `node --test --test-timeout=120000 tools/*.test.js`: **2179 tests, 2179 pass, 0 fail** (the baseline before this round was 1952; the round added 227). Focused sets: picker 70/70, orders 35/35, preview 18/18, command 12/12, scope view 42/42, bridge 11/11.
  Corrections the workers made to the parent's spec, each one right: (1) `CHROME_ROWS = 5` cannot also hold the new rule row, so the constant keeps its meaning and a `BODY_RULE_ROWS = 1` is subtracted from the body — `bodyRows = height - CHROME_ROWS - BODY_RULE_ROWS`, `BODY_TOP` and `MIN_CARD_HEIGHT` unchanged; (2) the info row's preview column is not blank: the box's top border rides it, so S25 wins over the task's wording; (3) the parent asked for the editor handoff to follow the reference end to end, and the worker found that the order defect lived in the extension's `onOpen` (it spawned before the overlay settled), not in the view's `finish()` — so the fix stopped `onOpen` from spawning and starts the editor after the overlay resolves, which is the reference's shape exactly.
  Honest limits: the `a` list costs two bounded Git reads per checkout before the step paints, so a clone with many worktrees opens the step a moment slower than the registered list alone; and the workers' own reports note that `tools/files-command.test.js` was not in T9's authorized commands, so the command path through the changed view was pinned only by T10's run of it (12/12), which does drive the same view. `Risk: none` — no irreversible data, security surface, concurrency, delivery or consumed contract changed, and every changed behaviour is pinned by the suites above.

- L11 (user, verbatim): the picker's tree orders need one more round: groups in a distinguishable grey role, folded
  by default with a `▾`/`▸` chevron, only the focused file's path expanded when the order changes, `space fold`
  advertised and working only in the trees, the flat order renamed `files`, and a `shift+space` toggle that expands
  or collapses every group except the focused file's own. The parent asked the two open decisions rather than
  choosing: the toggle key is `shift+space` and the flat order is named `files`.
- L12 (parent, closing evidence): round L11 and the scope report that followed landed on `feat/files-picker-groups` in three units: `d2cc328` (T12, S29-S34), `7933a79` (T14, S35) and this docs commit (T13). Full suite on the worktree, `node --test --test-timeout=120000 tools/*.test.js`: **2206 tests, 2206 pass, 0 fail**. Focused: orders 50/50, picker view 88/88, command 15/15, scope view 42/42.
  Slice boundary: the two code units are 915 and 270 authored lines, past the ~400-line slice, because the view's tree rules (folded seed, chevrons, re-seed per order, `shift+space`) are one behaviour and splitting them would leave a commit whose tests contradict its code. They stay separate from each other and from the docs.
  Corrections the workers made to the spec: (1) S30 says a root file expands no group; that holds for `tree` only, because in `ext` a root file still belongs to an extension group (`README.md` -> `md`) and S30's own `ts` example needs it open; (2) the helper the task named (`Key`) is the painting helper, so matching goes through the host's `matchesKey` plus the view's own sequence fallback; (3) `shift+space` only reaches the app under the Kitty keyboard protocol or xterm modifyOtherKeys, so a legacy terminal keeps `space` and no second key was invented.
  Not delivered by this repo: the `files` row in `/gentle:customize` -> Keymaps and the palette's `Session` page. This package registers both through the bridge exactly as the bridge's own example does; the installed gentle-shell (`95179bd6d`, upstream) has no reader of the bridge's plugin surface (`lib/plugin-surface.ts` is absent), so nothing can list a contributed row. The host half exists only as the fork's merged PR and as a hand-applied patch that a package update removed. `Risk: none` for this repo's change.
- L13 (user, verbatim): "bien, sacalo entonces, saca el uso de bridge para command y keymap de momento, sin dejar legacy, pues no es viable actualmente, es un falso" — after the parent showed that the installed gentle-shell has no reader of the bridge's plugin surface, so the `files` row in Keymaps and the palette can never appear.
- L14 (parent, closing evidence): T15 landed as `dd6b8f4`. `/files` registers no keymap action and no palette row through the bridge; `alt+f` is bound directly with `registerShortcut` and `GENTLE_PI_FILES_KEY` overrides it. Full suite, `node --test --test-timeout=120000 tools/*.test.js`: **2205 tests, 2205 pass, 0 fail** (the count is one below L12's 2206 because the rewritten bridge suite folds two idempotence cases whose subject no longer exists). The README, `docs/reference.md`, `docs/codebase/invariants.md`, `code-map.md` and `mental-model.md` now say so. The Keymaps/palette rows return only when an installed host reads the bridge's plugin surface. `Risk: none`.
- L15 (user, verbatim): «cabimeoslo a alt p el default.» — after the host reported `Extension shortcut conflict: 'alt+f' is built-in shortcut for tui.editor.cursorWordRight`, which is `alt+f`'s third default alias beside `alt+right` and `ctrl+right`.
- L16 (user, verbatim): «otro bug es que hicimos a carpeta y extension no seleccionable pero eso proboco que no pueda piscionarme para expandirla, el diseno correcto seria que si se pueda seleccionar/focus pero tab en ella no hace nada, no la selecciona para enviar. De ese modo la tecla colapsar todo antes colapsaba todo excepto carpeta actual del archivo, ahora tambien la colapsa y nos deja el focus en esa carpeta, seria el correcto funcionamiento replicando a un IDE. Ademas texto shfit space debe cambiar, si estan todas collapsadas seria para expandir todas, y si estan todas expandidas seria para collpasar todas, y solo aparece logicamente en tree/ext orden»
- L17 (user, verbatim): «la ruta no se arreglo igual, dije que fuera a la izquierda, al lado de File titulo "FIle · ruta"» — with a screenshot of the picker whose title row still paints the path beside `esc`, so S21 was never implemented.
- L18 (parent, decisions): the round's four calls. (a) S24 is superseded rather than amended: the cursor now stops on every row, so its "never park the cursor on a group row" cannot stand, while its mark/insert/open refusals do. (b) `shift+space`'s direction is decided by "every group collapsed", not by a majority, so a mixed tree always collapses on the first press and the second press expands it — the reading the human's own sentence gives. (c) `alt+p` is chosen knowing it is `app.model.cycleBackward` on Windows and WSL only (`docs/keybindings.md:154` of Pi 1.5.2), where the host will report the same kind of conflict the human is trying to silence; Linux and macOS keep `shift+ctrl+p` and stay clean. (d) The title is the card's own title (`Files · <root>`), not the `titleHint` cell, so the path elides with the title's room instead of fighting `esc` for the corner.
- L19 (user, verbatim): «otro punto es ue sale 33s pero no se sabe de que es, me imagino o recuerdo que era de cuando se modifico, falta algo visual, un icono que lo identifique o sino el texto, 33s solo uno no sabe que significa» — with a screenshot of the scope step's detail line reading `Merge pull request #89 ... · ±14 files · 33s · ↑13 origin/main`.
- L20 (parent, decision): the age gets the word, not a glyph. The line's other symbols (`±`, `↑`, `↓`, `▸`) are all narrow, and a clock glyph (`⏱`, `⌚`, `◷`) is East-Asian-ambiguous — a terminal that paints it two cells wide shifts every cell to its right, and this repo measures with `visibleWidth` before it paints. `33s ago` is the human's own second option and carries no width risk.
