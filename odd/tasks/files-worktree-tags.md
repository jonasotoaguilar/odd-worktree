# files-worktree-tags — change badges from the branch's own commits

The `/files` panel marks changed files today from `git status` only, so committing a
worktree's work erases every badge. A worktree scope now derives its badges from the
commits it has ahead of the principal branch; the main scope keeps the status read.

Tech: Node CJS `lib/*.js` + `tools/*.test.js`, Pi extension `extensions/odd-worktree-tools.ts`.

## Specs

- S1: **The main scope keeps the status read.** The principal checkout is marked from
  `git status --porcelain`: `U` for an untracked file, `M` for a tracked file with an
  uncommitted change, nothing for a clean one. User, verbatim: "si es un cambio en
  main/principal ahi lo calcula en base a git diff para mostrar que es U,M, etc."

- S2: **A worktree scope reads its own commits.** The changed files of a worktree are the
  files its branch changed ahead of the PRINCIPAL branch, read as one
  `git diff --name-status -z --no-renames refs/heads/<principal>...HEAD --` (three dots,
  so the comparison is the merge-base). The branch is the one the principal checkout has,
  read from Git (`master` in a `master` repository), never a hard-coded `main`; the ref is
  qualified as `refs/heads/` and the argument list is closed with `--`, so a tag, a remote
  or an ordinary file spelled `main...HEAD` cannot shadow or break the read. User, verbatim: "si es un worktree para asignar la tags de que cambios lo
  hace en base a los commits adelantados desde main/principal, o sea, si el worktree su
  esta en rama b que esta 3 commits sobre main, entonces los archivos cambiados los
  obtienes en base a esos 3 commits (claramente si se repite un archivo cambiado en los 3
  solo toma uno, y si calza mas de una tag toma la ultima o segun prioridad)".

- S3: **One state per path, and it is the net one.** A path named by several of those
  commits is listed once, with the state the net diff reports: `A` when the path does not
  exist at the merge-base, `M` when it does, deleted when neither. No last-commit and no
  severity rule is needed, because the net diff describes the branch's effect on `main`.
  User's choice, from the option's preview: "`git diff --name-status -z -M main...HEAD`
  → un solo estado por path, deduplicado por construcción".

- S4: **Uncommitted work is still marked, and a commit state wins.** A file the worktree's
  own `git status` names joins the set when no commit state named it: untracked is `U`,
  tracked-and-dirty is `M`. A path in both keeps the commit state. User's choice, from the
  option's preview: "si el path está en ambos → gana el estado del commit / si sólo está
  sucio → updated (M) / si es untracked → new (U)".

- S5: **Three badges, and no row for a deleted file.** The vocabulary is exactly
  `added` → `A`, `modified` → `M`, `new` → `U`, and a clean file paints neither letter nor
  a placeholder. A path the commits deleted is not listed at all: the panel lists files
  that exist, so there is no row to preview, insert or mark, and no `D` badge. The state
  the status read called `updated` is named `modified`, so the package has one name per
  badge. User, verbatim: "aunque si deteled no los listamos (no sale en files) tag D esta
  demas creo, seria A,M,U supongo".

- S6: **Read-only, one child per read, and a failure is a sentence.** Every read is a
  fixed argv array through the injected async runner with a bounded timeout, never a shell
  string; nothing stages, writes or opens a socket. Read-only includes the repository's
  OBJECT STORE: `--no-renames` is not a cosmetic flag, because similarity detection makes
  Git fetch a missing merge-base blob in a partial clone and write a pack — the net state
  does not need it, since an undetected rename is a delete plus an add and the delete gets
  no row. A failed read is a sentence the panel paints, never an empty listing and never a
  half one.

- S7: **The shipped surface and its docs move together.** `docs/reference.md` (`## /files`)
  and `docs/codebase/code-map.md` name the two sources and the three badges, and the
  focused tests pin both the new worktree states and the unchanged main-scope ones.

- S8: **The title names the distance ahead, and only ahead.** The picker's title paints
  `Files · <checkout path> · ↑n <base>` whenever the browsed checkout has commits its
  comparison does not, and nothing at all when it is level, when the base was never
  measured or when the scope carries no detail. The field is never elided: the path gives
  way first, and when no path worth painting is left the field keeps the row alone. User,
  verbatim: "me falto mencionar que arriba en el titulo salga si esta adelante a main, sea
  \"FIles · <worktree name> ·↑3 main\" (eso de flecha main solo si esta adelantedo claro,
  la cantidad de commits por delante)".

