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

## Design (decided by the parent, not asked)

- The bridge is vendored VERBATIM as a nested package at `lib/bridge/` (its own `package.json`, `src/`, `test/`,
  `docs/`, `examples/`, `skills/`, `README.md`). `lib` is already in `files` (invariant 8 holds); tests, assets and
  skills are excluded from the npm tarball by `files` negations. The nested package keeps the bridge's attribution
  root (`plugin-lines.ts` BRIDGE_ROOT = `lib/bridge`), so odd-worktree itself stays an ordinary plugin with the
  same footer line it had.
- All `Symbol.for("gentle-shell-bridge...")` keys and the `<config home>/gentle-shell-bridge` store directory are
  unchanged: third-party plugins and users' saved choices keep working, and a standalone bridge, if also
  installed, shares the same global state ("first wins").
- The single extension entry statically imports `../lib/bridge/src/extension.ts` (publishes the slot at module
  load) and its factory calls the vendored bridge factory first (arms on `session_start`, `/bridge-status`).
  The "load nothing without the bridge" gate, the ready-event hold, the install hint and its warn slot go.
  `subscribeBridgeReady` stays (rebinding on a republished bridge is generic, harmless).
- Bridge tests run with `node --test lib/bridge/test/*.test.ts lib/bridge/test/*.test.mjs` (Node >= 22.18); the
  plain-JS suite `tools/*.test.js` keeps running on Node 18+ with the bridge import stubbed by the fixture.
- The standalone skill ships inside `lib/bridge/skills` but is NOT registered (`pi.skills`), so it never
  duplicates the one the standalone bridge ships.

## Tasks

- **T1** (S1, S2) — vendor the whole bridge verbatim at `lib/bridge/`; its suite green (980/981 pass, 0 fail). DONE `67530be`.
- **T2** (S2, S3) — entry imports the vendored extension and calls it first; gate, ready hold and install hint removed; fixture stubs the import; `tools/*.test.js` 3547 tests, 0 fail.
- **T3** (S4) — docs, invariants (1/3/8 rewritten, new invariant 32), README, mental model, code map, reference, `files` negations, `test:bridge`, CI step on Node 22/24. DONE (tools 3548 tests 0 fail; bridge 980 pass 0 fail; `npm pack` ships lib/bridge/src, none of test/assets).
- **T4** (S1-S4) — real `pi --mode rpc` with only this package: slot published (v1, 0.16.2, 12 members); with a fake `gentle:customize` host command `/bridge-status` shows 2 row providers, 2 sections, tool designs; with the standalone bridge loaded too (both orders) `/bridge-status` resolves exactly once, because `lib/bridge-host.js` holds this copy's registration until `session_start` (native review R1-001/R3-001/R4-001). DONE.

Slice note: the 2 commits before this one are 59k lines because `67530be` is the verbatim vendor copy (reviewed by diff against the source, not by line); the wiring and docs commits are the reviewable ones.

## Log

- **L1** — "ya no quiero depender de /home/jona/dev/projects/gentle-shell-bridge para este plugin asi que lo que
  haremos sera eliminar dicha dependencia agregando/copiando las feactures de bridge que usaba odd-worktree de
  forma nativa, o sea, replicaremos la API del bridge en este plugin y usaremos la misma para aplicar lo que
  teniamos con bridge, como sidebar, customize, etc. Asi odd-worktree ya no depende de bridge, y dejamos esta
  api de bridge en odd worktree para que otros plugins puedan usarla para expandir gentle-shell a travez de
  odd-worktree (sin requerir del bridge)"
