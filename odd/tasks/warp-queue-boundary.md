# warp-queue-boundary — a queued warp takes effect at the boundary a queued message does

A `/warp` typed mid-run must queue and take effect when the current
step finishes (the running tool, or the thinking before the next call) — not when
the whole run ends and not when the human stops it. Its queue line is one brief
fixed row above the editor, never a log.

## Specs

S1. «que se encola y lo manda cuando el agente termina el proceso actual, la tool
o acción que está realizando, como una bash o thinking, no que espere a que se
detenga». Concretely: the pending warp takes effect at the SAME boundary Pi uses
for a queued input message — after the current assistant turn finishes executing
its tool calls, before the next LLM call. Implemented on the host's `turn_end`
event: while a warp is pending and the only thing still blocking it is the run
itself (no tool executing, no running/queued agent task, no active job), the
extension calls `ctx.abort()` ONCE for that record so the run ends at that
boundary and the queued warp can move. The abort is per-record and bounded (a
record never aborts twice, and a record that still has real workload pending does
not abort at all), so a refused dispatch can never spin the session.

S2. The dispatch is never attempted into a streaming host. The queue dispatches
only when the host reports idle (`ctx.isIdle() === true`, read through a seam the
record holds). Today a tick fires mid-stream, `pi.sendUserMessage` rejects with
"Agent is already processing", the host swallows that rejection, the record marks
itself dispatched and its `dispatching` guard suppresses every later tick,
including the `agent_settled` one — the request then sits until the 30-minute
expiry. A dispatch that cannot be accepted must leave the record pending and
re-armed.

S3. «el mensaje de cola de warp está mal ... tiene que ser como steering de los
mensajes input, que está ahí arriba en un punto fijo y es algo muy breve no un
log». The one queue line is `Queued: warp <name> — waiting for <the work>`: one
row, dim, fixed in the zone above the editor, cut to the terminal width. It never
carries the unknown-job clause, a path dump, an expiry budget or any other
second sentence. «sin esto de alt up claro, aquí no aplica, solo puede haber
encolado un warp»: no `Alt+Up` hint, no editing affordance — one warp at a time.

S4. The queued front's transcript line is the SAME one brief sentence — no
`queue: …` second line, no `;`-joined notice. The unknown background-job state
(S4/S6 of `warp-idle-gate`) is disclosed only where it still matters: the expiry
notice, which says nothing moved and names the unreadable job state. The queued
line never claims a move and never claims the session is idle.

S5. «si no es posible lo dejas como un mensaje como ese "restored 2.." un mensaje fijo para que sepa que se va a realizar el warp pero esta en espera, en caso de que el punto/componente fijo en la tui no se pueda». The zone above the editor is the primary surface; when the host offers no such seam (`ctx.ui.setWidget` absent or throwing), the queue falls back to ONE fixed transcript entry — `pi.appendEntry` plus a registered entry renderer, the same durable shape Pi uses for its own `restored N messages` line — carrying the same one-line text. The fallback is one line, painted once per record, never a second line per poll, and it never claims the move happened.

S6. Everything else about the queue is unchanged: one pending record per
session, a second warp refused with the existing refusal text, the pending one
never replaced, the row painted at queue time and cleared on the dispatch and on
every terminal outcome (moved, refused, cancelled, expired, shutdown), unknown
blocks nothing, an idle session still moves immediately with no queue and no row,
and every timer stays unref'd.

S8. «Si aparecio el texto arriba de input fijo, correcto eso, pero como se ve en la imagen dejo uno igual en el chat, esta denas eso, es duplicar el missmo mensaje». The queue speaks through ONE surface per request: the fixed row above the editor (or its durable fallback entry). When that line was shown, the command emits NO transcript line and no notice — no second copy of the same sentence in the chat, on any success path.

S9. «intento ejecutarlo cuando termino la call, esta bien, pero tiro error ... no me pregunto si copiar los cambios ... hay un bug en el punto para crear o se salto el paso de copy». A carrying copy that the destination refuses (its own version of a file conflicts, a path cannot be proven identical, nothing was copied) never blocks the move: the warp proceeds WITHOUT copying, overwrites nothing, and says so in ONE line naming the copies it could not carry. The error path is not the answer — the human asked to move — and a copy that could not happen is disclosed, never silently dropped and never turned into a failed warp. When nothing was copied the destination is untouched, so moving on is always safe.