- S9: **One distance on the scope line, never two.** The detail line above the scope step's
  footer paints `↑n <comparison>` when the checkout has commits the comparison does not, and
  `↓n <comparison>` only when it has none. `↑1 main · ↓310 main` is what the line painted
  for a worktree one commit ahead of a `main` that had moved 310 commits on: both counts
  are true Git facts and the pair reads as a contradiction. User, verbatim: "igual revisa un
  bug que sale ahi adelante 1 y atraso 310 y no tiene sentido que este adelante y atrasado a
  la vez, es imposibel".

## Tasks

| ID | Specs | Route | Status |
| --- | --- | --- | --- |
| T1 | S2, S3, S6 | `lib/files-index.js`: the `<principal>...HEAD` name-status read, its parser, the union with the status read and the deleted filter; `tools/files-index.test.js` | done — 8 focused tests, RED observed first, including two that spawn real Git for the ambiguous ref and the partial clone |
| T2 | S1, S5 | `lib/files-picker-view.js`: the badge map `A`/`M`/`U`; `tools/files-picker-view.test.js` | done — the vocabulary table plus one painted-`A` test, RED first |
| T3 | S1, S2 | `extensions/odd-worktree-tools.ts`: the scope's `kind` decides the comparison, and a worktree scope carries the principal checkout's own branch in `base` (`filesComparison()`) | done — `tools/files-command.test.js` drives the real command over real repos: `A`/`M`/`U` in a worktree after committing, none in `main`, and `A` in a `master` repository |
| T4 | S7 | `docs/reference.md`, `docs/codebase/code-map.md` | done — both name the two sources and the three badge letters |
| T5 | S6, S7 | full suite, independent verification, the work-unit commit | landed at `793deea`; independent verification (Risk item 3) found 3 defects (F1-F3 in L8), each fixed and pinned; suite on the committed tree: `node --test tools/*.test.js` 2559 tests, 2559 pass, 0 fail, 0 skipped |
| T6 | S8, S9 | `lib/files-picker-view.js` (the title's ahead field) and `lib/files-scope-detail.js` (one distance); `tools/files-picker-view.test.js`, `tools/files-scope-detail.test.js`, `tools/files-command.test.js`, `docs/reference.md` | landed at `984c028`; RED observed for both (`↑2 main · ↓310 main` and the title without a field), then GREEN; suite 2561 tests, 2561 pass, 0 fail |

## Log

- L1 (user, verbatim): "revisa como funcioan /files porque una funcion que tiene es mostrar
  con tags los archivos con cambio, pero quiero hacer un cambio a esto. pues actualmente lo
  hace usando el git diff creo, pero al hacer commit se piede esto, no sabemos que cambios,
  asi que mi idea es la siguiente pero solo para los worktree. o sea, si es un cambio en
  main/principal ahi lo calcula en base a git diff para mostrar que es U,M, etc. Pero si es
  un worktree para asignar la tags de que cambios lo hace en base a los commits adelantados
  desde main/principal, o sea, si el worktree su esta en rama b que esta 3 commits sobre
  main, entonces los archivos cambiados los obtienes en base a esos 3 commits (claramente
  si se repite un archivo cambiado en los 3 solo toma uno, y si calza mas de una tag toma la
  ultima o segun prioridad), se entiende la idea?"
- L2 (user, decisions, one per questionnaire answer): (a) the state is the net diff
  `git diff --name-status -z -M main...HEAD`, not a last-commit walk; (b) the set is the
  union of those commits and the worktree's own `git status`, and a commit state wins over
  a dirty one; (c) a deleted path is not listed; (d) the badge vocabulary is A/M/D/U.
- L3 (user, verbatim, correcting L2d): "aunque si deteled no los listamos (no sale en
  files) tag D esta demas creo, seria A,M,U supongo". S5 is rewritten; the deleted path is
  dropped from the listing and `D` never exists.
- L4 (parent, finding from the explorer): no reusable helper answers "which files is this
  branch ahead by" — `aheadBehind` (`lib/worktree-git.js:643`) and `loadScopeDetail`
  (`lib/files-scope-detail.js:207`) return counts only, and the only merge-base use lives
  inside the copy path (`lib/worktree-changes.js:664`). The read is new code in
  `lib/files-index.js`.
- L5 (parent, finding from the explorer): the scope already carries `kind: 'main' |
  'worktree'` (`extensions/odd-worktree-tools.ts:7107-7123`) and the scope detail already
  picks `origin/main` for main and local `main` for a worktree
  (`lib/files-scope-detail.js:27-29`), so the comparison the badges use is the same one
  the `±`/`↑`/`↓` line already uses.
