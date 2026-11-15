# issues-sidebar — the checkout's related issues in the gentle-shell rail

One new surface: a sidebar section listing the checkout repository's open issues the user
created or was assigned, drawn by gentle-shell-bridge (no import, no new dependency).
Branch `feat/issues-sidebar`; risk item 3 (the extension entry is shared by every surface).

## Specs

- **S1 — the list the user asked for.** "una sidebar que me muestre las issues relacionadas, o sea
  las issue que cree o las que me asignaron". The rails shows the checkout repository's OPEN issues
  from exactly two sources: the ones authored by the viewer (`author:@me`) and the ones assigned to
  the viewer (`assignee:@me`). An issue in both shows once.
- **S2 — through the bridge, without depending on it.** The section reaches the host only through
  gentle-shell-bridge's published API, read from `Symbol.for("gentle-shell-bridge/api/v1")` after
  the gate (schema `gentle-shell-bridge/api`, `version === 1`, `registerRows`, `registerSection`,
  `createStore` callable), otherwise subscribed to the `gentle-shell-bridge:ready` announcement.
  `package.json` gains NO dependency and no import of the package appears anywhere. No bridge, no
  section: nothing registered, no error, no `ui.notify`, and every other surface keeps working.
- **S3 — a frame never waits.** The bridge calls `lines(ctx)`/`meta(ctx)` once per frame and they are
  synchronous. They read an in-process snapshot and return immediately: no child process, no
  `await`, no `spawnSync`. A snapshot older than the TTL (`60000` ms) schedules exactly ONE
  deferred refresh; when the refresh lands and the published object has a `requestRepaint` member,
  it is called once. A collapsed or hidden section costs nothing.
