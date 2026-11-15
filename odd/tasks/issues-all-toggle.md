# issues-all-toggle — `All` becomes a shortcut, and the filter spans every view

`/issues` stops loading every issue on open: `All` leaves the tab bar and becomes a toggle key, the
filter applies to the three scoped tabs and travels with you into `All`. Its own ODD, branched from
`main`; the sidebar work (`feat/issues-sidebar`) is independent of it.

## Specs

- **S1 — `All` is a shortcut, not a tab.** The tab bar reads `My issues (<n>)`, `Assigned (<n>)`,
  `Involved (<n>)`. The key `a` switches the view to `All`; in that view the tab bar reads only
  `All (<n>)` and the footer hint that said `all issues` now reads `related issues`. Pressing `a`
  again returns to the view you came from — the tab that was active, not always the first one.
  Verbatim: "en vez de poner tab como All lo pondria como un atajo, que si activo el atajo me cambia
  y en vez de salir my issues | assiged | involved me salga solo \"All\" y luego con la misma tecla
  (pero ahora el atajo diria issues relacionadas o algo asi en vez de all issues) me ddevuelve a
  vista anterior".
- **S2 — opening the panel is cheap.** Opening `/issues` reads only the three scoped buckets. The
  `All` read starts the first time you enter it, and re-entering reuses what was already read
  instead of re-fetching — unless the filter changed (S4). Verbatim: "Asi abrir panel issues no
  cargaria todas las issues siempre aun cuando solo quiero ver las mias, sino que solo las carga al
  moverme a all, haciendolo mas optimo".
- **S3 — the filter spans the three tabs.** A typed filter applies to `My issues`, `Assigned` and
  `Involved`: the rows shown match it AND each tab's count is the FILTERED total, not the unfiltered
  one. Verbatim: "el search el filtro debe aplicarlo a la 3 tabs, my issues, assigned e involded y
  actualizar total que dice tab claro, se aplica a 3".
- **S4 — the filter survives every view change.** Switching tabs keeps it; entering `All` keeps it,
  and that read is issued WITH the filter; clearing it re-reads everything. Verbatim: "Si cambio y
  me mueve a All el filtro se matiene asi que cuando va a buscar all las busca directamente con el
  filtro, al borrarlo claro busca todas, osea, el filtro se consserva entre cambio".
- **S5 — `All` has two honest paths.** Unfiltered, `All` keeps today's repository-connection read,
  which reports an exact total. Filtered, it cannot: the connection takes no text, so the filtered
  read goes through the search path, which GitHub caps — so a filtered `All` never claims an exact
  total it cannot know, and says which read is on screen.
- **S6 — nothing else moves.** Every other key, the mouse, `o web`, `c comment`, `t search`,
  `esc close`, the mutations and their refusals, the `/issues` gate and the sidebar behave exactly
  as before; `node --test tools/*.test.js` stays green.

## Decisions

- D1 — the key is `a`; the footer hint carries the two labels (`all issues` outside `All`, `related
  issues` inside it), so the shortcut teaches itself.
- D2 — leaving `All` returns to the tab that was active when you entered it.
- D3 — `All`'s loaded page is invalidated when the filter changes, so it can never show rows that
  belong to a previous filter.

## Tasks

| ID | Spec | Route | Surface | Commit |
| --- | --- | --- | --- | --- |
| T1 | S2, S5 | worker | `extensions/odd-worktree-tools.ts`, `lib/issues-view.js` | pending |
| T2 | S1, S3, S4, S6 | worker | `lib/issues-view.js`, `extensions/odd-worktree-tools.ts` | pending |

## Log

- **L1 (user, verbatim):** "igual haria un cambio a panel issues y es que en vez de poner tab como
  All lo pondria como un atajo, que si activo el atajo me cambia y en vez de salir my issues |
  assiged | involved me salga solo \"All\" y luego con la misma tecla (pero ahora el atajo diria
  issues relacionadas o algo asi en vez de all issues) me ddevuelve a vista anterior. Asi abrir
  panel issues no cargaria todas las issues siempre aun cuando solo quiero ver las mias, sino que
  solo las carga al moverme a all, haciendolo mas optimo. Igual el search el filtro debe aplicarlo a
  la 3 tabs, my issues, assigned e involded y actualizar total que dice tab claro, se aplica a 3. Si
  cambio y me mueve a All el filtro se matiene asi que cuando va a buscar all las busca
  directamente con el filtro, al borrarlo claro busca todas, osea, el filtro se consserva entre
  cambio."
