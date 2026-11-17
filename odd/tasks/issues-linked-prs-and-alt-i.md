# issues: linked PR list, named metadata loss, alt+i

Feature: the `/issues` reading pane must list linked PRs by number instead of counting them, must name which metadata it lost, and `alt+i` must open the issues panel.

## Specs

- **S1** — The pane lists every linked PR by number, never a count. The user's exact words: "en linked pr esta mal, no debe salir cantida sino el listado de todas las linkeadas como "#69, #77"." Rendered line: `linked PRs: #69, #77` (ascending, comma + space).
- **S2** — When a metadata relation is lost, the pane names it: `metadata unavailable: projects`. The user's complaint: "u me sale metada unvaible, algo estara fallando, que metadata no obtiene?" A bare `metadata unavailable` survives only for a whole-read failure (permissions/assignees unknown).
- **S3** — A failed or capped `projectItems` read must NOT mark the whole metadata read failed: permissions, assignees and linked PRs already confirmed stay, and only `projects` is reported unavailable. Confirmed cause: the token lacks the `read:project` scope, so `projectItems.project.title` returns `INSUFFICIENT_SCOPES`.
- **S4** — Honesty: an empty linked-PR list adds no row (never "0 PRs"); a capped page (`pageInfo.hasNextPage`) renders the known numbers plus a trailing `…` instead of passing for the whole list.
- **S5** — `alt+i` opens the issues panel (the same panel `/issues` opens), without disturbing any existing shortcut.

## Tasks

| ID | Specs | Route | State |
| --- | --- | --- | --- |
| T1 | S1-S4 | writer, `lib/gh-issues.js` + `lib/issue-preview.js` + the issue tests | done, `b30a720` |
| T2 | S5 | writer, keymap + wiring + docs | done, `575d778` |

### T2 implementation contract (S5)

`alt+i` is a HOST-level shortcut, and the package has exactly one today: `alt+p` for the file picker (`extensions/odd-worktree-tools.ts` — `FILES_KEYMAP_ENV`/`FILES_KEYMAP_DEFAULT` constants, `filesShortcutKey()` resolver, `bindFilesShortcut(pi)` binder called at load). Copy that pattern, do not invent a second mechanism:

1. Constant pair + resolver: `GENTLE_PI_ISSUES_KEY` overriding the `alt+i` default, mirroring `filesShortcutKey()` including the blank-override fallback.
2. `registerIssuesCommand(pi)` must keep its own handler in a module variable the way `filesCommandHandler` is kept, so the shortcut runs the SAME path as `/issues`.
3. `bindIssuesShortcut(pi)` called at load beside `bindFilesShortcut(pi)`; bind only when the command actually registered (the `gh`-absent gate must not leave a dead key), swallow a host that lacks `registerShortcut` or throws from it, exactly as the files binder does.
4. The handler opens the issues panel with no args and the session ctx — i.e. what `/issues` opens.

The load-bearing invariant to amend, not contradict (`docs/codebase/invariants.md`): "the file picker's ONE shortcut, alt+p … bound once at load, the handler is the command's own". After T2 there are TWO host shortcuts and both keep those properties.

## Log

- **L1** (verbatim): "en linked pr esta mal, no debe salir cantida sino el listado de todas las linkeadas como "#69, #77".\n\nu me sale metada unvaible, algo estara fallando, que metadata no obtiene?"
- **L2** (verbatim): "arranca con eso, ademas\n\ntambien agrega el atajo alt+i para abrir  panel de issues."
- **L3** (evidence): `gh auth status` on this machine grants `gist, read:org, repo, workflow`; the live query on issue #61 answers `INSUFFICIENT_SCOPES ... The 'title' field requires one of the following scopes: ['read:project']`. That is the metadata that fails: projects.
- **L4** (T1 result): worker `mwjxq53r-2-51kt`. RED 36 tests / 29 pass / 7 fail -> GREEN 36/36; `issues-view`+`gh-issues`+`issues-command` 377/377; `npm test` 2364/2364, 0 skipped. Parent spot check against the live repo: `getIssue(61, { includeMetadata: true })` returns `linkedPullRequests: [69]`, `unavailable: ['projects']`, no `metadataError` — the same issue that showed "linked PRs: 1 / metadata unavailable".
- **L5** (T2 result): worker `mwjxsc69-3-cyy2`. RED 38 tests / 25 pass / 13 fail -> GREEN 38/38; `npm test` 2368/2368, 0 skipped. Parent re-ran the full suite in this worktree: 2368/2368.
- **L6** (placement): the work was first written in the primary checkout by mistake and moved here with a patch, byte-identical (checked file by file) before `main` was restored. Branch `feat/issues-linked-prs-alt-i`, base `main@5d0dddf`.
- **L7** (delivery): T1 and T2 share no file, so they ship as two independent PRs on main. T1 is `b30a720` on `feat/issues-linked-prs`; T2 is `575d778` on `feat/issues-alt-i-shortcut`, cherry-picked from the original branch (which keeps `e0a4b41`).
