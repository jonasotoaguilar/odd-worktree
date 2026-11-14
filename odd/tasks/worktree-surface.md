# worktree-surface — the checkout directory is the only record

Goal: no extra list file. A worktree this package creates always lives at
`<repo-parent>/<repo-name>-worktrees/<odd>`, so the path says which checkouts are ours
and what their ODD is. `worktree_list` lists the checkouts that exist there (plus the
main one, plus the outside ones with `all`), without the `odd:` field, without the
create-time hooks and setup lines and without a stored state vocabulary. The setup chain
and its log stay; only the persisted state record goes.

## Specs

- **S1** — «en worktree create ourput esta demas parte de hooks porque no sabe cuales
  se salto es info inutil, y setup igual porque es en backgournd al momento de la tool
  no tieene la info.» — the create's output carries no hooks part and no setup part: at
  call time it knows neither which hooks were skipped nor how setup went.
- **S2** — «En list igual es infor irelevante, ahi queremos saber los worktrees
  existentes creados con la tool o los de fuera tambien con all.» — the list answers one
  question only: which worktrees exist, the ones created with the tool, and with `all`
  also the ones outside.
- **S3** — «Igual ahi campo odd esta demas en el output y de hecho tambien ahora esta
  demas tener el archivo extra de lista .versiong. Porque lo worktrees creados siempre
  se llaman como odd asi que ya tenemos el dato ademas es en el mismo path asi que ahi
  tenemos cuales son nuestros y cuales de afuera.» — the `odd:` field goes from the
  output and the extra versioned list file goes: the created worktrees are always named
  after the ODD, so the name is the data, and the path already tells ours from outside.
- **S4** — «por lo que la lsita que crea el plugin ya no va» — the list file the plugin
  creates is gone; nothing replaces it, and no second file stands in its place.
- **S5** — «The bash cards mix the float and neon looks and the accent is wrong: it
  should be the orange of his theme. The cards must follow the style chosen in
  gentle-shell, live, and fall back to float when gentle-shell cannot be detected.» —
  the worktree tool cards render in ONE style — the `neon` rounded frame or the
  `float` rail, whichever Gentle Shell has chosen — never a mix of the two; the
  accent is the theme's `warning` role (the orange), never a colour; the choice is
  read live (the shell's process-wide slot) and falls back to the strict
  `<home>/card-style.json` and then to `float`, with no watcher. Content, order,
  truncation, the collapsed three-row preview and the elapsed time are identical in
  both styles; too narrow or a theme without the background role draws the neon
  outline instead of a broken float card.
- **S6** — S5 covers every card this package draws, the `/warp` message card
  included: it renders through the same one `floatRows` decision — the `neon` frame
  or the `float` rail, the accent in the theme's `warning` role — and keeps no
  tone→colour table of its own beside the substrate's. Heading, rows, order,
  clipping and expanded wrapping are the same text in both styles; only the chrome
  differs.

## Tasks

- T1: `odd/tasks/worktree-surface.md` holds the human's own words verbatim (S1–S4).
- T2: the clone document is gone: no registry, no records, no replacement file (S3, S4).
- T3: `worktree_list` lists the checkouts this package created plus the main row, and
  with `all: true` also the worktrees git knows outside the directory (S2, S3).
- T4: the listing drops the `odd:` field, the date, the setup and hooks lines and the
  document-only state vocabulary; the ODD is the directory's basename (S2, S3).
- T5: `worktree_create`'s output drops the hooks part and the setup part and keeps its
  other lines and parameters (S1).
- T6: the readers and writers of the document are retired and their tests are removed
  with the reason each subject is gone (S3, S4).
- T7: the setup chain still runs and its completion notice follows the child process
  outcome, not a persisted record (S1, S3).
- T8: the session guard, `/warp`, the create wizard, git-only removal and the kept
  branch are untouched; a create followed by a list writes nothing (S3, S4).
- T9: `lib/card-style.js` is the one reader of the style: the shell's process-wide
  slot, then the strict document, then `float`; it reports its source and the reason
  it fell back, never throws, caches only the document branch on its own path, and is
  re-read on `session_start` (S5).
- T10: `lib/shell-card.js` renders both styles from that one decision — the neon
  frame or the float rail, the accent in the theme's `warning` role, the tone
  background under float — so no card is half of each, and both keep the same text
  (S5).
- T11: the two tool cards keep their content, order, truncation, preview budget and
  right-aligned elapsed in both styles; a location narrower than float, or a theme
  without the background role, draws the neon outline (S5).
- T12: the extension re-reads the style on `session_start`, and the README documents
  the live slot, the document fallback, the accent role and the fallback to neon
  (S5).
- T13: the `/warp` message card is composed on `lib/shell-card.js` — its parts handed
  to the substrate's `floatRows` — so one decision per render picks its style, its
  private float recipe and tone table are deleted, and its text is identical in both
  styles (S5, S6).

## Log

- **L1** — «en worktree create ourput esta demas parte de hooks porque no sabe cuales
  se salto es info inutil, y setup igual porque es en backgournd al momento de la tool
  no tieene la info.»
- **L2** — «En list igual es infor irelevante, ahi queremos saber los worktrees
  existentes creados con la tool o los de fuera tambien con all.»
- **L3** — «Igual ahi campo odd esta demas en el output y de hecho tambien ahora esta
  demas tener el archivo extra de lista .versiong. Porque lo worktrees creados siempre
  se llaman como odd asi que ya tenemos el dato ademas es en el mismo path asi que ahi
  tenemos cuales son nuestros y cuales de afuera.»
- **L4** — «por lo que la lsita que crea el plugin ya no va»
- **L5** — «The bash cards mix the float and neon looks and the accent is wrong: it
  should be the orange of his theme. The cards must follow the style chosen in
  gentle-shell, live, and fall back to float when gentle-shell cannot be detected.»
