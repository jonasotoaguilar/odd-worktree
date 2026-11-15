# issues-sidebar — the checkout's related issues in the gentle-shell rail

One new surface: a sidebar section listing the checkout repository's open issues the user
created or was assigned, drawn by gentle-shell-bridge (no import, no new dependency).
Branch `feat/issues-sidebar`; risk item 3 (the extension entry is shared by every surface).

## Specs

- **S1 — the list the user asked for, corrected to assigned only.** The user first asked for "una
  sidebar que me muestre las issues relacionadas, o sea las issue que cree o las que me asignaron",
  then corrected it: "pero correciecon, hagamos que en la sidebar se vean solo las asiggned". The rail
  therefore shows the checkout repository's OPEN issues ASSIGNED to the viewer (`assignee:@me`) and
  nothing else — no authored bucket, no second read. `/issues` keeps its own buckets untouched.
- **S2 — through the bridge, without depending on it.** The section reaches the host only through
  gentle-shell-bridge's published API, read from `Symbol.for("gentle-shell-bridge/api/v1")` after
  the gate (schema `gentle-shell-bridge/api`, `version === 1`, `registerRows`, `registerSection`,
  `createStore` callable), otherwise subscribed to the `gentle-shell-bridge:ready` announcement.
  `package.json` gains NO dependency and no import of the package appears anywhere. With no bridge
  the section never appears and every other surface keeps working: nothing registered, nothing
  thrown. Discoverability is the ONE exception — a single warning per process, in a primary session
  only, naming the install command — and it is timed honestly: an empty slot at `session_start` is
  "not yet", so when `pi.events` exists the check waits the announcement window and warns only if
  the slot is STILL empty; a host with no bus can never announce, so there it warns at once.
  Verbatim: "al inicio deberia comprobar plugin si el bridge ese plugin lo tiene … asi arroja un
  warning de que falta plugin gentle-shell-bridge y pone el comando de instalacion 'pi install
  npm:gentle-shell-bridge'".
- **S3 — a frame never waits.** The bridge calls `lines(ctx)`/`meta(ctx)` once per frame and they are
  synchronous. They read an in-process snapshot and return immediately: no child process, no
  `await`, no `spawnSync`. A snapshot older than the TTL (`60000` ms) schedules exactly ONE
  deferred refresh; when the refresh lands and the published object has a `requestRepaint` member,
  it is called once. A collapsed or hidden section costs nothing. Because a frame only exists when
  the host has a reason to produce one, the section ALSO refreshes on the session's own activity —
  `before_agent_start` and `turn_end` — behind a 30 s floor, so a session in use is never more than
  about half a minute behind, while an idle session still makes no network call and starts no timer.
  A HIDDEN section costs nothing either: no read happens before the section has been drawn at least
  once, and the activity refresh only fires when the section was drawn in the last two minutes, so
  hiding it lets the network go quiet once that two-minute window lapses, and the retained list is drawn
  again, stale, on the first frame after showing it, which also schedules its refresh. A COLLAPSED
  section is not a hidden one: the bridge draws its header through `meta()`, which stamps the draw,
  so a collapsed section still counts as drawn.
