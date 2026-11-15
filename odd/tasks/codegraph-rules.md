# codegraph-rules — CodeGraph compatibility inside pi-odd-worktree

Integrate CodeGraph with Gentle Shell **through this package only** (Gentle Shell is not modified), taking ideas from the
plugin `/home/jona/dev/upstream/gentle-shell-codegraph-subagents` and from the native fork
`/home/jona/dev/projects/gentle-shell-worktrees/codegraph-native` as inspiration. Neither is a target: nothing is changed there.

Reference sources (read-only, git-ignored copy inside this checkout): `odd/reference/plugin/` (the plugin's `src/` and `test/`).

## Specs

- **S1** — Scope. «no podemos modificarlo nativo». The package stays the compatibility layer: no new model-facing tool, no tool
  named `codegraph`, no shadowing of another extension's tool, no reliance on extension load order, no edit of
  `~/.pi/agent/agents/*.md`, no kill of a daemon this package did not start, and no edit of the user's MCP configuration beyond the
  one `mcpServers.codegraph` entry of the global `mcp.json` that S12 describes (every other server and field is preserved).
  `AGENTS.md` invariant 2 is rewritten to allow exactly this surface; every CodeGraph child is a fixed argv with a bounded
  timeout, awaited asynchronously (invariants 9 and 13 hold).
- **S2** — Index preparation is create-or-sync. «init por detras si no existe .codegraph en el path hace init, si existe hace
  sync». It runs per session at `session_start` (startup, new, resume, fork; not `/reload`, not a subagent child) for the
  session's checkout. `worktree_create` is not touched: it already starts CodeGraph for the checkout it makes. The root is the git
  toplevel. It reports which action it
  took (init, seed, sync), runs in the background and never blocks the session or a create. The CLI's presence is checked once
  per process; without it nothing here runs.
- **S3** — Every index write is coordinated. Init, sync and worktree seeding go through one init lock and one per-project sync
  lease; a request that cannot be coordinated is reported, never silently dropped, and a queued, coalesced or failed run is never
  reported as synced. A linked worktree without an index is seeded from the main checkout's index (a copy while nobody writes
  it, then one sync in the worktree); it never shares the main index.
- **S4** — Native `codegraph init` is observed, never replaced. «seria como un hook cuando hace init». After a successful native
  `codegraph init` result the package requests one coordinated sync and appends the outcome (completed, pending, failed,
  unavailable, skipped read-only) within a 10 s bound. A failed init keeps its error and starts no sync. The hook never makes
  the tool call fail.
