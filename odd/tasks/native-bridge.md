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

- Bridge sources are vendored verbatim under `lib/bridge/*.ts` (shipped: `lib` is already in `files`, invariant 8
  holds). They keep every `Symbol.for("gentle-shell-bridge...")` key, so third-party plugins keep working
  unchanged and a standalone bridge, if also installed, shares the same global state ("first wins").
- The single extension entry imports the vendored extension, so the slot is published at module load and the
  factory arms it. The old "load nothing without the bridge" gate, the ready-event wait and the install hint go.
- Bridge tests live in `tools/bridge/*.test.ts` (need Node >= 22.18 type stripping); the plain-JS suite
  `tools/*.test.js` keeps running on Node 18+ with the bridge import stubbed by the shared fixture.
- Bridge docs/example move to `docs/bridge/`; the standalone skill is not registered here (it would duplicate
  the one the standalone bridge ships).

## Tasks

- **T1** (S1, S2) — vendor src, tests, docs, example; paths adjusted; bridge suite green on this Node.
- **T2** (S2, S3) — wire the entry to the vendored bridge; remove the gate, hold, ready wait and install hint;
  fixture stubs the import; `tools/*.test.js` green.
- **T3** (S4) — docs: invariants 1/3/8 + the native-bridge rule, README, mental model, code map, reference,
  `docs/bridge/` entry for plugin authors, CI step for the TS suite on Node >= 22.
- **T4** (S1-S4) — verify: real load through jiti with only this package, slot published, rows/sections/designs
  registered; coexistence with the standalone bridge in one process.

## Log

- **L1** — "ya no quiero depender de /home/jona/dev/projects/gentle-shell-bridge para este plugin asi que lo que
  haremos sera eliminar dicha dependencia agregando/copiando las feactures de bridge que usaba odd-worktree de
  forma nativa, o sea, replicaremos la API del bridge en este plugin y usaremos la misma para aplicar lo que
  teniamos con bridge, como sidebar, customize, etc. Asi odd-worktree ya no depende de bridge, y dejamos esta
  api de bridge en odd worktree para que otros plugins puedan usarla para expandir gentle-shell a travez de
  odd-worktree (sin requerir del bridge)"
