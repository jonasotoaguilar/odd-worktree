# Session auto-rename

The Pi session must take its name from the ODD its `write`/`edit` call touches, from the ODD's own document name, formatted. Reported as not working.

## Specs

S1. "podrias revisar el renombrado de las sesiones de pi, que actualmente no esta funcionando creo"
S2. "se supone que se deberia renombrar al usar tool edit o write sobre un odd"
S3. "renombrala a ese mismo nombre del odd formateado"

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1 | Diagnose why the live path does not rename, and record the evidence | `d996eb6` (L2) |
| T2 | S2 | Fix the wiring so an `edit`/`write` on `odd/tasks/<name>.md` reaches the rename decision | `d996eb6` |
| T3 | S3 | Pin the label shape (`<name>` with separators as spaces) with its test | already pinned: `tools/session-auto-name.test.js`, no change |

## Log

L1. "podrias revisar el renombrado de las sesiones de pi, que actualmente no esta funcionando creo, se supone que se deberia renombrar al usar tool edit o write sobre un odd, renombrala a ese mismo nombre del odd formateado"

L2 (diagnosis, T1). Reproduced live in the reporting session: writing `odd/tasks/session-auto-rename.md` into a registered worktree while the session's cwd was the principal checkout wrote the `odd-worktree.odd-touch` record and produced **no** `session_info` entry. The host API is present (`pi.setSessionName`/`getSessionName`, loader.js), `Worktrees+` was on (the worktree tools registered), the session was unnamed (adoptable), and the label shape was right. The break is `observeOddWriteForNaming`: it resolved the rel against the checkout the CALL started in (`entry.path`), so a document living in another registered checkout resolved to no `odd/` base, `touched` stayed empty, and the planner never saw a write. Only the phase trigger could name such a session, which is why it looked flaky.
L3 (T2). The naming base is now the DOCUMENT's own checkout (`oddEntryForCwd(rows, abs)` over the write path, falling back to the call's checkout). RED first: `tools/session-auto-name-wiring.test.js` case "a write into a registered worktree renames from the principal checkout" failed with `''`; the "from inside that same worktree" case was already green and stays as the regression pin.
