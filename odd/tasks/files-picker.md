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
- S10: **Listing orders.** `ctrl+o` cycles the order and the footer names it: `modified` (the
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
