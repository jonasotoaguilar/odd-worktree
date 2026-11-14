# warp-settle-dispatch — a queued warp fires at the settle boundary

Make a `/warp` typed mid-run queue itself and run by itself when the host reaches
its idle boundary, and keep the queued row visible while it waits. Three fronts
change: the busy decision, the dispatch boundary, the tests.

## Specs

S1. A warp requested while this session is NOT idle is ALWAYS queued, never
   waited on. The busy decision is the host's own idle state
   (`ctx.isIdle()`, false while Pi is processing an agent run, an automatic
   retry, an auto-compaction retry or a queued continuation) OR any workload
   the counters already report (in-flight tool, agent task, background job).
   Consequence: "the assistant is still thinking" is busy, even though it has
   no tool executing and no job running.

S2. The command handler NEVER awaits the host. While busy it records the
   pending warp, paints the row, returns at once with the queued text, and lets
   the queue dispatch it. The handler's own text stays
   `worktree warp: handoff queued — waiting for … before the move` (built by
   `queuedText`), and the row stays
   `Queued: warp <name> — waiting for …` painted through `setWidget`
   (`odd-worktree-warp`, placement `aboveEditor`).

S3. The pending warp is dispatched at the settle boundary: an
   `agent_settled` handler ticks every pending record once, so the move starts
   as soon as the host settles instead of on the next poll. The dispatch itself
   stays `pi.sendUserMessage('/warp <token>', { expandPromptTemplates: true })`,
   which the host accepts from a settled handler and runs as a command.

S4. The boundary tick and the poller must dispatch ONE record at most once. The
   record's existing `dispatching` guard is the one lock: a tick that arrives
   while another dispatch is in flight returns without dispatching, and a record
   is settled on every terminal outcome (moved, refused, cancelled, expired,
   shutdown). A rejected dispatch keeps the record queued and re-arms the
   poller, as today.

S5. A second warp while one is pending is refused with the existing refusal
   text and never aborts the run: with no handler parked in a host wait, the
   second command returns its text immediately.

S6. Every existing behaviour the change does not name keeps working: an idle
   session still moves immediately with no queue and no row; the counters still
   block a warp while a background job or agent task runs after settle (the
   poller keeps polling); unknown job state still blocks nothing and is
   disclosed; expiry, cancellation and shutdown still clear the record and the
   row.

## Tasks

| ID | Specs | Route | What |
| --- | --- | --- | --- |
| T1 | S1, S2, S5 | inline | The command front: busy = not-idle OR counters; never await; queue and paint. |
| T2 | S3, S4 | inline | The `agent_settled` handler that ticks pending records once, guarded against a double dispatch. |
| T3 | S1-S6 | inline | Tests in `tools/warp-busy-guard.test.js` (and the command suite where the front is asserted), plus the README sentence that describes a queued warp. |

## Log

L1 (user, verbatim): "ya se arreglo lo de que warp pregunte altiro si copia o no,
pero hay otro problema y es que no lo encola o sea, espera a que este en idle la
sesion para ejecutarlo y dijimos que debe ser enseguida a apena termine la
tool/thinking actual, igual que la cola/espera de input/mesajes de pi. Y que
apareciera ahi arriba que esta en espera, pero no aparecio nada"

L2 (user, verbatim): "en ese punto lance warp, debio ejecturarlo tras termianr
esas bash enseguida. Pero lo hizo recien cuando te detuve"

L3 (user, verbatim): "y como se ve no salia nada de cola/espera"

L4 (user, verbatim): "algo asi, como los mensajes" (the `Steering: … / Alt+Up to
edit all queued messages` row above the editor)

L5 (user, verbatim): "y dejando solo uno, cualqueir warp mientras hay uno en
espera no se ejecuta ni encola, sale error en texto tipo "Operation aborted""

L6 (evidence, explore): mid-run the counters read zero (thinking is invisible),
so the request took the move path and parked in `await ctx.waitForIdle()`
(:3819) — no queue record, no notice, no row. The queued path, had it engaged,
could not fire mid-run either: `dispatchWarpHandoff` (:2473) sends without
`deliverAs`, which the host rejects while streaming. Docs: `agent_settled` is
the documented place where a command dispatch is accepted
(`docs/extensions.md:688-693`, `examples/extensions/reload-runtime.ts:59-62`);
`waitForIdle` has no deadlock of its own (`docs/extensions.md:1337-1347`).
