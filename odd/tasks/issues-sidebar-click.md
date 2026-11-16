# The issues rail click: one open at a time, no wait, the latest PR's number

Branch: feat/issues-sidebar-click · Delivery: single PR, no push yet · Tests: `node --test tools/*.test.js`

Reads on top of `odd/tasks/issues-sidebar.md` (the rail section) and `AGENTS.md` invariant 3. Evidence for the
design is the read-only map of the click path, summarised in L2.

## Specs

- S1: **One open at a time.** «hacer click a alguna Issue si abre el panel de issue, pero el problema es que no es
  instantaneo y deberia serlo, lo cual causa que me de pie a que aprete otras issues mientras carga (deberia
  bloquear o que si apreto otras no haga nada, no bloquear click sino quitar efecto mientras esta cargando una)».
  While a click on a rail row is being opened, a further click on any row (the same or another issue, or the
  overflow row) does NOTHING: no second `/issues` message is sent, no second overlay stacks, nothing is painted and
  nothing is announced. The click itself is never blocked or refused visibly; it simply has no effect. The effect
  returns when the first open is over: the panel is mounted, or the open ended without one (the command refused, the
  identity could not be proven, the gate failed, the dispatch threw), or a bounded safety interval has passed, so a
  command the host never ran can never leave the rail dead.
- S2: **The panel appears without waiting on the network.** «deberia ser instantaneo como cuando hago click en
  changes, agents de la sidebar» and «alguna tecnica o algo para que cargue mas rapido y arreglar lo que demora al
  hacer click a una issue de la sidebar». A numbered open (`/issues N`, which is what the rail dispatches) pins the
  repository identity from the checkout's CACHED scope instead of forcing a fresh `git`/`gh` proof before the first
  frame, and starts the identity proof and the TUI helper load together instead of one after the other. A plain
  `/issues` typed by the user keeps the fresh proof it has today. Nothing that mutates is loosened: every action
  still re-proves the checkout with a fresh read and refuses when it drifted (`scopeDrift`), and every read still
  binds the pinned `<host>/<owner>/<repo>`. The first frame is still seeded from the rail's cache for that identity.
- S3: **The mark is the number of the latest pull request.** «se supone que el icono de pr ya no iba que en su lugar
  saldria el numero de la pr como #35, con maximo mostrar 1 pr, la ultima asociada a esa issue». The mark in the
  rail is already `#<number>` (commit `efca368`, T9 of the rail), never a glyph; what this spec fixes is WHICH
  pull request: the MOST RECENT one that references the issue, not the oldest. One mark per row, at most one number.
  No linked pull request, no mark.
