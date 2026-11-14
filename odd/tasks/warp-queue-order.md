# warp-queue-order — ask the copy question at request time, then queue

Goal: a `/warp` issued while this session still has tools, agent tasks or
background jobs asks the copy question once and is QUEUED right away — with the
steering row visible — instead of waiting up to a minute for the session to drain
and then asking the same question again on every attempt.

## Specs

- **S1** — «me preguntó lo de copiar cambios enseguida, en vez de ser de
  inmediato para encolar el warp». The pending-changes question is asked at
  REQUEST time, before the busy decision, and the answer travels in the queued
  handoff. The move never asks it a second time.
- **S2** — «hice 3 warp seguidos pero al terminar pasar a idle recién ahí me
  preguntó lo de copy y 3 veces por los 3 intentos, debería preguntar altiro así
  lo encola y los siguientes me tira error diciendo que ya hay uno pendiente».
  A busy session queues at once: the command front must decide queue-vs-move from
  the counters as it finds them and must NOT wait for them to drain. Attempt two
  and three are refused with the existing pending-warp refusal and change
  nothing.
- **S3** — «no me salió nada del steering». While a warp is queued its ONE
  persistent row is visible above the editor from the moment it is queued, and it
  is cleared on the dispatch and on every terminal outcome (unchanged contract,
  now reachable because the request really queues).
- **S4** — «debería usar el checkout actual tanto para worktree create del warp
  como para el warp». The changes summary, the question and the copy itself use
  the checkout the session stands in — never the principal/main checkout — in
  both the warp and the panel create's own pending-changes question. Pin this
  with a test; if a path really reads the principal, fix it there.
- **S5** — nothing else regresses: a queued warp never claims a move, the expiry
  notice and the queue record keep their behaviour, `skipDirtyPrompt` (a create
  that already asked) still suppresses the second question, and the host's own
  `ctx.waitForIdle()` still runs before anything is touched.

## Tasks

- **T1** ✅ — the command front: decide from the current counters, ask the copy
  question once at request time, queue immediately, and let the queued handoff
  carry the answer. Drop the wait-before-queue use. Tests: S1-S3, S5.
- **T2** ✅ — the copy source: pin that the warp and the panel create question both
  summarize the session's own checkout, and fix any path that reads the
  principal. Tests: S4. No path read the principal, so it is pinned only.
- **T3** ✅ — docs: README describes the ask-then-queue order and the steering row.

## Log

- **L1** — user: «encontré un bug, y es que hice warp pero no me salió nada del
  steering y me preguntó lo de copiar cambios enseguida, en vez de ser de
  inmediato para encolar el warp. Además hice 3 warp seguidos pero al terminar
  pasar a idle recién ahí me preguntó lo de copy y 3 veces por los 3 intentos,
  debería preguntar altiro así lo encola y los siguientes me tira error diciendo
  que ya hay uno pendiente.»
- **L2** — user: «lo otro es que acá no tengo cambios no sé por qué me preguntó,
  estaba en rama, ahora recién me moví a main, creo que intentaba copiar lo de
  main para crearlo pero recuerdo que lo habíamos cambiado para que el copy de
  warp sea en base al checkout actual... debería usar el checkout actual tanto
  para worktree create del warp como para el warp.»
- **L3** — user: «sí, investiga y fixea los errores que te reporté».
- **L4** — Diagnosis (parent): `performWorktreeWarp` awaited
  `warpWaitForIdleSession` (lib/worktree-warp-busy.js, `DEFAULT_WAIT_MS = 60000`)
  BEFORE reading the busy state. On a session with agent tasks or jobs the wait
  drained the counters, so the flow took the NOT-busy path, `warpQueuePending`
  never ran (hence no steering row), and `warpMaybeCopyDirty` asked the copy
  question after the wait — once per attempt, each cancel returning
  `worktree warp: <name> cancelled`. Evidence: `lib/worktree-warp-busy.js:80`.
- **L5** — Diagnosis (parent), S4: every source read found uses the session's own
  checkout (`dirtyFrom = warpDeepestContaining(...) || fromCwd` in
  `performWorktreeWarp`, `panelCwd = toolCwd(ctx)` for the create question,
  `fromCheckout` for the handoff copy). The reported `2 files, +199/-0` matches
  the two untracked `odd/tasks/*.md` docs present in the checkout that session
  stood in, so this is pinned by a test rather than rewritten.
- **L6** — Independent verification (gentle-ai-verify) found one regression the
  first cut introduced: `warpRequestActivity` went through the id-requiring
  `warpSessionActivityById`, so a session with no `getSessionId` skipped the tool
  counter and `job_list` and moved immediately. Baseline sampled both. Fixed: the
  request reads lib `sessionActivity({ sessionId, host })` with whatever id is
  available, still ONE read; two RED-first front tests and one lib-contract test
  pin it.
- **L7** — Not fixed, baseline-identical: the queued record's own poller read
  still goes through `warpSessionActivityById`, so in an id-less session the first
  tick dispatches and the re-run front re-queues, once per poll interval, until
  the work ends. Nothing moves and no counter is bypassed. Separate fix if
  wanted.
