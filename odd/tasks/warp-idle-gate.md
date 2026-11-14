# warp-idle-gate — a queued warp also waits while a tool of this session is executing

## Context

A queued warp waits for this session's running or queued agent tasks and for its
active background jobs. It does not wait for the primary session's own in-flight
work, so a handoff could land while a bash, a read or any other tool of the
session was still executing. The human's clarification (L1) is the rule: the
third blocking condition is "something is executing", not "the session is quiet"
and not a turn boundary.

The signal was investigated before it was used, and the exact pair is taken from
the host rather than guessed:

- Pi emits `tool_execution_start` and `tool_execution_end` for every tool
  execution in a session (`docs/extensions.md`: "A tool call that executes runs
  these hooks in order: 1. `tool_execution_start` … 5. `tool_execution_end`"),
  including the host's own `bash` and `read` tools, and every finalized call gets
  its `tool_execution_end` — "use `tool_execution_end` to observe every finalized
  call".
- `tool_call` / `tool_result` are **not** an exact pair: "Calls that do not
  execute end early … a blocked or aborted call skips execution and
  `tool_result`". A counter fed by that pair can be left with a `tool_call` that
  never gets a result, so the pair used here is the execution one.
- `ctx.isIdle()` is a whole-run signal (false while the model streams and during
  retries and compaction), broader than "a tool is executing", and it lives on a
  context the queue deliberately does not pin for 30 minutes.

## Specs

- **S1** — «The condition is: **nothing executing in this session** — a running
  bash tool, a running read, any tool at all. Not "the session is quiet", not a
  turn boundary. It should behave like a queued message: it waits for the running
  tool and then proceeds.»
- **S2** — «A counter of in-flight tools derived from that pair is the "something
  is executing" fact, and it covers bash.» The pair is the host's execution pair
  (Context); an execution with no matching end yet means busy.
- **S3** — «use that counter as the third blocking condition, alongside agent
  tasks and background jobs». Known-busy blocks; unknown blocks nothing and is
  never reported as idle.
- **S4** — «make sure your own dispatch does not count as busy (a warp must not
  block on itself), and say how you guaranteed that.» The dispatch is a slash
  command (`pi.sendUserMessage('/warp @<token>')`), not a tool, and the counter
  records top-level executions only — the queue's own `job_list` probe is a
  nested call inside a parent execution.
- **S5** — «if a tool result can be missed (a crash, a host restart), the counter
  must not wedge the queue forever — say what makes it recover, and if nothing
  does, bound it the same way the pending lifetime is bounded.» The counter is
  process memory: a restart starts empty, `session_shutdown` clears it, and a tool
  that really never ends is bounded by the pending record's own expiry, which
  notifies and clears.
- **S6** — «unknown still blocks nothing and is never reported as idle.»
- **S7** — the queue itself does not change: the pending record is still written
  at request time, a second warp is still refused, the pending one is never
  replaced, expiry still notifies, every terminal outcome still clears the
  record, the new condition is read by the same poller, an idle session never
  waits, and every timer stays unref'd.
- **S8** — «When a warp is pending — because an agent task, a job, or a tool is
  still executing — he wants to SEE it, in the zone **immediately above the
  input**, above the status area. His reference is Pi's own steering line; he
  wants the same logic, not the same implementation.»
- **S9** — what the human sees is ONE dim row in that zone, the shape Pi's own
  `Steering:` row has: `Queued: warp <worktree> — waiting for <the work>`. The
  label is the state and `waiting for …` is the reason, so it reads as a request
  standing in line and never as a finished move; the work named is the same
  phrase the queued notice prints. The row is one row by contract: on a narrow
  terminal it is cut with an ellipsis instead of wrapping into several lines.
- **S10** — the seam is `ctx.ui.setWidget(key, content, { placement:
  "aboveEditor" })`, which the host mounts between the status area and the
  editor, beside the `Working` spinner and never over it. It is painted when the
  record arms and again only when the poller's reason changes, and it is cleared
  on the dispatch and on every terminal outcome (refusal, cancellation, expiry,
  shutdown) — a row must never outlive its queue or claim a move that has not
  happened. The one-shot notice stays: the row is transient state, the notice is
  the durable record, and the duplication is intended. Nothing about it keeps
  the process alive.
- **S11** — the gate does not change: the three blocking conditions and the exact
  pair they read, one pending record per session, a second warp refused, the
  record never replaced, the pending lifetime bounded, and every terminal
  outcome clearing it (S7 restated for this task).
- **S12** — `AGENTS.md` invariant 15 no longer understates the rule: it names
  tools executing alongside agent tasks and jobs, and the persistent row, in the
  invariant's own voice and without renumbering anything.

## Tasks

- T1: record this session's in-flight top-level tool executions in
  `lib/worktree-warp-busy.js` from the host's `tool_execution_start` /
  `tool_execution_end` pair, registered by the one extension entry point (S2,
  S4).
- T2: read that count as the third condition of the one `busy` decision, before
  the queue's own host-tool probe, and name it in the queue texts (S3).
- T3: prove the boundaries: a nested call and the queue's own dispatch never
  count; a missed end cannot wedge the queue past the pending lifetime and
  `session_shutdown` clears the count; an absent signal blocks nothing (S4, S5,
  S6).
- T4: the tests drive `/warp` end to end — it waits while a tool executes, then
  moves once that tool ends — and the README and this document follow (S1, S7).
- T5: build the one row in `lib/worktree-warp-busy.js` (`pendingSteeringLine`)
  from the same workload phrase the queued notice uses, one line whatever the
  name carries (S9).
- T6: paint it through the extension's injected seam — a component factory that
  renders dim and truncates to the width the host offers — when the record arms
  and when the poller's reason changes, and clear it on the dispatch and on every
  terminal outcome (S8, S10).
- T7: prove the lifecycle through the public surface: the row appears while a
  tool executes, is not repainted while the reason holds, survives a refused
  second warp, and is gone on the dispatch, on a refused handoff, on expiry and
  on shutdown, while an immediate move never paints one (S10, S11).
- T8: `README.md`, `AGENTS.md` invariant 15 and this document follow (S12).

## Log

- **L1** — «The condition is: **nothing executing in this session** — a running
  bash tool, a running read, any tool at all. Not "the session is quiet", not a
  turn boundary. It should behave like a queued message: it waits for the running
  tool and then proceeds. And there is already a real signal for exactly that,
  which you likely dismissed as partial: this extension registers `tool_call` and
  `tool_result` hooks, and those fire for **every** tool in the session, not only
  this package's. A counter of in-flight tools derived from that pair is the
  "something is executing" fact, and it covers bash. So: use that counter as the
  third blocking condition, alongside agent tasks and background jobs; a
  `tool_call` with no matching `tool_result` yet means busy; make sure your own
  dispatch does not count as busy (a warp must not block on itself), and say how
  you guaranteed that; if a tool result can be missed (a crash, a host restart),
  the counter must not wedge the queue forever — say what makes it recover, and
  if nothing does, bound it the same way the pending lifetime is bounded; unknown
  still blocks nothing and is never reported as idle. If you find a better
  host-native signal than the hook pair while looking, take it and say why.»
- **L2** — «When a warp is pending — because an agent task, a job, or a tool is
  still executing — he wants to SEE it, in the zone **immediately above the
  input**, above the status area. His reference is Pi's own steering line; he
  wants the same logic, not the same implementation.»