- L6 (parent, evidence): `git diff --name-status -z -M -C --find-copies-harder` writes a
  rename or copy record as `<status>\0<original path>\0<path the record is about>\0`, so
  the parser reads the SECOND path and skips the first. Two test fixtures the parent had
  written the other way round were corrected against real Git output, not the other way.
  The end-to-end browse in `tools/files-command.test.js` prints, for a worktree two commits
  ahead with one untracked file, `a.js M 0s`, `committed.js A 0s`, `x.js U 0s`,
  `README.md` bare, and the scope row above it `with-commits · feat/commits ±3 files ·
  ↑2 main`: the count, the badges and the ahead count agree.
- L7 (parent, decision): the state the status read used to call `updated` is named
  `modified`, so the package has ONE name per badge (`added`/`modified`/`new`, one letter
  each) instead of two names for `M`. This is the exported-surface change the Risk line
  names, and it is why the existing `updated` assertions in four test files moved with it.
- L8 (parent, the independent verifier's verdict and what came of it): S1, S3, S4, S5
  passed; three of its findings were real and are fixed, each pinned by a test that fails
  without the fix.
  (F1, S2) The read was `main...HEAD` unqualified: a `main` TAG on the branch tip made Git
  answer "no changes", and an ordinary FILE named `main...HEAD` made the whole read exit
  128, leaving the picker empty where the baseline listed that file. Now
  `refs/heads/<principal>...HEAD --`.
  (F2, S6) `-M` was not read-only: in a partial clone the similarity pass fetched the
  missing merge-base blob and left `.pack`/`.idx`/`.promisor` files in the object store.
  Now `--no-renames`, and the net state is identical because a rename's delete is a path
  that gets no row.
  (F3, S7) `docs/codebase/code-map.md` named the internal states but not the letters; it
  now names `A`/`M`/`U`.
  (F4, no action by design) `odd/tasks/files-picker.md:335` keeps the historical
  `"new" | "updated" | "clean"` contract: that document is the record of that round, and
  L7 supersedes it here instead of editing history.
- L9 (parent, a defect the parent found while the verifier ran, fixed under F1): the
  comparison was the constant `main`, so a repository whose principal branch is `master`
  would have diffed against a ref that does not exist and the worktree's listing would have
  failed entirely. The principal checkout's branch now travels on the scope as `base`,
  read from Git's own checkout listing, with `LOCAL_MAIN` only as the fallback for a
  detached principal.
- L10 (parent, evidence and review shape): the whole feature is `793deea` on
  `feat/files-worktree-tags` — 678 insertions, 41 deletions across 11 files, of which
  roughly 300 lines are the tests that pin S1-S7 and 350 the code, docs and this document.
  That is one slice past the ~400-line target: the slice boundary is declared here rather
  than split, because the change cannot be landed half-way (the vocabulary rename and the
  commit read are one contract) and the tests are what make the 2559-test suite prove it.
  The delivery shape is therefore ONE pull request; if a reviewer wants it smaller, the
  split that keeps every commit green is tests-plus-docs on top of the two lib reads.
- L11 (user, verbatim): "igual revisa un bug que sale ahi adelante 1 y atraso 310 y no tiene
  sentido que este adelante y atrasado a la vez, es imposibel". The parent reproduced it in
  this repository: `git rev-list --left-right --count main...fix/warp-space-dash-input`
  answers `310 1` — the branch holds one commit `main` never got (`f0f6804`), and `main`
  moved 310 commits on since that branch was cut. Both numbers are real, so the defect is
  the PAIR, not the arithmetic: S9 makes the line paint one distance.
- L12 (user, verbatim): "me falto mencionar que arriba en el titulo salga si esta adelante a
  main, sea \"FIles · <worktree name> ·↑3 main\" (eso de flecha main solo si esta
  adelantedo claro, la cantidad de commits por delante)". S8 is written from it; the title
  keeps the path S37 already paints and appends the field, and the field comes from the
  scope's own `detail` (`filesScopeFacts`), so the title costs no extra Git read.
- L13 (parent, review shape after the follow-up): the feature is three commits on
  `feat/files-worktree-tags` — `793deea` (the worktree commit read, S1-S7), `215fd68`
  (this document) and `984c028` (the title field and the single distance, S8-S9) — 886
  authored changed lines in total. Two reviewable slices, each green on its own: the read
  and its badges, then the two rendering rules. Delivery stays ONE pull request.