S11. «no me salio el panel preguntando si copiaba o no, hay que reviosarlo». The copy question can never be answered by a keystroke the human did not mean for it: the picker opens with the NON-destructive choice focused (`NO COPY`) and drops every input event that arrives inside a short grace window after it mounts, so a buffered or double-tapped Enter (submitting the command, or queueing a follow-up message while streaming) cannot answer it. The panel only finishes on a keypress the human makes after they could have seen it; Esc still cancels, and the safe choice stays the default. This applies to the copy question on both fronts that own it (the `/warp` front and the create flow).

S13. «el operation aborted es necesario para que ejecute el warp? ... eso lo hizo el plugin, no yo». The boundary abort must not cut a provider request: it happens the moment the turn ends — synchronously, before any read — so nothing is streaming when it lands. An abort that runs after an awaited activity read fires into the next request, the host cuts an assistant message that already carried tool calls, and every one of those tool cards is repainted as a red `Operation aborted` result (`dist/modes/interactive/interactive-mode.js:3383-3394`). Waiting for work that is really running still wins over aborting: the record's last sampled activity decides, and the awaited re-read is a fallback that blocks, never a step before the abort.

S15. «probemos con b», after «pero podemos hacerlo que sea como la tool de antes? pero que en realidad no sea un tool que ve y usa agente sino un comando que hacemos nosotros?». The pending warp reaches the agent the way the old `worktree_warp` tool did and the way a queued message does: the AGENT ends its own run, instead of the extension cutting it. At the `turn_end` where the run itself is the only blocker (S1's condition) AND the turn that just ended executed tools (`event.toolResults.length > 0` — a turn that ended with no tool results is the agent's final answer, the run settles on its own, and nothing is steered or aborted), the extension sends ONE hidden steering message per record: `pi.sendMessage({ customType, content, display: false }, { deliverAs: "steer" })`, delivered before the next model call, telling the agent a session move is waiting, to finish the step it is on, start no new tool calls and end its turn with one short sentence. The abort of S1/S13 stays as the SAFETY NET only: at a LATER `turn_end` of the same record, if the agent kept executing tools despite the message (`toolResults.length > 0` again), the extension aborts ONCE, synchronously, exactly as S13 requires. Every guard of S1/S13 holds for both steps: real work (tool in flight, running or queued agent task, active job) pending means neither a message nor an abort; one message and one abort per record, never twice; a host without `pi.sendMessage` falls straight to the abort; nothing the extension sends is ever shown in the chat (`display: false`, so S8's one-surface rule holds) and the row above the editor stays the only visible queue line.

S16. `AGENTS.md` invariant 15 and `README.md` follow: the invariant names the
boundary (the run ends at the current turn's end when the only blocker is the
run), and the README sentence that describes a queued warp matches it.

S17. «no funcionó bien, el agente no se detuvo, tuve que abortar yo manual para que ejecutara el warp». S15 (the hidden steering message) is SUPERSEDED and removed: the agent is never asked to stop, because a model may ignore the instruction and the safety net of S15 could only fire at a LATER `turn_end` with tool results, which never comes when the model answers with text instead of calling a tool (L16). The abort of S1/S13 is again the ONLY mechanism that ends the run at the boundary: at the first `turn_end` where the run itself is the only blocker and the turn that just ended executed tools (`event.toolResults.length > 0`), the extension aborts ONCE, synchronously, before the next provider request exists, exactly as S13 requires. Nothing is sent to the agent: no steering message, no custom message, no instruction text. Everything else of S1/S13 holds: real work pending (tool in flight, running or queued agent task, active job) means no abort; an idle host means no abort; a turn with no tool results is the agent's final answer, nothing is aborted and the settle tick dispatches the move; one abort per record, never twice.

S18. `AGENTS.md` invariant 15 and `README.md` follow S17: they no longer mention a steering message, a steered latch or a safety-net abort; the turn boundary is the one synchronous abort.

## Tasks

| ID | Specs | Route | What |
| --- | --- | --- | --- |
| T1 | S2 | inline | The queue dispatches only into an idle host, and a dispatch that could not be accepted stays pending and re-armed. |
| T2 | S1 | inline | The `turn_end` boundary: abort once per record when the run is the only blocker, so the warp lands at the queued-message boundary. |
| T3 | S3, S4 | inline | One brief row and one brief transcript line; the unknown-job clause moves to the expiry only. |
| T5 | S5 | inline | The fallback: one fixed transcript entry, through `appendEntry` plus an entry renderer, when the host cannot paint the row. |
| T6 | S8 | inline | One surface per queued request: no transcript copy of the line when the row or its fallback was painted. |
| T7 | S9 | inline | A refused carry-copy moves without copying, overwrites nothing, and discloses it in one line. |
| T8 | S11 | inline | The copy question cannot be answered by a stray Enter: `NO COPY` focused by default plus an input grace window, on both fronts. |
| T9 | S13 | inline | The boundary abort lands between requests: synchronous, before any awaited read, never cutting a provider request. |
| T10 | S15 | inline | SUPERSEDED by T11: the agent ends its own run via a hidden steering message. Removed. |
| T11 | S17, S18 | inline | Remove the steering message and everything that exists for it; the first boundary aborts once, synchronously, and nothing is ever sent to the agent. Docs follow. |
| T4 | S1-S7 | inline | Tests drive `/warp` end to end: queued mid-run, it moves at the turn boundary without a manual stop; a streaming host never marks the record dispatched; the long `queue:` clause is gone. Docs follow. |

## Log

L1 (user, verbatim): «gracias. el primer com vez, primer la alterna es muy extensa no se parece al ejemplo que dijimos, parece log, ademas no fucniono mira, denuevo tuve que pararlo yo para que funcionara»

L2 (user, verbatim): «el otro es que pareciera que me cambia la rama aunque se supone que sigo en main, pero en herdr y lazygit me sale que cambio tras hacer el warp asi que nose si es error plugin de herdr/lazygit, estoy en main aca?»

L3 (user, verbatim): «revisate agente pi, como funciona cuando mando mensaje? te dije que funcionara asi, que se encola y lo manda cual el agente termina el proceso actual, la tool o accio nque esta realizando, como ujna bash o thinking, no que espere a que se detenga. Igual el mensaje de cola de warp esta mal, porque te dije que fyera como sterring de los mensajes input, que esta ahi arriba en un punto fijo y es algo muy breve no un log»

L4 (user, verbatim): «sin esto de alt up claro, aqui no aplica, solo puede haber encoado u nwarp»

L5 (evidence, explore): the poller ticks every 2 s with no host-idle sample, so its first tick after the run started dispatched into a streaming host; `sendUserMessage` threw `"Agent is already processing"` in the host, which only surfaced as an extension error, while `dispatchWarpHandoff` had already returned `{ok:true}` — the record stayed `dispatching`, every later tick (including `agent_settled`) re-armed instead of dispatching, and only the human's stop unblocked it. `ctx.tools`/`ctx.executeTool` are absent on command contexts, so `job_list` is genuinely unreadable from the `/warp` front — the reason the long clause always appeared there.

L6 (answer to L2, no code change): the session is on `main`. `git worktree list` shows `~/dev/projects/odd-worktree [main]` and `git branch --show-current` is `main`; the `warp-odd-picker` checkout is a separate worktree on `feat/warp-odd-picker`. What herdr/lazygit show is a pane/root that still points at that worktree (Gentle Shell's session-worktree registry is append-only and repo A registers a checkout but never unregisters one), not a branch the warp changed. Out of scope for this feature; recorded here as evidence.

L7 (user, verbatim): «funciono bien en parte, pero 2 detalles. Si aparecio el texto arriba de input fijo, correcto eso, pero como se ve en la imagen dejo uno igual en el chat, esta denas eso, es duplicar el missmo mensaje. lo otro es que intento ejecutarlo cuando termino la call, esta bien, pero tiro error. Por lo que vi no me pregunto si copiar los cambios, nose si fue eso o algo mas. Parece que el sistena esta bien, pero hay un bug en el punto para crear o se salto el paso de copy»

L8 (evidence, parent): the duplicate is `ctx.ui.notify(queuedLine, "info")` in the queued branch — the row and the notice print the same sentence. The error is `lib/worktree-changes.js:1032` (`the pending change conflicts with the destination's own version of …`, nothing copied), surfaced through `failAfterCopy` as a failed warp: the handoff carried `changes: all` and the destination worktree sits on another commit, so its own copies of `AGENTS.md`, `README.md`, the extension, the lib and the suite differ from the source's base — a conflict that repeats on every attempt, which makes a failed warp the only outcome of a stale copy request.

L9 (user, verbatim): «igual como te digo, no me salio el panel preguntando si copiaba o no, hay que reviosarlo.» — plus the approved rule for the refused copy: «eso me parece perfecto que se mueva igual, si no puede copiar por conflictos no lo haga pero que se mueva».

L10 (evidence, explore): the copy question mounts with the cursor on item 0, `YES COPY` (`lib/warp-create-picker.js:748-763`, no `initialSelected` passed by `askWarpDirtyChoice`), takes keyboard focus at mount even while the session streams (`showOverlay` → `setFocus`), and its Enter branch finishes with the focused row and no second confirmation (`lib/warp-create-picker.js:866-872`). A single stray or buffered Enter — the one that submitted `/warp`, a double-tap, or one meant to queue a message — therefore answers `YES COPY` with no visible interaction. No auto-confirm, no remembered selection and no headless resolution exists (`ctx.ui.custom` resolves only through the component's `done()`; without a custom UI the code answers `no`).

L11 (user, verbatim): «ya funciona, pero una dua, el operation aborted es necesario para que ejecute el warp?» then «eso lo hizo el plugin, no yo».

L12 (evidence, parent): the abort is ours (`ctx.abort()` in the `turn_end` boundary), and it shows up as a red `Operation aborted` because it lands too late. `turnBoundaryStep` awaits `record.deps.read()` (presence read + `job_list` probe) BEFORE aborting, so the next provider request has already started: Pi cuts an assistant message carrying tool calls and repaints each of its tool cards as a failed `Operation aborted` result (`dist/modes/interactive/interactive-mode.js:3383-3394`). An abort that lands between requests cuts nothing.

L13 (correction of L5/S2, parent, evidence): the mechanism recorded in L5 and in S2 is wrong in one detail. `sendUserMessage("/warp @token", { expandPromptTemplates: true })` does NOT throw "Agent is already processing" while the host streams: `AgentSession.prompt` tries the extension command FIRST (`expandPromptTemplates && text.startsWith("/") && await this._tryExecuteExtensionCommand(text)`) and only reaches the streaming check for text that is not a command. The command handler therefore runs immediately, passes the busy check as a retry (`hostIdle` is not re-read there), and parks in `await ctx.waitForIdle()` until the WHOLE run settles. That is what the human saw — the warp moved only after they stopped a long run — and the old `worktree_warp` tool worked the same way: it dispatched the command, the handler parked in `waitForIdle`, and the move landed when the agent, having called the tool, ended its own turn. The idle gate in the queue's tick still avoids parking a handler on a live run, but its rationale is "do not park", not "the host would reject". The turn-boundary abort is what moves the landing point from "end of the whole run" to "end of the current call". Docs and comments that say the host rejects the dispatch must be corrected (AGENTS.md invariant 15, lib/worktree-warp-busy.js header, extensions/odd-worktree-tools.ts comments).

L14 (user, verbatim): «pero podemos hacerlo que sea como la tool de antes? pero que en realidad no sea un tool que ve y usa agente sino un comando que hacemos nosotros?» then «probemos con b».

L15 (evidence, parent): the host offers no native stop at a boundary — the `turn_end` result is `{ entries?, continue? }` and `continue: false` never suppresses natural work (`docs/extensions.md:748`) — so the choices were: wait for the whole run (the old tool's landing point), tell the agent to stop (B), or abort (C). `pi.sendMessage(message, { deliverAs: "steer" })` is the host's own queue channel: the message is delivered after the current turn's tool calls and before the next model call, and custom messages take part in the model context while `display: false` keeps them out of the chat. `TurnEndEvent.toolResults` tells whether the turn that just ended executed tools (`dist/core/extensions/types.d.ts:849-855`): with none, the turn was the agent's final answer and the run settles by itself.

L16 (user, verbatim): «no funciono bien, el agente no se detuvo, tuve que abortar yo manual para que ejecutara el warp»

L17 (evidence, parent, from the human's test session `2026-11-14T18-49-42-928Z_01a1db64-dd10-75e3-aa14-ff8dfc4ef36c.jsonl`): the steering message WAS delivered and the model ignored it. Entry 16 (18:50:05.389) is the hidden `worktree-warp` message (`display: false`) with the one-sentence instruction; entry 17, whose parent is that message, is the model's next assistant message — a 1,112-character summary of the project written in full ("Estábamos en tres frentes…"), not one short sentence — and it ends `stopReason: "aborted"` at 18:50:09.458, four seconds later, which is the human's manual abort. The turn after the steer was TEXT ONLY, so no `turn_end` with tool results followed and the S15 safety net had nothing to fire on. The design flaw is structural: an instruction to a model is probabilistic, and the net behind it required a second tool-using boundary that the likely failure (the model answering instead of calling a tool) never produces. Aborting at the FIRST boundary is deterministic and, landing before the next request exists, cuts nothing in flight; a timer-based net behind the steer was rejected because it would cut the model's request mid-stream (time-to-first-token alone exceeds a short grace window) and paint the same red message.
