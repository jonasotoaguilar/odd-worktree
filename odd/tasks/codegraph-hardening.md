# codegraph-hardening — the useful backlog from the gentle-shell CodeGraph PRs

Four behaviors taken from gentle-shell PRs #3305-#3315 (compared against this package's own CodeGraph
work), plus the host-contract tests that came out of the startup audit that opened this work.

## Specs

- **S1** — «deberia ser asincrono claro para que no retrase el arranque de la sesiones o cambio entre
  ellas». No lifecycle handler hands the host a promise it would await: `session_start`,
  `session_compact`, `before_agent_start` and `session_shutdown` return `undefined`, and `tool_result` is
  the one handler that answers with a promise, whose only host-visible wait is the bounded post-init race.
  Two tests pin it: the handler-return inventory, and the proof that the async work a synchronous handler
  starts still runs after it answered.
- **S2** — «Unirse al refresh en vuelo antes de query/explore (#3315)». Before a CodeGraph search runs,
  a refresh already in flight for that checkout is awaited, never a new one started: a search that arrives
  while an init, sync or seed writes the index waits for it (bounded), and no work in flight adds no
  latency. The wait never fails the tool call and never exceeds its budget.
- **S3** — «Validar el seed antes de publicar el db (#3307) — hoy publicamos y sincronizamos después». A
  seeded index is kept only when the post-seed sync succeeded; a copy that is not a real CodeGraph index
  is never published; a failure removes only what this session created and leaves an index another session
  accepted untouched.
- **S4** — «"exposure": "direct" en la entrada codegraph de mcp.json (#3312) — un campo, chequeo barato».
  Resolved against Pi's own documentation, not against the PR's spelling: direct callability is the
  per-tool `toolExposure` map (`docs/mcp.md`, "Control tool exposure" — "`toolExposure` overrides the
  server exposure for individual tools"), which `CODEGRAPH_SERVER` already writes as
  `{ codegraph_explore: 'direct' }`. No entry-level `exposure` is written, a value the user set is never
  overwritten, and a test pins the documented shape with its citation so a future upstream-shaped "fix"
  cannot rewrite it.
- **S5** — «Nonce de release del lock + escalado SIGTERM→SIGKILL (#3306)». A release clears a lock only
  when this session still holds the token it acquired, so a holder whose lock was taken over never undoes
  the takeover. A child that ignores SIGTERM past the grace period is escalated to SIGKILL, and a run
  that needed the escalation still reports the timeout, not a success.

Standing constraints: every collaborator stays injectable, no handler throws into the host, and the
package's whole suite stays green.

## Tasks

- **T1** — S1 — inline — `3e955ad`.
- **T2** — S4 — writer (`lib/codegraph-mcp-config.js`, `tools/codegraph-mcp-config.test.js`) — `4bb1fb5`.
- **T3** — S5 lock identity — writer (`lib/codegraph-lock.js`, `tools/codegraph-lock.test.js`) — `9f1e1f7`.
- **T4** — S3 seed publish-or-rollback — writer (`lib/codegraph-index.js`, `tools/codegraph-index.test.js`) — `c48a5e3`.
- **T5** — S5 kill escalation — writer (`lib/codegraph-index.js`, its suite), after T4 — `9f1e1f7`.
- **T6** — S2 the bounded join on the pre-execution hook — writer (`lib/codegraph-session.js`,
  `lib/codegraph-edit-sync.js`, their suites) — `e74b3fa`.
- **T7** — independent verification of the item-4 work (S5) — the pre-commit attempt was blocked by the
  verifier's commit-bound rules (L13); the post-commit pass ran in an ordinary single-root clone (L14) and
  its five findings were fixed in `e9c1b1c` (L15, L17).
- **T8** — docs: `README.md`, `docs/reference.md`, and the two new invariants with their counts — `c7a1f2c`.
- **T9** — S5, found while closing T3: `releaseLease` treats an unreadable or missing `owner.json` as
  "mine" (`lib/codegraph-lock.js:398-406`), so a stale holder whose read lands inside another session's
  `mkdir run/` → `owner.json` window can delete that fresh lease. The init lock is already fail-closed
  (`if (owner && owner.token === mine.token)`); the lease must be too, while an abandoned lease older
  than `UNWRITTEN_GRACE_MS` stays reclaimable. — `9f1e1f7`.
- **T10** — differential over the shared `runCodegraph` (compaction's default `run`) — evidence in L12.
- **T11** — the verifier's findings: the uncapped join on a throwing delay, the escalation override that
  could never fire, and the four weak tests — `e74b3fa` (S2 cap), `9f1e1f7` (clamp), test hardening in
  `e9c1b1c`'s parent round.
- **T12** — the verifier's two post-commit findings: S3 rollback ownership and the S2 compaction join —
  `e9c1b1c`.
- **T13** — the residual the previous round flagged: an EEXIST at the seed's creation step must not
  publish over another actor's index — `e9c1b1c`.
- **T14** — the third pass's residual: an unreadable identity must never read as equal or as absent — `ff5cf01`.
- **T15** — the fourth pass: attack the three-valued identity at runtime — no findings; accepted in L20.

## Log

- **L1** — user: «Lo que si cambiaria o revisaria es el session start hace un codegraph sync creo (o era
  idex?) nose si es sincricrono o asincriono, deberia ser asincrono claro para que no retrase el arranque
  de la sesiones o cambio entre ellas».
- **L2** — Evidence (read-only audit): `lib/codegraph-session.js:156,170` registers `session_start` and
  ends in `void startSession(event, ctx)`, so the host awaits nothing; `prepareProject`
  (`lib/codegraph-index.js:577`) decides seed/sync/init and runs the CLI detached (init 600 s, sync 120 s,
  kill grace 10 s); `worktree_create` and the `/warp` create panel contain no CodeGraph code at all; the
  only host-visible await is `tool_result` → `syncAfterNativeInit`, bounded by
  `POST_INIT_SYNC_WAIT_MS = 10_000` and only after a successful native `codegraph init`.
- **L3** — user: «bien, implementa ahora el backlog util que detectaste».
- **L4** — Decision: S2 is implemented on the pre-execution hook only if the host awaits that hook's
  handlers; if it does not, S2 is dropped with that evidence instead of being faked in the prompt.
- **L5** — Decision: S3 keeps upstream's invariant ("nothing published survives a failed validation")
  without upstream's staging project: our seed writes into the worktree's own `.codegraph`, so the
  publish-or-rollback boundary is that directory and the ownership rule is "only what this session
  created".
- **L6** — Evidence that re-scoped two specs before any code was written: the release nonce S5 asked for
  already exists (`lib/codegraph-lock.js:232-235` compares `owner.token`, and `releaseLease` at :398-406
  does the same), so T3 is the missing negative proof, not a new mechanism; and the "exposure" field S4
  took from #3312 is not the shape this package writes — `CODEGRAPH_SERVER` already carries
  `toolExposure: { codegraph_explore: 'direct' }`, so T2 decides from Pi's own `docs/mcp.md` instead of
  trusting the upstream claim.
- **L7** — Evidence for S2's feasibility: `tool_call` is awaited by the host before the tool runs
  (`docs/extensions.md:363-367`, :977) and, per :3253, an error in it blocks the tool — so the join must be
  unable to throw and unable to run long, and `tool_call` joins `tool_result` as a handler that may answer
  with a promise.
- **L15** — The two failures L14 named are fixed, and the fixes were accepted against the verifier's own probe
  suite (rebuilt from its report at `/tmp/cg-verify/tools/verifier-codegraph.test.js`, functionally
  equivalent, 20 cases): before 17/20, after 20/20. S3's rollback now proves ownership instead of inferring
  it: the seed proves it created `.codegraph` with a non-recursive mkdir, captures the directory's and the
  published database's device+inode, and removes nothing whose identity differs (an unreadable stat fails
  closed). A differential against `c7a1f2c` over the shared `seedWorktreeIndex` caught one drift the first
  draft introduced — a worktree root that does not exist yet — so the recursive mkdir of `.codegraph`'s
  parent stayed and the re-run was byte-identical. S2's compaction sync is now tracked, so a search joins it
  under the same budget.
- **L16** — Residual closed at the parent's direction: an EEXIST at the seed's creation step means another
  actor created the directory in the window, and publishing into it would overwrite an index that session
  accepted — worse than removing it, which S3 already forbids. The path now writes, syncs and removes
  nothing, and reuses only shapes the module already has: a directory that already holds an index reports
  the existing joined shape, while a bare directory is an honest failed seed — the split is forced by the
  verifier's own created-after-recheck probe, which requires `ok: false` for a foreign directory holding
  no index.
- **L20** — Fourth pass on `1840617`: **no findings**. The first attempt was blocked by verification
  infrastructure, not by the code — the helper requires an empty scratch under the system temp, while the
  session exports a `TMPDIR` outside it and `NODE_COMPILE_CACHE` populates the scratch before the emptiness
  check; running the preparation as `env -u NODE_COMPILE_CACHE -u NODE_OPTIONS TMPDIR=/tmp …` is what makes it
  work, and that is worth remembering for the next independent pass in this environment. Result: 67 distinct
  runtime tests, 0 failures, covering EPERM/EIO/EBUSY/EACCES and uncoded throws, missing/partial/null/NaN
  identities, unknown at capture versus at rollback, the positive-ownership and ENOENT rollback controls, 20
  abandon-path combinations, and creation-step joining through both `autoIndex` and `seedLinkedWorktrees` —
  with the protected database, staging bytes and source hashes unchanged. The minimized regression reads 0/1
  at `b07ac4f` and 1/1 at `5bfe80d`, so the defect it pins was real and is now closed. Verified: S3 and S2
  met for this recheck; S1, S4 and S5 remain as the earlier passes left them (met).
- **L19** — T14 landed in `ff5cf01` and was accepted by the verifier's own minimized regression (0/1 against
  `b07ac4f`, 1/1 after) plus both probe suites. Identity is three-valued now — `present` with dev+inode,
  `ENTRY_ABSENT` only when stat said ENOENT, `ENTRY_UNKNOWN` for EACCES/EPERM, a throwing seam or an answer
  without an identity — and every decision in the seed, the abandon path and the rollback fails closed on
  unknown. The differential against `b07ac4f` changed exactly one case (the foreign database now survives a
  denied stat) and left the ENOENT case rolling back as before, so "fail closed" did not become "never
  remove". The trade is stated in the commit: with a denied stat our own index can survive a failed seed
  rather than risk another session's.
- **L18** — Third pass on `b07ac4f`: the two blockers from L14 are closed at runtime (both foreign-directory
  interleavings preserve state, the before-recheck control stays green, the search now waits behind a real
  compaction), and the earlier fixes still hold. It found one residual of the same class: with the database
  replaced by another actor mid-sync and its stat failing with EACCES, `identityOf` answered `undefined`,
  `undefined` was read as "not a mismatch", and the rollback removed the other actor's database. Unknown
  must never mean equal. The fix audits every identity decision in the seed, the abandon path and the
  rollback, with "unknown fails closed" stated as the rule; the acceptance is the verifier's minimized
  probe, which failed against `b07ac4f` and must pass.
- **L17** — Post-verification fixes landed in `e9c1b1c`, accepted against the verifier's probe suite rather
  than a self-authored one: 17/20 before, 20/20 after, with every previously green case still green.
  RED was real on the branch (three failing focused tests, and the probe cases named in L14). The
  differential over the shared `seedWorktreeIndex` — the helper `seedLinkedWorktrees` also uses — shows
  exactly one intended delta (a seed into an existing foreign index no longer overwrites it) and
  byte-identical filesystem residue in every other case, including a worktree root that does not exist
  yet, which the first draft of the identity change had broken. Focused files 138/138, suite 2214/0.
- **L14** — Independent verification ran for real once the topology allowed it: the verifier's preparer rejects
  a linked worktree ("ordinary single-root Git directory required"), so the branch was cloned to
  `/tmp/cg-verify` (HEAD `c7a1f2c`, base `5bfe80d`, identical tree hash `3b3b49e`). Result: five focused files
  203/0, and the verifier's own probes 17 pass / 3 fail. The three failures are real and reproduced:
  - **S3 (two failures)** — the rollback removes `.codegraph` blindly: if another actor creates the directory
    after the under-lock recheck, or replaces this session's directory during the sync, the rollback deletes
    something this session did not publish, which is exactly what S3 forbids. Ownership needs to be proven
    (the identity this session created), not assumed from "my publish succeeded".
  - **S2 (one failure)** — a compaction sync is not tracked, so a search answers immediately while it is in
    flight, although S2 says a refresh already in flight is awaited.
  The probes that had been the previous pass's findings now pass at runtime: the throwing-delay cap, the
  escalation clamp at/above and equal to the grace and its default, and the fresh/abandoned record-less lease.
- **L13** — Independent verification attempt (item 4) ran source review only: the verifier's preparation rules
  bind it to commits, and the candidate was a dirty worktree, so it reported **0 tests executed** rather than
  pretending. Its source verdicts and static findings:
  - S5 lock identity — met by inspection: both paths use the same `clockOf` and directory `mtimeMs` against
    `UNWRITTEN_GRACE_MS`; the residual read→remove race already exists at the baseline and is not
    change-caused.
  - S5 kill escalation — **finding (medium)**: `options.escalationMs` accepted a value at or above
    `KILL_WAIT_MS`, so the reporting grace settled the run and cleared the escalation before the hard kill
    could fire. Being fixed.
  - S2 fail-safe — **finding (medium)**: `boundedWait` returned the joined promise unchanged when the delay
    seam threw, removing the cap exactly when the host would wait forever. Being fixed.
  - Test quality — four specific weaknesses: a timing test measured from invocation with an 80% tolerance, a
    real trapping-child test with a fixed 300 ms startup deadline and no readiness handshake, a lock-grace
    test that reads real filesystem time (a long pause inverts it), and a preparation-join assertion that
    cannot tell an early resolution from a pending promise.
  Re-verification must run on the committed range, not on a dirty tree.
- **L12** — Differential check for the shared `runCodegraph` (T5 changed it; `lib/codegraph-compaction.js`
  owns it as its default `run`): a driver drove the real compaction command against a stub `codegraph`
  on PATH at the base commit and on the branch, recording the outcome and the exact CLI arguments for
  exit 0, exit 3 and a missing binary. Both trees produced identical outcomes and identical arguments
  (`sync -q <project>`); the only deltas were the intentional new export `KILL_ESCALATION_MS` and the
  scratch directory name inside the recorded argument. No regression to compensate.
- **L11** — S2 landed as specified, with one documented limitation: the join keys on the session
  checkout (the cwd the host hands the event), so it does not resolve a git toplevel and does not join work
  for an MCP `projectPath` pointing at another checkout — joining that would add a git read to every
  search. The wait is bounded (5 s, `ODD_WORKTREE_CODEGRAPH_JOIN_MS`, 0 disables), nothing in flight means
  no timer and no added latency, and the handler cannot throw or block because a `tool_call` error blocks
  the tool.
- **L10** — Evidence (T3): the release nonce was already implemented (both the init lock and the
  lease compare their on-disk token), so T3 delivered the missing negative proof instead of a mechanism,
  verified by removing both guards in a scratch copy (2 tests, 2 failures). It also surfaced a real
  asymmetry: `releaseLease` reads an unreadable or missing record as "mine" while `leaseHeld` reads the
  same state as "someone is writing" (`UNWRITTEN_GRACE_MS`), so a stale holder could remove a lease another
  session had just created. Recorded as T9 under S5.
- **L9** — Evidence (T2): Pi's `docs/mcp.md` § "Control tool exposure" defines per-tool
  `toolExposure` as the way to make one MCP tool directly callable ("`toolExposure` overrides the server
  exposure for individual tools"), and entry-level `exposure` only sets the server-wide default (default
  `codemode`). `CODEGRAPH_SERVER` already writes `toolExposure: { codegraph_explore: 'direct' }`, so #3312's
  premise does not apply to this package: S4 closes with no behavior change and one regression test that
  pins the documented shape.
- **L8** — Decision (T4 blocker): the four seeding tests whose fake copy wrote plain text ('seeded',
  'seed bytes', 'seeded db') get a plausible-index fixture instead of a relaxed spec, because the
  "unchanged" rule protected the happy path's acceptance (publish, then exactly one `sync -q`), not the
  unrealistic fixture. Validation reads through the injected fs seam and fails closed on any odd return.