- **S4 — a row is an issue.** Each row reads `#<number> <title>`. It carries no relation meta — with
  a single source every row would wear the same mark, and marking everything marks nothing — and the
  header's right-aligned text reports the count instead (`N assigned`). ONE marker is left, and it is
  not about the relation: when the issue already has at least one pull request referencing it — one
  or many, the marker is the same — the row's `meta` is the Nerd Font pull-request glyph `\ue726`.
  That marker travels in the SAME combined read as the list (S9: one request, no second one),
  so a failed read fails list and markers together: S5 keeps the rows and says stale, a decoration never
  turns the list into an error row. Every issue row is drawn in
  the host's `text` tone, never an accent: a permanent accent reads as a focused row. Rows are
  sorted by `updatedAt` descending, twenty are fetched (`fetchMax: 20`), and the body shows at most
  SEVEN of them. When more exist, an eighth and last row in the `dim` tone reads `and N more issues`
  — `N` being the rows beyond the seven, written `N+` when the read hit its fetch bound — and
  clicking it opens the `/issues` panel. That keeps the body at the host's 8-row maximum, so the
  bridge's own inert `… +N more` elision never appears. Clicking an issue row does NOT open a
  browser: it dispatches `/issues <number>`, and the panel opens on the `Assigned` view with that
  issue selected and its detail shown. When the number is no longer in the assigned list, the panel
  says so instead of guessing a row. Verbatim: "en al clickerla en lugar de abrir en el browser la
  abra en panel /isuses e esa issue especifac (que seria en tab asigged)". A row is clickable: its `onClick` opens that issue in the browser with the identity
  `/issues` proves for a browser open — the checkout scope's own identity when the checkout has
  one, otherwise gh's own resolution normalized to `<host>/<owner>/<repo>`, because a single-remote
  checkout has no scope identity to pin — and it never runs on the paint path (the work is deferred
  to a macrotask, exactly once per click, and a failure is swallowed into the snapshot's error).
  The identity is the one the ROW was built from: a row still on screen across a checkout change
  opens the repository it was read from, never the one the session moved to.
- **S5 — every state is a row, none is a throw.** `loading…` (dim) before the first answer,
  `no open issues` (dim) for an empty result, and ONE error row for a failed read or a failed scope
  resolution — but ONLY while there is nothing to show. Once a ready snapshot exists, a later failed
  refresh never erases it: the rows stay on screen and the failure is disclosed instead, with the
  header reading `<n> assigned · stale`, and `snapshot().error` recording the reason for a caller.
  `lines()` and `meta()` never throw; a throw of an injected seam is caught. A transient `gh` stall
  is therefore a stale list, not an empty one.
- **S6 — scope is the checkout's own repository, never a guess.** The list is read exactly like
  `/issues` reads it: `checkoutRepoScope({cwd})` and `gh.listIssues({query, state: 'open'}, {cwd,
  scope, fetchMax: 20})`. A failed resolution produces the S5 error row; no `gh` call is made
  without a proven identity. A session that starts in ANOTHER checkout supersedes the previous one
  at the moment `session_start` fires — before any awaited probe in that handler — so the old
  checkout's snapshot is dropped (the section shows the loading state, never the previous
  repository's rows) and its in-flight answer can never land. A session that SHUTS DOWN supersedes
  it too: no read still in flight can repaint a torn-down host.
- **S9 — one request, one cache, only while the rail is shown.** The user asked: "en el caso de que
  este activo el sidebar de issues podriamos cachear las issues, no solo busque las assigned sino que
  la primera vez busque todas y las cache, luego busca las ultimas 20 por para cer si hay nuevas, lo
  hace para las mias, las assigend y las involved, asi al clickerla el panel se abre instantaneo".
  The section still DRAWS only the assigned issues, but one read now covers the three scoped views:
  a single `gh api graphql` request with three aliased searches (`author:@me`, `assignee:@me`,
  `involves:@me -author:@me`), each returning its `issueCount` and, per issue, the pull-request
  cross-reference that drives the marker. That replaces today's list read plus the separate marker
  read. Measured in this repository with the API's own `rateLimit { cost }`: 1 point at 20 per
  bucket, 2 at 50, 3 at 100, about one second whatever the size — the time is the `gh` process and
  TLS, not the payload, so what an incremental read saves is quota and bytes, not latency.
  The cache lives in this process only, keyed by the proven `<host>/<owner>/<repo>`, and is never
  written to disk. The first sync reads up to 100 per bucket; later syncs read the newest 20 and
  merge them by issue number. A merge cannot see an issue that was closed or unassigned (it simply
  leaves the result), so the cache is held to one invariant: after every merge each bucket's cached
  open count must equal the `issueCount` that same response reported, and when it does not, the
  next sync is a full re-read of the three buckets. A bucket whose `issueCount` exceeds what was
  read is `truncated` and reports it, never looped. A cache older than ten minutes is also re-read
  in full. All of it runs only while the section is shown (the drawn window of S3): hidden, the
  cache is kept but nothing is read, and the first draw after showing it again syncs. Verbatim:
  "todo esto solo si issues sidebar esta acitva, si no esta no tiene sentido porque no esta
  mostrando nada en vivo".
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
| T6 | S6 (verify round 2 blocker) | worker | `lib/issues-section.js`, `extensions/odd-worktree-tools.ts`, `tools/issues-section.test.js` | `9a1fd95` |
| T7 | S4, S6 (verify round 3 findings) | worker | `lib/issues-section.js`, `extensions/odd-worktree-tools.ts`, `tools/issues-section.test.js` | fix commit |
| T7 | S3 (live finding) | worker | `lib/issues-section.js`, `extensions/odd-worktree-tools.ts`, `tools/issues-section.test.js` | fix commit |
| T8 | S4 (five rows + the overflow row) | worker | `lib/issues-section.js`, `extensions/odd-worktree-tools.ts`, `tools/issues-section.test.js` | `a968153` |
| T9 | S4 (the PR marker) | worker | `lib/issues-section.js`, `extensions/odd-worktree-tools.ts`, `tools/issues-section.test.js` | pending |
| T10 | S5 (a failed refresh keeps the rows) | worker | `lib/issues-section.js`, `tools/issues-section.test.js` | pending |
| T11 | S2 (the missing-bridge warning) | worker | `extensions/odd-worktree-tools.ts`, `tools/issues-section.test.js` | pending |
| T12 | S4 (the click opens the panel) | worker | `extensions/odd-worktree-tools.ts`, `lib/issues-view.js`, `tools/issues-command.test.js` | pending |
| T13 | S3 (a hidden section costs nothing) | worker | `lib/issues-section.js`, `extensions/odd-worktree-tools.ts`, `tools/issues-section.test.js` | pending |
| T14 | S9 (one combined read, the cache, the count invariant) | worker | `lib/gh-issues.js`, `lib/issues-section.js`, `extensions/odd-worktree-tools.ts`, `tools/issues-section.test.js` | pending |

## Log

- **E14 (what the docs pass found the code does NOT do, and what is simply still open):** writing S8
  against the code refused five sentences of this document. Two were wrong in the spec and are
  corrected in S3 above: hiding does not invalidate (the old list is drawn again, stale, which is the
  better behavior) and a hidden section can still fire one activity read until the 120 s window
  lapses. Three are not defects but work that has not happened, and they are NOT satisfied yet by
  design: **T12** (a row click opens the panel on that issue instead of the browser) waits on the
  panel ODD accepting `/issues <number>`; **S9's consumer half** (the panel opening from this
  cache) waits on that ODD's T4; and the header reports what the cache HOLDS, which the 100-row cap
  can truncate (`N+` says so). Until those land the row click is the browser open and the cache has
  no reader.
