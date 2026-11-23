# user-prompt-card

Draw the user's own prompt in the transcript as a card on this package's substrate, active only while `Card activity` answers `activity`.
Branch `feat/user-prompt-card`, worktree `user-prompt-card`. Lives in this package only; the bridge is not touched.

## Specs

- S1. The card is active only while the bridge's `Card activity` line answers this package's `activity` design. The user asked: "es posible que este diseno se active cuando este activo el card activity "activity"?"
- S2. Switching that line to `default` repaints the prompt back to Pi's own exact output, with no restart, like the other cards. The user asked: "recuerda que al igual que los otros si desactivo activity se debe repinta si lo pongo en default"
- S3. The design is the first one shown (heading `✿ You`, body rows below, same chrome as the tool cards), with the border and the rest of the chrome in the `accent` role, in both `float` and `neon`. The user asked: "podemos usar para borde y demas el accent rol" and "dije el anterior, el prinmero, porque me sigues dando la segnda opcion, el icono y demas" (so: the `✿` glyph stays, no `❯`).
- S4. It must read differently from the tool cards: "no ser exactamente igual". The whole frame in `accent` (tool cards paint tone roles) is the distinction. Evidence correction (L5): the body keeps Pi's OWN paint from its Markdown clone (`userMessageText` for plain glyphs), not this package's `text` role — a card that repainted the body in `text` would change the user's text colour, which is not what was asked.
- S7. The card must survive the host's own lifecycle: no stale theme after a theme switch, and no prototype left wrapped when the lazy host import resolves after `session_shutdown` (evidence L5).
- S5. It lives in this package, not in the bridge: "el bridge es para lo de gentle base nomas, esto no va ahi". The bridge has no surface for a user prompt, so the card patches `UserMessageComponent.prototype.render` (the class is exported by `@earendil-works/pi-coding-agent`).
- S6. Where Pi, the class, the bridge or the reader is absent or throws, the prompt is Pi's own output byte for byte.

## Tasks

- [x] T1 (S1-S7) route: worker. Module `lib/user-prompt-card.js` (card + gate + prototype shim), wiring in `extensions/odd-worktree-tools.ts`, tests in `tools/user-prompt-card.test.js`, `package-surface` expectations. Commits: `52236f6` (card + tests), `53adbd5` (wiring + package-surface), `8f4c363` (session boundary), `34c1935` (teardown ownership as a precondition).
- [x] T2 (S1-S7) route: inline. Docs: `docs/codebase/code-map.md`, `docs/codebase/invariants.md` (invariant 29), `docs/codebase/mental-model.md`, `docs/reference.md`, `README.md`, `AGENTS.md`. Commit: `5d45562`.

Slice boundary: the code landed as three commits — `52236f6` is the module with its tests (1285 authored lines, past the ~400-line slice on purpose: one module and the behaviour it proves cannot be split without a commit that ships dead code), `53adbd5` is the integration, `8f4c363` the lifecycle correction — and the docs as `5d45562`. Delivery shape is the user's call when publishing.

## Log

- L1: "bien implementa este diseno y que funcione con activity, recuerda que al igual que los otros si desactivo activity se debe repinta si lo pongo en default"
- L2: "y no de dije que ocn el bridge, el bridge es para lo de gentle base nomas, esto no va ahi"
- L3: "Me gusta, pero quizas igual tiene que tener alguna variaron o algo distintivo, para distinguir de las tools callas" then "no ser exactamente igual"
- L4: "me gusto mas el anterior, pero podemos usar para borde y demas el accent rol que dices" then "dije el anterior, el prinmero, porque me sigues dando la segnda opcion, el icono y demas"
- L5 (evidence, not a requirement change): independent probes on real Pi 1.6.0 + bridge 0.16.1 found four defects in the first implementation — memo keyed only on the inner width reusing `neon` chrome for a `float` draw; OSC 133 markers appended instead of prefixed (Pi's TUI strips prefixes only); the "no I/O in render" claim false because the gate is one live selection read per paint; a stale theme in the Markdown clone after a theme switch; and the deferred host import re-patching the class after `session_shutdown`. Also: the body's real paint is `userMessageText`, which corrects S4's wording.
- L6 (evidence): four independent verifier passes on real Pi 1.6.0 + bridge 0.16.1 closed, in order, the rendering defects, two session-boundary races (a silent publication waking the surface with no teardown owner, and a factory load patching before any session), and finally the teardown-ownership precondition (`34c1935`). Final verdict at `3898981`: S1-S7 met, no remaining defect — the live flip returns Pi's exact native array by reference on `default`, both styles draw accent chrome with the prefixed OSC-133 pair, row counts are 5 neon / 7 float for three body rows, and a paint pays one gate read always plus one style read only while the card draws. Suite 2705 tests, 2672 passed, 33 skipped, 0 failed; focused 28/28.
