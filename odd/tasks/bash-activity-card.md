# Feature: bash-activity-card

The bash card's `activity` design on gentle-shell-bridge 0.5.0: role colours, `$ bash` fallback, ms on
the closing rule, long commands named, fewer generic cards, no slowdown, one `Card tools` line.
Worktree `bash-activity-card`, branch `feat/bash-activity-card`, base `main@ed026a8`.

## Specs

- **S1** — "en card tool la primera vez que abrir no habia nada seleccionado, por defecto debe usar diseno
  activity ... ahi deberia crearla la primera vez, que venga con activity seleccionado y funcionando"
- **S2** — "lo primero es que no apace abajo derecha los ms" and "deberia que tipo tener su color de rol ...
  actualmente estan todos con el mismo y esta mal" (issue Gentleman-Programming/gentle-shell#3054).
- **S3** — "tambien las tools grep/find/fd/ls/cat (grep creo que era tool, nose las otras), deberia igual
  etiquetar como exploring".
- **S4** — "hay muchas que no esta etiquetando ... la idea es que caiga menos posible en el "$ bash"
  generico" and "por defecto deberia mostrar "$ bash" no solo " $ " si esta en estilo activity".
- **S5** — "encuentro que demora mas en cargar y mas en abrir/cambiar/reanudar sesiones con el plugin, debe
  ser por lo de issues sidebar quizas."
- **S6** — "arregla el preview, muy largo, debe ser 1 linea como demas. Adema que no se lamme "Card bash",
  ponle ahora que sea "Card tools" default | activity".

## Tasks

- **T1** (S1) — seed `activity` once on the first run. DONE `bd5dc83`.
- **T2** (S2, S4) — role colour, `$ bash`, ms, frame by state, args from `ctx.render`. DONE `9b7e78b`.
- **T3** (S4) — more read-only programs named. DONE `b94f694`; census-driven rules still open (T7).
- **T4** (S4) — room for the label from the command tail, net SGR. DONE `2aee6d5`.
- **T5** (S6) — preview on one line.
- **T6** (S6, S3) — one `Card tools` line: bridge multi-tool line (`line` + `tools`), then register bash +
  grep/find/ls/read under it.
- **T7** (S4) — census of real generic commands, then rules.
- **T8** (S5) — find and fix the slowdown on open/resume/session switch.
- **T9** — docs for bridge 0.5.0 (`default`, min version), the theme-role caveat, `Card tools`.

Slices (delivery is the user's call; no push or PR yet):
- **Slice 1** `bd5dc83..dbfba67` — seed, colour/frame/ms, `fd` and read-only programs, room for the label,
  memo + one-line preview, docs. Suite 1772+ green.
- **Slice 2** (open) — worker diffs: issues gate off the `session_start` path (T8) and the census-driven
  classifier rules (T7). Reviewed and committed by the parent, one commit each.
- **Slice 3** (open) — `Card tools` on the bridge's multi-tool line and the grep/find/ls/read headings (T6).

## Log

- **L1** — user: "Igual encuentro que anda muy lento ahora, se demora en abrir mas pi, se demora en cagar la
  sesion ,cuando hago resume o cambio de sesion/chat se demora mucho mas, se pega, antes no pasaba o no tan asi".
- **L2** — user: "bridge cambio para tool design, asi que revisalo para apadar y mejorar el nuestro, para que
  cada bash personaliza tenga su color adecuado. Igual revisa si estan todo los posibles comandos bash
  contemplados para cada una, no escatimes en esto, que llegue lo menos posible a generico "$ bash"".
- **L3** — finding: TokyoNight resolves `mdLink` and `syntaxFunction` to the same blue (#7aa2f7) and `success`
  (#7dcfff) / `bashMode` (#2ac3de) to two near cyans; the roles are the issue's, the theme makes them alike.