- **S5** — Daemon, proxy and MCP. The daemon is resolved per checkout from `~/.codegraph/daemons/*.json` (a live registered one is
  reused before warming one; the parent's daemon is never used for a child checkout). Warm-up runs `codegraph serve --mcp` for the
  checkout through CodeGraph's own proxy, bounded, and is skipped while an init runs. MCP is optional: a registered MCP entry is
  not proof that a daemon is reachable, and a session with no MCP server works. The package warns when the MCP explore tool is
  hidden by `toolExposure` or the server is missing, and never edits the configuration.
- **S6** — Read-only roles never write the index. Verify and the judges (a command tool, no file-writing tool) never initiate init
  or sync; logs and notices distinguish completed, pending, skipped and failed.
- **S7** — Prompt rules. One `## CodeGraph` section per role through `appendSystemPrompt` (done: `lib/codegraph-rules.js`,
  `lib/codegraph-prompt/*.md`).
- **S9** — Freshness without a daemon (from Engram 9685, the freshness layer of PR #16). After a successful `edit` or `write` the
  package requests one background sync for the edited file's checkout (git toplevel, cached per directory), debounced, on the same
  S3 lease so two sessions never collide, skipped when a live daemon watches that root (its watcher already syncs) and when the
  root has no `.codegraph`. A sync cost is dominated by CLI startup (0.19-0.29 s), so one background process per debounce window.
- **S10** — CodeGraph tool card. BASE: the user's own PR #74 in `jonasotoaguilar/gentle-shell` (`feat/cards-bash-v2`), whose
  `lib/codegraph-card-preview.ts` and tests are copied under `odd/reference/pr74-card/` (the mark, the title role, the operation as the
  detail, collapsed rows by operation, the bash-invoked call recognition). OUR ADDITION on top: the MCP `codegraph_explore` tool, the
  resolver that draws these calls on this package's own card substrate, and the repaint when the Card content level changes; an
  earlier attempt is kept under `odd/reference/plugin-card/` (Engram 9499, 9567, 9568, 9662; plugin commit `eb17474`). The PR sent to
  the zhalker plugin repo is unrelated and is not a source.
  The native `codegraph` tool, the MCP `codegraph_explore` tool and a `bash` call that runs CodeGraph are drawn as one card on the
  package's own card substrate (`lib/shell-card.js`, card style from the shell): one CodeGraph title and icon, the operation as the
  detail, one collapsed line that tells init from sync from the real CLI output, the full CLI output expanded, no specialized
  fallback, and every other tool drawn by the host untouched. It never depends on load order: the resolver hands back what it did
  not own.
- **S11** — Everything CodeGraph applies only when the CodeGraph CLI is installed. «igual lo de codegraph deberia solo aplicarse si
  tiene codegraph cli instalada claro». The CLI is probed once per process (fixed argv, bounded timeout, async, the answer cached); a
  missing CLI disables the index preparation, the post-init and edit/write syncs, the warm-up, the MCP entry check and the card for
  the whole session. The prompt section already needs a CodeGraph tool in the session, which exists only with the CLI.
- **S12** — The global MCP entry. «revisa igual config de pi /home/jona/.pi/agent/mcp.json si ... tiene codegraph, si no lo tiene le
  agrega ... si lo tiene pero no esta asi, lo arregla (me refiero a campos, el formato es irrelevante)». Once per process, after S11
  says present and in a primary session only, the package ensures `mcpServers.codegraph` of `<agent dir>/mcp.json` has
  `command: "codegraph"`, `args: ["serve", "--mcp"]` and `toolExposure.codegraph_explore: "direct"`: it adds the entry when it is
  missing (and the file when the agent directory exists), fixes only the fields that differ, and keeps every other field and
  server. The file is rewritten only when something changed, atomically (temp file in the same directory, then rename), keeping its
  permission bits; an invalid or unreadable file is left untouched and reported. A change is reported once, saying Pi must be
  reloaded for the MCP tool to appear.
- **S8** — Documentation and tests. README (documentation template), `docs/reference.md` and `AGENTS.md` describe the surface;
  tests cover S2–S6 through the public surface with injected runners (no real CodeGraph, no network, no real daemon).

## Tasks

| ID | Task | Specs | Status |
| --- | --- | --- | --- |
| T1 | Prompt rules per role | S7 | done (`94c1224`) |
| T2 | Coordination: init lock, sync lease, create-or-sync, seeding | S2, S3 | |
| T3 | Daemon resolution, warm-up, MCP warnings | S5 | |
| T4 | Post-init `tool_result` hook and role rule | S4, S6 | |
| T5 | Extension wiring: session start, compaction, warm-up, CLI gate once, card resolver (no `worktree_create` step) | S2 | |
| T6 | Docs, invariants and surface test | S1, S8 | |
| T7 | CodeGraph tool card | S10 | |
| T8 | Sync after edit/write, debounced, on the T2 lease | S9 | |
| T9 | CLI probe once per process, shared by every CodeGraph step | S11 | |
| T10 | Ensure the global `mcp.json` CodeGraph entry | S12 | |

## Log

- **L1** — user: «me gustaria integrar o mejorar codegraph de gentle shell usa, aqui un ejemplo de plugin que lo intenta
  /home/jona/dev/upstream/gentle-shell-codegraph-subagents. y otra implementacion nativa que intente hacer
  /home/jona/dev/projects/gentle-shell-worktrees/codegraph-native»
- **L2** — user: «quiero agregar mejor compatibilidad para codegraph en gentle shell mediante el plugin, o sea, no podemos
  modificarlo nativo.»
- **L3** — user: «te dije exactamente que te espiraras en esos 2 y en el worktree para integrarlo en este plugin» and «nunca te
  dije que trabajaras en ese otro, si no es mio».
- **L4** — user: «lo del daemon, proxy, el manejo de mcp» and «teniamos el plan perfecto y te lo mandaste a otro proyecto».
- **L5** — user: «y lo de las pintado de tools, tienes engram, en serio se te olvido todo, ni intentas recordar, falta mucho mas
  que hasta a mi se me olvido».
- **L6** — Engram reconciliation: S9 (freshness layer 9685) and S10 (cards) were missing; the three `/codegraph-*` commands stay out
  because worktree-tools-v2 S2 removed them on purpose; veto them back in if wanted.
- **L7** — user: «worktree_create ya lo tiene iniciar codegraph, lo demas esta bien del plan». The `worktree_create` step is
  dropped from S2 and T5; the rest of the plan stands.
- **L8** — Decision: the fork's pooled MCP child serves the native `codegraph` tool's query/explore, which this package cannot
  replace (S1); nothing here would call it, so it is not ported.
