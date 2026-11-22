# agent-rule-reminders — rules and reminders that weaker models stop skipping

Goal: the worktree rule and the CodeGraph rule are skipped by weaker models. Rewrite two
rule texts, let the CodeGraph reminder repeat, and refuse an `edit`/`write` into the
primary checkout on the default branch with a one-line reminder. Nothing else changes.

## Specs

- **S1** — «Every write goes in a worktree, whatever the size of the task, a one-line fix
  included. Never write in the primary checkout or on the default branch. Before your
  first `edit` or `write`: 1. Run `worktree_list`. 2. If the ODD has a worktree, work
  there. 3. If not, run `worktree_create` (`copy_changes: true` if you already changed
  files here). Reading anywhere is fine; a request that only reads needs no worktree.»
  The first two paragraphs of `lib/odd-prompt/odd-worktrees.md` say this and no longer
  say "An ODD"; every later paragraph is byte-identical.
- **S2** — «Before you `grep`, `rg`, `find`, `read` or `cat` to answer where code lives,
  who calls it, how it works, or what a change reaches, call CodeGraph first: `codegraph`
  with `operation: "explore"` and `query: "<symbols or the question>"` … `operation:
  "query"` only to find where one symbol is defined. Skip it only for an exact string or a
  file path the user gave you.» `lib/codegraph-prompt/orchestrator.md` has one exemption
  and one literal call; its worktree/checkout paragraph is unchanged. `generic.md` drops
  to one exemption. `worker`, `fix`, `verify`, `judge`, `explore` are unchanged.
- **S3** — «sólo el recordatorio de la primera búsqueda de cada mensaje» (the 8-search
  repeat and the cap of 3 are dropped, L4; they were «vuelve cada 8 búsquedas seguidas
  sin usar codegraph … máximo 3 veces»). Guard 2 reminds on the first search of a checkout
  while CodeGraph is unused, once, exactly as before the repeat was added; the sentence no
  longer ends in ", if it applies". It stays advice: it never blocks. Guard 1 and every
  other behaviour are unchanged.
- **S4** — «Guard de `write`/`edit`: si el archivo está en el checkout principal y ese
  checkout está en `main`, lo frena con una sola línea: "`<path>` is in the primary
  checkout on `main`. Work in a worktree (`worktree_list` / `worktree_create`)."» An
  `edit` or `write` whose `path` lies inside the principal checkout while that checkout is
  on the repository's default branch is blocked with exactly that sentence (the real path
  and default-branch name in it). **Only a path inside the same repository as the
  session's cwd is ever judged (L2):** a path outside every git repository, a path under
  the OS temp directories (`TMPDIR`, `/tmp`, `/var/tmp`) even when a scratch repo lives
  there, a path in another repository, and a path in a linked worktree all pass, as do an
  unreadable identity, a session cwd outside version control, a detached HEAD and another
  branch. It never throws and `ODD_WORKTREE_GUARD=0` turns it off with the bash guards.
- **S5** — «Hijos: "Work in your workspace root's worktree; if it is the primary on
  `main`, stop and report" … sólo para `gentle-ai-worker`, `jd-fix-agent` y los agentes
  genéricos … No la pongo en explore, verify ni los jueces.» The `## ODD worktrees` block
  reaches a child only for those three kinds, with one line of text; the primary
  session's block is unchanged and a `review-*`, explore, verify or judge child gets none.
- **S6** — «Hay que enmendar la invariante 21 … y la 22» `docs/codebase/invariants.md`
  (21, 22, 14) and `docs/reference.md` describe the new behaviour; the suites pin the old
  texts and are updated, and `npm test` passes.
- **S7** — «de eso solo B parece bien» (B: «Reinicio por request … cada prompt nuevo vuelve
  a tener recordatorio»). Each new request (`before_agent_start`) forgets guard 2's
  first-search slots (`own`) and its `used` flag, so the first search of every request,
  while the graph is unused in it, earns a reminder again. Guard 1's slots and the explored
  checkouts stay per session; a compaction or a new session still forgets everything;
  nothing else changes and it stays advice. A, C, D and E from the review of gentle-shell
  are NOT part of this.

## Tasks

- [x] T1: texts for S1, S2 and their test pins (S1, S2). Commit 1147d2c.
- [x] T2: the CodeGraph reminder repeats, with tests (S3). Commit f90ca1a.
- [x] T3: the `edit`/`write` guard and the child block, with tests (S4, S5). Commit 8001db1; verifier fixes (`@` prefix, live owner read, temp-portable suite) in the closing commit.
- [x] T4: invariants and reference follow (S6). Commit e250099 and the closing commit.
- [x] T5: guard 2 forgets its row, cap, slots and `used` flag at each new request, with tests, invariant 21 and the reference (S7). Commit: the closing commit of this ODD.
- [ ] T6: drop the 8-search repeat and the cap of 3: guard 2 reminds once per checkout per request, with tests, invariant 21, the reference and the README (S3, S7).

Slice boundary: ~1.3k changed lines across four commits, each one reviewable alone (texts; reminder; guard; docs).

## Log

- **L1** — «no entiendo bien la propuesta, que cambios exactos serian» … «3 no lo tengo
  claro, y 4 diria que basta con decir que trabaje en worktree, son recordatorios no
  copia de la regla que ya tiene» … «bien, implementa los cambios». Decision answered by
  the human: the `edit`/`write` guard **blocks**, with a short message.
- **L2** — «ten en cuenta ruta que no son git para guards no bloqueen, como tmp entre
  otras». Non-git paths, the OS temp directories and other repositories never trip the
  new guard (S4); no guard of this change blocks on a path it cannot place in the
  session's own repository.
- **L3** — «de eso solo B parece bien» after the review of gentle-shell's
  `exploration-budget` (steer notice per request). Only B (per-request reset) is authorized.
- **L4** — «que consideras, tampoco queremos saturar el contexto con el mismo mensaje de
  recordatorio» … «bien, adelante» (after the recommendation: drop the repeat, keep only
  the first search of each message, with the per-request reset). S3 is rewritten, S7 loses
  its row and cap, T3 of the reminder (T2/T5) is reopened as T6.
