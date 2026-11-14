# card-style-click — one fresh lib per load, and a card that expands on a click

Two defects on the three cards this package draws, with the human's own words as
the authority: a running session serves stale `lib/` code, and an expand
affordance that was supposed to be the whole card only answers on its hint.

## Specs

- **S1** — «Defect 1 — a running session serves stale `lib/` code (the real bug)
  `extensions/odd-worktree-tools.ts:42` loads `lib` modules with Node's `require`.
  Pi loads the extension itself with jiti `moduleCache:false` (upstream
  gentle-shell says so in `lib/shell-card.ts:30-33`), so the extension file is
  fresh but every `require`d `lib` module stays cached from the first load. After
  an update, a resumed session runs a NEW extension against OLD modules.
  Observed live: `worktree_create` failed with
  `registry.parseWorktreePorcelain is not a function` — that function exists on
  disk and the new extension calls it, but the loaded module predates it. The
  same staleness is why a `neon` configuration still rendered float cards.» —
  therefore: «Fix it so one load of the extension loads its `lib` modules once,
  fresh: no cross-load cache survival. Keep the `GENTLE_WORKTREE_LIB_DIR` seam
  the tests use, keep a single load per extension instance (do not re-read on
  every call), and prefer reusing the host loader if the SDK exposes one — say
  which you chose and why. This must never touch Gentle Shell.»
- **S2** — «Defect 2 — expand needs a click on the hint only. In gentle-shell a
  card expands when you click anywhere on it. In this package only the `ctrl+o to
  expand` hint responds. Fix it for all three bash surfaces: the `/warp` card,
  `worktree_create`, `worktree_list`.»
- **S3** — «Find out how this Pi build routes a click to a tool card before
  choosing a mechanism — read the SDK docs and types … If the host truly only
  expands from the hint or from `ctrl+o`, say so with the quote and stop, rather
  than simulating input from inside a renderer.» The host does route a click to
  the card itself: `@earendil-works/pi-tui` `tui-alt-screen.js` delivers a click
  only to the component that CLAIMED the press (`mousePressTarget` is recorded
  from the press dispatch, and the synthesized `click` is retargeted to it), and
  `Container`/`Box`/`MouseRegion` forward a normalized `TuiMouseEvent` with
  coordinates local to the receiving component. So a card claims its cells and
  toggles the host's own expansion flag; nothing is simulated.

## Tasks

- T1: this document holds the human's words verbatim (S1–S3).
- T2: one extension load reads the `lib/` subtree from disk once and reuses what
  it read; the next load reads it again (S1).
- T3: the `GENTLE_WORKTREE_LIB_DIR` seam and the "one load, not one read per
  call" rule survive, and Gentle Shell is not touched (S1).
- T4: a behavioural test proves the freshness: a module written on disk, loaded,
  rewritten, then loaded again by a second extension load (S1).
- T5: a left click anywhere on the card toggles expansion on all three surfaces
  and nothing else is claimed — not the right button, not a drag or a move, not a
  cell outside the drawn card (S2, S3).
- T6: keyboard-only hosts keep working: without an injected toggle there is no
  mouse handler at all, and `ctrl+o` remains the single source of truth (S2).
- T7: the extension exposes the loaded instances it uses as a test seam
  (`libModule(name)`), so the three suites that inject a fake into a lib module
  patch the instance the extension actually calls; their assertions are unchanged
  (S1; L2).

## Log

- **L1** — «Defect 1 — a running session serves stale `lib/` code (the real bug)
  `extensions/odd-worktree-tools.ts:42` loads `lib` modules with Node's `require`.
  Pi loads the extension itself with jiti `moduleCache:false` (upstream
  gentle-shell says so in `lib/shell-card.ts:30-33`), so the extension file is
  fresh but every `require`d `lib` module stays cached from the first load. After
  an update, a resumed session runs a NEW extension against OLD modules.
  Observed live: `worktree_create` failed with
  `registry.parseWorktreePorcelain is not a function` — that function exists on
  disk and the new extension calls it, but the loaded module predates it. The
  same staleness is why a `neon` configuration still rendered float cards.
  Fix it so one load of the extension loads its `lib` modules once, fresh: no
  cross-load cache survival. Keep the `GENTLE_WORKTREE_LIB_DIR` seam the tests
  use, keep a single load per extension instance (do not re-read on every call),
  and prefer reusing the host loader if the SDK exposes one — say which you chose
  and why. This must never touch Gentle Shell.
  Defect 2 — expand needs a click on the hint only. In gentle-shell a card
  expands when you click anywhere on it. In this package only the `ctrl+o to
  expand` hint responds. Fix it for all three bash surfaces: the `/warp` card,
  `worktree_create`, `worktree_list`.
  Find out how this Pi build routes a click to a tool card before choosing a
  mechanism — read the SDK docs and types under
  `/home/jona/.pi/agent/install/releases/*/node_modules/@earendil-works/pi-coding-agent`
  (`docs/tui.md`, the type declarations). If the host truly only expands from the
  hint or from `ctrl+o`, say so with the quote and stop, rather than simulating
  input from inside a renderer.»
- **L2** — «**Option A.** The three suites are authorized: `tools/issues-command.test.js`,
  `tools/warp-busy-guard.test.js`, `tools/worktree-remove-async.test.js`.
  Add the seam as you proposed, named `libModule(name)`, and say in its doc comment what it is for:
  the extension's own loaded instance, so a test patches the module the extension actually uses.
  Ten edit sites, each swapping `require('../lib/…')` for the extension's instance — and nothing else
  in those files touched: the assertions stay as they are, because what they prove has not changed.
  That constraint matters: these three suites prove real behaviour (`/issues` read-only, the queued
  warp never mutating a checkout, async removal). Re-pointing where the fake comes from is a
  test-infrastructure fix; weakening an assertion would be a behaviour fix, and that is not
  authorized.»