- S4: **Documented and pinned.** AGENTS.md invariant 3, `docs/reference.md` and the tests state the single-flight rule, the
  cached-scope open and the latest-PR mark. The whole suite stays green: `node --test tools/*.test.js`.

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1, S2, S4 | worker: single-flight in the click path and the cached-scope numbered open (`extensions/odd-worktree-tools.ts`, `lib/issues-section.js`, new `tools/issues-open-guard.test.js`, `tools/issues-section.test.js`, AGENTS.md, `docs/reference.md`) | Landed at `b78993a` (single-flight, cached-scope open, 18/18) and `d076a90` (the clicked row's identity pinned with no probe, 23/23; the invariant lives in `docs/codebase/invariants.md`, AGENTS.md being only the index) |
| T2 | S3 | worker: the latest linked pull request in the one related-issues query (`lib/gh-issues.js`, `tools/gh-issues.test.js`) | Landed at the commit `fix(issues): mark the newest pull request on a rail row` (88/88 in `tools/gh-issues.test.js`; the two assertions in `tools/issues-section.test.js` that pinned the oldest-first order were rewritten by the parent) |

## Log

- L1 (user, verbatim): «otro detalle es que hacer click a alguna Issue si abre el panel de issue, pero el problema es que nos es instantaneo y deberia serlo, lo cual causa que me de pie a que aprete otras issues mientras carga (deberia bloquear o que si apreto otras no haga nada, no bloquear click sino quitar efecto mientras esta cargando una pero deberia ser instantaneo como cuando hago click en changes, agents de la sidebar). Tamibien no  se ajusto el icono se supone que el icno de pr ya no iba que en su lugar salidra el numero de la pr como #35, con maximo mostrar 1 pr, la ultima asociada a esa issue. Y nose si metiste la cache o algo al panel de issues que usara cuando issues sidebar esta activa o alguna tecnican para que cargue mas rapido y arreglar lo que demora al hacer click a una issue de la sidebar, alguna tecnica o algo»
- L2 (parent, findings from the read-only map of the click path, path:line against `main` at `ed026a8`):
  the click dispatches `pi.sendUserMessage("/issues N")` through `dispatchIssuesPanel` (`extensions/odd-worktree-tools.ts`), which is the host's only supported way to run a privileged command from a click and is synchronous; the wait is entirely in the command that runs next. `executeIssues` awaits `pinRepo()` BEFORE mounting, and `pinRepo` is a FRESH identity read (`effectiveRepo(true)`: `git` plus, for a single-remote checkout, one or two `gh` network calls), so the panel cannot appear before that settles; the first-ever open also pays the memoized gate probe (`gh api user` + `gh repo view`). There is NO in-flight guard anywhere: two clicks send two `/issues N` messages and stack two overlays. The panel already seeds its first frame from the rail's cache (`issuesSidebarCachedPages`) and the issue detail is fetched per opened overlay. The marker `#N` already ships (`lib/issues-section.js`, `row.meta`), the user's screenshot predates `efca368` (the running session simply had not reloaded); the open defect in it is the ORDER: the related-issues query reads `timelineItems(first:10, itemTypes:[CROSS_REFERENCED_EVENT])` (`lib/gh-issues.js`, `relatedIssuesQuery`), which returns the oldest ten events chronologically, and `pullRequestNumber` takes the first one, so the mark names the oldest referencing pull request, not the latest. The change that keeps the cost at ONE request for the three views: read the LAST events instead.
- L3 (parent, decisions): S2 is scoped to a numbered open (the rail's own dispatch) rather than to every `/issues`, so a typed `/issues` keeps the fresh proof the panel documents; the writes stay protected by `scopeDrift`, which re-proves with a fresh read on every action. The single-flight state lives in the extension (the click and the command share one module), released from `executeIssues` at every exit and bounded by a timer, because `sendUserMessage` is void by contract and no host event reports that a panel opened.
- L4 (parent, closing evidence): the rail click now opens without waiting on the network. The first measurement (`b78993a`) showed the cached-scope pin still cost one `gh repo view` (~0.6 s) on a single-remote checkout, so the click's own identity is used: the row was read from that repository and the click carries it, so `/issues N` pins exactly that identity with no git and no gh child (one-shot per number and session; a typed `/issues N`, a stale generation or another number keeps the cached-scope pin, a plain `/issues` keeps the fresh proof, and every action still re-proves fresh through `scopeDrift`). Measured with the real gh on this repository, 7 interleaved runs per arm: mount median 534.3 ms without the hint (1 gh child per run) against 3.1 ms with it (0 children), reported by the worker and not reproduced by the parent, whose own checks were the tests: `tools/issues-open-guard.test.js` 23/23 and the full unit stage 1760/1760. The newest-PR mark landed at `4abfd5d` (88/88 in `tools/gh-issues.test.js`; read-only `gh api graphql` confirmed `last:` returns the newest events, but this repository has no issue with two referencing pull requests, so the multi-PR ordering is pinned by fake-runner tests only). `Risk: item 2 (the open now trusts the clicked row's repository instead of proving the checkout)`: bounded because the identity can only come from a rail row this session read, the generation check drops it across sessions, and every write path re-proves the checkout fresh and refuses on drift, which a test pins. No independent verifier was run. Nothing pushed.
