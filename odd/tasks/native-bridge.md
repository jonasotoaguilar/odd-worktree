# Feature: native-bridge

odd-worktree stops depending on the external gentle-shell-bridge package: the bridge's API and runtime are
vendored into this package and published at the same process-global slot, so other plugins can keep extending
gentle-shell through odd-worktree alone.
Worktree `native-bridge`, branch `feat/native-bridge`, base `main@588ac3b`.

## Specs

- **S1** — "ya no quiero depender de /home/jona/dev/projects/gentle-shell-bridge para este plugin"
- **S2** — "eliminar dicha dependencia agregando/copiando las feactures de bridge que usaba odd-worktree de forma
  nativa, o sea, replicaremos la API del bridge en este plugin"
- **S3** — "usaremos la misma para aplicar lo que teniamos con bridge, como sidebar, customize, etc."
- **S4** — "Asi odd-worktree ya no depende de bridge, y dejamos esta api de bridge en odd worktree para que otros
  plugins puedan usarla para expandir gentle-shell a travez de odd-worktree (sin requerir del bridge)"

## Design (rework after L3: the bridge is odd-worktree's own code, not a second plugin inside)

- The bridge's features are odd-worktree's NATIVE shell API, flattened as its own code: runtime in
  `lib/shell-api/*.ts` (no nested package, no `package.json` there, no "verbatim copy" rule), tests in
  `tools/shell-api/*.test.ts` (+ `.mjs`), docs in `docs/shell-api/` (contract, architecture, state, README,
  `examples/bash-card.ts`). No `PRD`, no standalone README, no skill (L2), no standalone banner/assets.
- Public compatibility is kept on purpose: every `Symbol.for("gentle-shell-bridge...")` key, the slot
  `gentle-shell-bridge/api/v1`, `bridgeApi()`/`onBridgeApi`, `VERSION` (0.16.2, gates consumers read) and the
  store directory `<config home>/gentle-shell-bridge` do not change, so third-party plugins and saved choices keep
  working, and a standalone bridge, if still installed, shares the same global state ("first wins").
- `/bridge-status` and its module `lib/shell-api/status.ts` are REMOVED (L3: "bridge status no sirve"); the command
  count goes back to six. `lib/bridge-host.js` goes with it.
- odd-worktree speaks in its own voice: the two diagnostics that matter are notices from odd-worktree itself —
  `gentle-pi` missing (its sidebar, customize rows and card designs are off) and a foreign/incompatible object on
  the slot (its surfaces are off) — worded as this package's, visible once per process (L3: "sigue siendo
  silencioso").
- Plugin attribution (`plugin-lines.ts`): the shell-api modules are plumbing (their own directory is skipped as the
  caller); odd-worktree's own registrations stay an ordinary plugin with the same footer line it had.
- The single extension entry imports `../lib/shell-api/extension.ts` (publishes the slot at module load) and calls
  its factory first; the gate/hold/install hint stay gone.
- Shell-api tests run with `node --test tools/shell-api/*.test.ts tools/shell-api/*.test.mjs` (Node >= 22.18,
  script `test:shell-api`); the plain-JS suite `tools/*.test.js` stays Node >= 18 with the import stubbed.

## Tasks

- **T1** (S1, S2) — vendor the whole bridge verbatim at `lib/bridge/`; its suite green (980/981 pass, 0 fail). DONE `67530be`.
- **T2** (S2, S3) — entry imports the vendored extension and calls it first; gate, ready hold and install hint removed; fixture stubs the import; `tools/*.test.js` 3547 tests, 0 fail.
- **T3** (S4) — docs, invariants (1/3/8 rewritten, new invariant 32), README, mental model, code map, reference, `files` negations, `test:bridge`, CI step on Node 22/24. DONE (tools 3548 tests 0 fail; bridge 980 pass 0 fail; `npm pack` ships lib/bridge/src, none of test/assets).
- **T4** (S1-S4) — real `pi --mode rpc` with only this package: slot published (v1, 0.16.2, 12 members); with a fake `gentle:customize` host command `/bridge-status` shows 2 row providers, 2 sections, tool designs; with the standalone bridge loaded too (both orders) `/bridge-status` resolves exactly once, because `lib/bridge-host.js` holds this copy's registration until `session_start` (native review R1-001/R3-001/R4-001). DONE.

Slice note: the 2 commits before this one are 59k lines because `67530be` is the verbatim vendor copy (reviewed by diff against the source, not by line); the wiring and docs commits are the reviewable ones.

Verify (independent `gentle-ai-verify`, Risk item 5): S1-S3 pass; S4 flagged the incompatible-slot case — the vendored bridge still reports a foreign slot object and keeps `/bridge-status`, so the docs now say that instead of "silent"; stale 22.18 wording and the "armed before" claim fixed; opt-in real-host test `tools/native-bridge-rpc.test.js` added (NATIVE_BRIDGE_PI). One parallel-run flake (`issues-section.test.js` 4 !== 3) did not reproduce (serial runs 0 fail).

- **T5** (S2, S3, L3) — flatten `lib/bridge` into `lib/shell-api` (done mechanically by the parent), remove `/bridge-status`
  + `status.ts` + `bridge-host`, own-voice notices, fix attribution, keep every compat symbol, tests green.
- **T6** (S4, L3) — docs rewritten from odd-worktree's perspective: `docs/shell-api/*`, README, reference, invariants
  (1/3/8/32), mental model, code map, AGENTS.md; CI/`package.json` script `test:shell-api`.

## Log

- **L1** — "ya no quiero depender de /home/jona/dev/projects/gentle-shell-bridge para este plugin asi que lo que
  haremos sera eliminar dicha dependencia agregando/copiando las feactures de bridge que usaba odd-worktree de
  forma nativa, o sea, replicaremos la API del bridge en este plugin y usaremos la misma para aplicar lo que
  teniamos con bridge, como sidebar, customize, etc. Asi odd-worktree ya no depende de bridge, y dejamos esta
  api de bridge en odd worktree para que otros plugins puedan usarla para expandir gentle-shell a travez de
  odd-worktree (sin requerir del bridge)"
- **L2** — "Ademas la skill esta demas, es estupido, si esa era del otro plugin"
- **L3** — "lo de bridge status y demas igual tenias que adaptarlo, bridge status no sirve, lo mismo la doc, pusiste el bridge dentro del plugin no sus feactures, sigue siendo silencioso, como si tuvieras 2 plugins dentro, quedo mal" (answers: flatten as own code; remove /bridge-status; 'avisa poco si falta gentle-pi o el slot es ajeno' -> own notices)