- **E13 (what T14 made stale in the specs above):** S4's marker paragraph used to describe a second,
  best-effort read whose failure left the list untouched; S9 replaced it with one combined request,
  so a failure now takes the list and its markers together and lands in S5's stale state. S6's
  mention of `gh.listIssues` is likewise superseded: since T8 the rail reads the assigned bucket and
  since T14 it reads all three through `listRelatedIssues`. The code is the authority; any doc that
  still says "best effort" about the marker is wrong.
- **E12 (T14, a name the repo had already retired):** the cache module was specified as
  `lib/issues-cache.js`, and the worker stopped because `tools/package-surface.test.js` lists that
  exact name among the modules REMOVED on purpose (its own comment: "the per-tab cache is still
  gone"). Editing the guard to allow it would weaken the test that keeps retired surface from coming
  back, and the new cache is a different thing (one in-process cache across the three scoped views,
  fed by one request). The module is therefore `lib/related-issues-cache.js` and the guard is
  untouched; the full suite is green with it as it was.
- **E11 (delivery strategy, recorded at the slice boundary):** this branch is far past one review slice
  (over 2400 changed lines). The commits are already the boundaries, one concern each: the feature
  (`54d9c7b`), three verification-round fixes, the activity refresh, the assigned-only reshape, and
  the T9-T13 group. Pushing and opening pull requests stay the user's decision; when that happens
  the branch is cut as a CHAIN along those commits, not sent as one 2400-line pull request.
- **E10 (found while running the suite from a primary shell):** T11's missing-bridge warning fires
  once per process by design (the dedupe survives a `/reload`), and the worker that built it ran as
  an agent child, where the warning is suppressed, so it never saw the interaction. In
  `tools/issues-command.test.js` the first test to load the extension consumed the hint and every
  later notification-count test passed only because of that order: run alone, two of them failed.
  The fixtures now leave the bridge hint out, since that file is about the `gh` gate and
  `tools/issues-section.test.js` owns the hint; the same tests pass alone, as a file and in the
  full suite.
- **L12 (user, verbatim):** "en el caso de que este activo el sidebar de issues podriamos cachear las
  issues, no solo busque las assigned sino que la primera vez busque todas y las cache, luego busca
  las ultimas 20 por para cer si hay nuevas, lo hace para las mias, las assigend y las involved, asi
  al clickerla el panel se abre instantaneo. Y como sacamos lo de all ya no es tan costoso como antes
  porque ese es aparte. y como carga completa la primera vez y las siguiente solo busca las ultima
  para ver actualizacion igual se reduce costo de update y asi issue abre mas rapido, pero como digo
  todo esto solo si issues sidebar esta acitva, si no esta no tiene sentido porque no esta mostrando
  nada en vivo o simulando en vivo pues la revisa realmente cada x tiempo. asi clickear la issue la
  abre instantenea en vez de esperar que lar cargue o recargue. igual revisa los costos, rendimiento
  para optimizarla lo maximo posible. estas trabajndo en un worktree supongo cierto?" — S9 and T14.
  Measured before specifying (E10): one combined request costs 1/2/3 points at 20/50/100 per bucket
  and takes about a second at any size, so the incremental read is a quota and bytes saving and the
  instant click comes from the panel reading the cache (the panel ODD owns that half). The worktree
  question was answered honestly: this ODD still lives in the principal checkout because the user's
  session loads the extension from it; the panel ODD has its own worktree.
- **L11 (user, verbatim, two messages):** "otro cambio es uqe las issues son clickeables, esta bien, pero
  en al clickerla en lugar de abrir en el browser la abra en panel /isuses e esa issue especifac (que
  seria en tab asigged)" and "igual claro que estas comprobaciones se hacen solo si la sidebar de
  issues esta mostrada, o sea, no hidden". S4 is amended (T12): the row click opens the panel on that
  issue in the Assigned view instead of the browser, and S3 is amended (T13): no read before the
  section is drawn, and none while it stays hidden.
- **L10 (user, verbatim):** "igual ahora que depende de gentle shell bridge, al inicio deberia comprobar
  plugin si el bridge ese plugin lo tiene, si no lo tiene supongo que tira error la funciones de bridge
  como sidebar issues, asi arroja un warning de que falta plugin gentle-shell-bridge y pone el comando
  de instalacion 'pi install npm:gentle-shell-bridge'" — S2 is amended: nothing throws today
  (every bridge call is guarded), so what T11 adds is discoverability, not error handling: one
  warning per process, primary sessions only, after the announcement window, naming that command.
- **L9 (user, verbatim):** "me tiro un error igual ahora es por la sesion larga? limitacion api o que?"
  — the section showed `gh timed out after 30000ms`. Measured in the same checkout minutes later: the
  identity read took 457 ms, the bucket read 683 ms, and the rate limit had 4964/5000 left, so it was
  neither the session's length nor an API limit: the host's own 30 s child bound killed a hung `gh`
  (keyring prompt after idle, or a DNS/TLS stall). The finding is not the stall but what a stall did:
  a failed refresh replaced good rows with the S5 error row. S5 is amended (T10) so a ready list
  survives a failed refresh and reports `· stale` instead.
- **L8 (user, verbatim):** "igual en issues como sidebar todas son assiged no hace falta el icono en
  lugar pon el icono de una pr si es que tiene al menos una pr ya esa issue relacionada, o sea una pr
  la trabajo ya, una o mas da igual al menos una"; asked which glyph, the user proposed
  `nf-dev-git_pull_request` and it was accepted. S4 is amended: the relation meta stays gone, and the
  one marker on a row says the issue already has at least one pull request. Known limit recorded
  with it: the glyph is Nerd Font dependent (a terminal without one draws a box) and must measure
  one column, because a row wider than the given width drops the whole rail.
- **L7 (user, verbatim):** "pero correciecon, hagamos que en la sidebar se vean solo las asiggned" —
  the rail drops the authored bucket and reads `assignee:@me` only; the per-row relation glyph is
  removed with it (a mark on every row marks nothing) and the header reports `N assigned`.
- **L6 (user, verbatim, two messages):** "igual a la derecha en vez de decir mine i asiggned sea un
  icono, proponme uno. Y en icno aunque sea mine+assigned sale solo 1 y gana ssigned." and "como se
  veria si fueran 8"; after three options were offered the user chose **7 issues + the overflow row**
  (8 painted rows). S4 is amended to the glyph and that layout, and the bridge's own arithmetic
  (7 kept + 1 elision when a section returns more than 8) is why the overflow row must be the 8th.
- **L5 (user, verbatim):** "igual muestra un maximo de 5 issues, en listado y si tiene mas en una
  sexta linea en color mas gris dice que hay x issues mas y esta sexta linea me deja clickearla y
  me abre el clickear panel /issues (en mine assigned muestra bien cuantas es el total)" — S4 is
  amended to the five-row body plus a dim, clickable overflow row that opens `/issues`; the header
  meta keeps reporting the real totals per bucket.
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
- **E9 (live session finding, parent):** the section shipped and rendered in a real Gentle Shell, and
  showed `0 mine · 0 assigned` / `no open issues` while three open issues existed. The data path was
  proven correct (`gh.listIssues` returned `[51,50,49]` through the real client), so the snapshot was
  simply never refreshed. The bridge's own code answers why: `lines()` DOES run every frame (via the
  rail digest, not `render()`), but a frame only exists when something external produces one — the
  bridge ships "no timer, no poll, no retry" — so the 60 s TTL never got a frame to fire on while the
  session idled. It updated the moment the human sent a message. T7 therefore refreshes on the
  session's own events (`before_agent_start`, `turn_end`) behind a 30 s floor: never stale while in
  use, still zero calls when idle.
- **E9 (verify round 3, against `9a1fd95`):** the supersede itself is confirmed fixed, and the
  invalidate/repaint/gate-failure probes pass. Two lifecycle findings remain. (a) S4: a row RETAINED
  on screen from checkout A, clicked after B's snapshot landed, opened `gh issue view 11 --web -R
  github.com/o/B` — a different repository's issue number — because the click path reads the CURRENT
  snapshot's identity and the module's callback captured only the number. (b) S6: a read still in
  flight at shutdown can still call the repaint after every shutdown handler has run. T7 binds the
  row to the identity it was built from and supersedes the section on `session_shutdown`.
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
