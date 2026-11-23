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

- [ ] T1 (S1-S7) route: worker. Module `lib/user-prompt-card.js` (card + gate + prototype shim), wiring in `extensions/odd-worktree-tools.ts`, tests in `tools/user-prompt-card.test.js`, `package-surface` expectations. Commit: pending
- [ ] T2 (S1-S6) route: inline. Docs: `docs/codebase/code-map.md`, `docs/codebase/invariants.md` (new invariant), `docs/codebase/mental-model.md` (invariant count), `docs/reference.md`, `README.md`. Commit: pending

## Log

- L1: "bien implementa este diseno y que funcione con activity, recuerda que al igual que los otros si desactivo activity se debe repinta si lo pongo en default"
- L2: "y no de dije que ocn el bridge, el bridge es para lo de gentle base nomas, esto no va ahi"
- L3: "Me gusta, pero quizas igual tiene que tener alguna variaron o algo distintivo, para distinguir de las tools callas" then "no ser exactamente igual"
- L4: "me gusto mas el anterior, pero podemos usar para borde y demas el accent rol que dices" then "dije el anterior, el prinmero, porque me sigues dando la segnda opcion, el icono y demas"
- L5 (evidence, not a requirement change): independent probes on real Pi 1.6.0 + bridge 0.16.1 found four defects in the first implementation — memo keyed only on the inner width reusing `neon` chrome for a `float` draw; OSC 133 markers appended instead of prefixed (Pi's TUI strips prefixes only); the "no I/O in render" claim false because the gate is one live selection read per paint; a stale theme in the Markdown clone after a theme switch; and the deferred host import re-patching the class after `session_shutdown`. Also: the body's real paint is `userMessageText`, which corrects S4's wording.
