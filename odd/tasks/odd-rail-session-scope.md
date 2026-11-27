# odd-rail-session-scope

Fix the `ODD` rail section: it lists every ODD on disk instead of the ODDs the session is associated
with, and it draws a bare empty box when there is nothing to show.

Branch `fix/odd-rail-session-scope` (base `main@252650e`).

## Specs

S1. A session with no associated ODD draws one dim row instead of an empty box. The user said:
"primero mira, si no hay nada deberia decirlo, como en changes, algo de no hay ODD asociados o
capturaded o algo asi". Copy: `no ODD associated` (dim), mirroring `EMPTY_ROW` of
`lib/issues-section.js:109`.

S2. The rail lists ONLY the ODDs associated with the session, never "everything on disk". The user
said: "en pi lens por ejemplo es sesion nueva, y salen 4, lo cual es imposible." and "Los ODD como te
dije se asocian a la sesion, es en base al ODD write/edit por la sesion principal o subagente".
Association is by ODD NAME (`odd/tasks/<name>.md`); the row's checkout (`main` or worktree name) is
still elected by the existing rule (S4/S12 of odd-rail-section). A touched name that no longer exists
on disk stays hidden. Attribution stops being an ordering key only: it is the filter (invariant to be
amended).

S3. The association is rebuilt from the session history, not only recorded live, so OLD sessions
(written before the `odd-worktree.odd-touch` entry existed) and RESUMED sessions show their ODDs. The
user said: "ademas tiene considerar sesiones antiguas y reanudacion de sesion, no solo las nuevas".
Source on the ACTIVE branch only (`getBranch`, not `getEntries`): an assistant `toolCall` named
`write` or `edit` whose `arguments.path` is an `odd/tasks/<name>.md` AND whose matching `toolResult`
(`toolCallId`) has `isError: false`; plus the existing `odd-worktree.odd-touch` custom entries.

S4. Subagent writes count for the parent session. The user said: "por la sesion principal o
subagente". A subagent runs in its own session, so the parent reads its OWN history: a successful
`gentle-agents.result` custom message whose report lists `files_changed:` paths matching
`odd/tasks/<name>.md`, and the `Spec: odd/tasks/<name>.md, T<n>` line of the `subagent_run` /
`subagent_continue` toolCall `task` argument. Verified: both are stored in the parent session file.

S5. The worktree logic the user asked to re-check ("Lo de ODD por worktree ya lo implementamos pero
no lo he probado, revisa si esta bien igual la logica que planteamos"): the audit found one concrete
defect: `filesSessionWorktreeRoots` reads `getEntries()` without the active leaf, so worktrees
registered only in an abandoned branch stay in scope. Fix it to the active branch. Report the rest of
the audit as sound.

S6. The `/odd` panel is NOT changed by this feature (it stays "main whole + worktree deltas", `a` =
all). Only the rail is scoped to the session.

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | `lib/odd-session.js` (+ tests): pure history rebuild `associatedFromHistory(entries)` for S3/S4, branch-aware, name-keyed | S3, S4 | worker | done |
| T2 | `lib/odd-rail-model.js` (+ tests): `railRows` filters by the associated name set; empty snapshot | S2 | worker | |
| T3 | `lib/odd-rail-section.js` (+ tests): empty ready snapshot draws the dim `no ODD associated` row | S1 | worker | |
| T4 | Wiring in `extensions/odd-worktree-tools.ts` (+ wiring tests): restore on `session_start` via `getBranch()`, refresh on subagent result, `filesSessionWorktreeRoots` uses the active branch | S2-S5 | worker | |
| T5 | Docs: amend invariant on "attribution only orders", reference.md rail description | S2 | worker | |
| T6 | Independent verification against S1-S6 (new session, old session, resume, subagent) | S1-S6 | verifier | |

## Log

L1. User's report, verbatim: "encontre unos bugs, primero mira, si no hay nada deberia decirlo, como en
changes, algo de no hay ODD asociados o capturaded o algo asi. / igual no captura bien, ahi en pi
lens por ejemplo es sesion nueva, y salen 4, lo cual es imposible. / Los ODD como te dije se asocian
a la sesion, es en base al ODD write/edit por la sesion principal o subagente, ademas tiene
considerar sesiones antiguas y reanudacion de sesion, no solo las nuevas. / Lo de ODD por worktree
ya lo implementamos pero no lo he probado, revisa si esta bien igual la logica que planteamos"

L2. Root cause (explorer, read-only): `loadOddRailRows` (`extensions/odd-worktree-tools.ts:11332`)
builds rows from `oddGroupsFor` where main is always whole (`lib/odd-group.js:421`); `railRows` uses
`touched` only to sort (`lib/odd-rail-model.js:14-16`). Subagent writes are never seen by the parent
(`lib/odd-session.js:13-14`). The empty ready snapshot draws zero lines by a written decision
(`lib/odd-rail-section.js:309-311`).

L3. Session history facts (explorer, real JSONL): assistant message entry with content block
`{type:"toolCall", name:"write"|"edit", arguments:{path}}`; result entry `message.role:"toolResult"`
with `toolCallId`, `isError`, `details.patch` for edit. Subagent `task` text with the `Spec:` line is
stored verbatim in the parent's `subagent_run` toolCall; the finished report is persisted as a
`custom_message` with `customType:"gentle-agents.result"`. No child session file link exists on disk.
