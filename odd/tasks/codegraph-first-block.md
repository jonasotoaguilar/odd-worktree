# codegraph-first-block — the CodeGraph rule is enforced where a weaker model skips it

Goal: in a measured session the primary session (deepseek-v4.1-flash) ignored every CodeGraph
reminder (0 of 4 followed, 1 CodeGraph call in 89). The user chose option B: keep the first-search
reminder, and block the NEXT code search of the same request once if the reminder was ignored. The
rule texts are the main fix; the block is the backstop.

## Specs

- **S1** — «igual como te dije los principal son las reglas». The orchestrator text
  (`lib/codegraph-prompt/orchestrator.md`) is rewritten as one imperative, "your first call is
  CodeGraph", with the single exemption (an exact string or a file path the user gave you). It no
  longer says «The other tools stay for what the graph does not index» nor «Its answer is a map».
  `generic.md` drops «when the task needs structure rather than a lookup». The paragraph about other
  checkouts is unchanged. `explore`, `verify`, `worker`, `fix` and `judge` are unchanged.
- **S2** — «y sacaria lo del bloqueo si no usa codegraph, pues para algunos no es necesario y
  limitaria/entorpeceria el trabajo. Como dije es reforzar/arreglar reglas». Option B's block of the
  second search was built and REMOVED: nothing blocks. Guard 2 keeps its first-search reminder, for
  the primary session only.
- **S3** — «en los hijos el recordatorio esta demas, pues son efimeras» / «es mas que nada
  guards/recordatorios para orchestrator». Guard 2's reminder belongs to the primary session alone;
  children and `review-*` agents hear no CodeGraph reminder.
- **S4** — «esos 2 sacalos de los hijos, pues son acciones de orchestrator». The `bash` worktree guard
  and the `edit`/`write` guard no longer judge a subagent child (`GENTLE_PI_AGENTS_CHILD=1`); the
  primary session is judged as before. The skill-read guard and the whole-read rule are untouched.
- **S5** — Invariants 21 and 22, `docs/reference.md`, `docs/codebase/mental-model.md` and the README say so.

## Tasks

- [x] T1: rule texts and their pins (S1).
- [x] T2: guard 2 is the primary session's alone, with tests (S3).
- [x] T3: the two worktree guards skip a child, with a test (S4).
- [x] T4: invariants, reference, mental model and README (S5).

## Log

- **L1** — «aplica los fix a nuestros plugin para lo de codegraph».
- **L2** — «que consideras mejor? ten en cuenta que muchos bloqueos igual trae costo» → «adelante,
  vamos con B».
- **L4** — «y sacaria lo del bloqueo si no usa codegraph … Como dije es reforzar/arreglar reglas»
  (the block of option B is removed).
- **L3** — «igual como te dije los principal son las reglas / y revisa/diferencia orchestrator de
  cada agente, a cual le pertenece el guarda».