- **S4 — a row is an issue.** Each row reads `#<number> <title>` and its `meta` names the relation:
  `mine`, `assigned`, or `mine + assigned`. Rows are sorted by `updatedAt` descending and capped at
  20 issues fetched (`fetchMax: 20`), so the bridge's own 8-row body cap is the only clipping left
  to it. A row is clickable: its `onClick` opens that issue in the browser with the identity
  `/issues` proves for a browser open — the checkout scope's own identity when the checkout has
  one, otherwise gh's own resolution normalized to `<host>/<owner>/<repo>`, because a single-remote
  checkout has no scope identity to pin — and it never runs on the paint path (the work is deferred
  to a macrotask, exactly once per click, and a failure is swallowed into the snapshot's error).
- **S5 — every state is a row, none is a throw.** `loading…` (dim) before the first answer,
  `no open issues` (dim) for an empty result, and ONE error row for a failed read or a failed scope
  resolution. `lines()` and `meta()` never throw; a throw of an injected seam is caught.
- **S6 — scope is the checkout's own repository, never a guess.** The list is read exactly like
  `/issues` reads it: `checkoutRepoScope({cwd})` and `gh.listIssues({query, state: 'open'}, {cwd,
  scope, fetchMax: 20})`. A failed resolution produces the S5 error row; no `gh` call is made
  without a proven identity. A session that starts in ANOTHER checkout supersedes the previous one
  at the moment `session_start` fires — before any awaited probe in that handler — so the old
  checkout's snapshot is dropped (the section shows the loading state, never the previous
  repository's rows) and its in-flight answer can never land.
- **S7 — nothing else moves.** `/warp`, `/odd-list`, `/issues`, `worktree_create`, `worktree_list`,
  the `worktree-warp` renderer, the prompt blocks and every existing test behave exactly as before;
  `node --test tools/*.test.js` stays green.
- **S8 — the docs say it.** `AGENTS.md`'s surface invariant names the sidebar section as the one
  fourth kind of surface (and the bridge as the only path to it), `README.md` lists it, and
  `docs/reference.md` documents the section, its three states, its TTL, its click and its
  requirement (a host with gentle-shell-bridge installed and a rail).

## Decisions made while specifying (not user strings)

- D1 — the section's relation is carried in each row's `meta`, not by two separate sections: one card
  with the host's own row idiom, and one toggle in `/gentle:customize` → `Sections`.
- D2 — click opens the browser through the same `gh issue view <n> --web -R <identity>` path
  `/issues` already uses, instead of a second reader inside the rail.
- D3 — refresh is lazy (TTL on a drawn frame) plus one eager refresh at `session_start`. No polling
  timer, so an idle session makes no network calls.
- D4 — the section id is `odd-worktree.issues`, title `ISSUES`, `rowLabel` `issues`.

## Tasks

| ID | Spec | Route | Surface | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1, S3, S4, S5 | worker | `lib/issues-section.js`, `tools/issues-section.test.js` | `54d9c7b` |
| T2 | S2, S6, S7 | worker | `extensions/odd-worktree-tools.ts`, `tools/issues-section.test.js` | `54d9c7b` |
| T3 | S8 | parent | `AGENTS.md`, `README.md`, `docs/reference.md` | `54d9c7b` |
| T4 | S4 (amended) | worker | `extensions/odd-worktree-tools.ts`, `tools/issues-section.test.js` | `54d9c7b` |
| T5 | S1, S3, S4, S6 (verify blockers) | worker | `lib/issues-section.js`, `tools/issues-section.test.js` | `d083e38` |
| T6 | S6 (verify round 2 blocker) | worker | `lib/issues-section.js`, `extensions/odd-worktree-tools.ts`, `tools/issues-section.test.js` | fix commit |

## Log

- **L1 (user, verbatim):** "/home/jona/dev/projects/gentle-shell-bridge tengo ese plugin instalado,
  usando ese me gustaria agregar una sidebar que me muestre las issues relacionadas, o sea las issue
  que cree o las que me asignaron"
- **L2 (user, verbatim):** "me refiero a que este plugin use los recursos de ese" — the work lands in
  THIS package (`odd-worktree`); gentle-shell-bridge is the mechanism, not the target.
- **L3 (user, verbatim):** "tiene un feacture el bridge para agregar sidebar a gentle shell" —
  confirms the bridge's `registerSection` surface is the intended path.
- **L4 (user, verbatim):** "no importa, solo continua con lo que pedi" — proceed with the feature.
- **E1 (evidence, gentle-ai-explore on the bridge):** `registerSection` on the published object
  (`docs/contract.md:523`, `src/api.ts:133`), `SidebarSection`/`SectionContext` shape
  (`src/types.ts:110-197`), sync per-frame `lines`, 8-row body cap with `… +N more`
  (`src/sidebar-render.ts:82-85`), optional `requestRepaint` (`src/api.ts:151-153`), discovery recipe
  (`docs/contract.md:330-358`).
- **E6 (independent verify, 3 blockers, against `54d9c7b`):** (a) `lib/issues-section.js:195` ignores an
  opener that RESOLVES `{ ok: false, error }` — which is exactly what the extension's opener returns —
  so `snapshot.error` stays null (S4). (b) `meta()` calls `ensureFresh()`, and the installed bridge
  calls `meta` even for a collapsed section, so a collapsed header schedules network (S3).
  (c) `refresh()` coalesces a new `session_start` onto an in-flight load, so after a checkout switch
  the OLD repository's rows land and nothing re-reads until the TTL (S1, S6). T5 fixes all three,
  with one test each, in a commit of its own so the fix is reviewed apart from the feature.
- **E8 (verify round 2, one blocker, against `d083e38`):** the token fixed the read race only
  AFTER `refresh()` is called, and the extension fires it after `await checkIssuesGate(...)`. While
  that gate waits, the previous checkout's in-flight answer still lands and paints its rows. The
  other five findings of round 1 are confirmed fixed, and S2/S3/S4/S5/S7/S8 are satisfied. T6 makes
  the supersede synchronous and explicit: `invalidate()` on the section (snapshot dropped, token
  bumped) called the moment `session_start` runs, before any awaited probe.
- **E7 (T5 outcome):** all three fixed in `lib/issues-section.js` — the opener's resolved
  `{ ok: false, error }` now records through `recordOpenError`, `meta()` never schedules (only
  `lines()` does), and `refresh()` is latest-wins behind a run token so a newer checkout's read can
  never be overwritten by an older one. RED for each was observed first (11 → 14 tests). The
  verifier's OWN three probes, re-run against the fixed module, pass 3/3 — the same probes that
  failed against `54d9c7b`. Three documentation mismatches it also reported were corrected:
  `AGENTS.md` and `docs/reference.md` no longer claim nothing is registered on a bridge host with no
  rail (the bridge does receive the section), and `README.md` now lists `gh` as a requirement of the
  rail too, not of `/issues` alone.
- **E5 (slice boundary, recorded):** the whole feature is ONE commit, `54d9c7b`, 1263 changed
  lines over 7 files. It is past the ~400-line review slice on purpose: the module, its wiring and
  its tests are one behavior — splitting them would ship a half that does not load or a test file
  with nothing to test. The delivery strategy is therefore "one reviewable unit, verified whole",
  and there is no second commit planned for this ODD. `git diff` for that commit is the unit a
  reviewer reads.
- **E4 (review finding, parent):** T2 as delivered resolved the click identity only from
  `checkoutRepoScope().identity`, which is `null` on a single-remote checkout — the common case — so
  the row opened nothing while `/issues` opens the same issue fine. `/issues` composes the identity
  in `effectiveRepo` (`extensions/odd-worktree-tools.ts:6733-6776`): scope identity when present,
  otherwise `reportedRepoName({cwd, scope: null})` + `normalizeScopeIdentity`. S4 is amended to that
  rule and T4 extracts that composition into one shared helper both callers use. Because T4 touches
  code `/issues` also uses, it is a risk item 3 change and gets the differential check.
- **E3 (constraint found while specifying T2):** the existing surface assertions pin commands, tools and
  message renderers, not sections, so nothing in `tools/package-surface.test.js` has to change; the
  section's registration is asserted in the new suite instead, which keeps the worker's edit
  surfaces to three files.
- **E2 (evidence, gentle-ai-explore on this repo):** `/issues` already reads the same two buckets as
  search qualifiers (`extensions/odd-worktree-tools.ts:6532-6535`) through
  `gh.listIssues(..., {cwd, scope})` (`:6662`); `lib/*` may not require `./gh-issues.js`
  (`tools/package-surface.test.js`); the registration seam is the default export at `:7035`.
