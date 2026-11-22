# message-cards — paint the two ODD advisory messages in the active card style

The two advisory custom messages Gentle Shell sends (`gentle-pi.exploration-budget`,
`gentle-pi.verifier-settle-reminder`) draw Pi's default box: no renderer is registered for either type
anywhere, and the shell's card-style pass is positional, so it drops them at `no-card`. Gentle Shell is
upstream and must not be modified (`/home/jona/dev/upstream/gentle-shell`), so this package paints them
through `gentle-shell-bridge@0.11.0`, which ships the message-design surface and nothing else.

## Specs

S1 — the gate is the switch that already exists, verbatim from the human:
> "y en nuestro caso vencdria activado con el mismo de "card tags" "activity""

Choosing `activity` on the `Card tags` line is what turns these two message cards on. There is no second
switch to flip and no separate first-run seed: the human's existing choice applies.

S2 — the body is never clipped, verbatim from the human:
> "igual considera que por ejemplo ese tipo demensaje deberia verse completo incluso en modo minimal, como
> con worktrree list o create"

Both alerts are INSTRUCTIONS the agent must read, so the card prints every row of the message at any card
content level: no `previewRows`, no `minimal` withholding, no expand hint (nothing is hidden, a hint would
lie). This is the consumer's decision — the bridge clips nothing and reads no level — and it is the exact
opposite of `lib/jobs-card.js:200`.

S3 — the style comes from the host, not from the bridge:
`ctx.cardStyle` is the bridge's own Card style selection (`native` / a registered style / missing), NOT the
host's float/neon chrome. The card reads the host's setting through this package's own reader
(`lib/card-style.js`, `cardStyle()`) inside the paint, so a mid-session flip repaints what is on screen.

S4 — byte stability, the bridge's own contract: with no bridge, an old bridge without the reader, a
non-`activity` selection, a reader that throws, or a design that fails, Pi's own box stays exactly as it
was and no pass pays for the surface.

S5 — one family: the frame, roles and measurement come from this package's substrate
(`lib/shell-card.js`) and its shared helpers (`lib/file-card.js`), exactly as the jobs card does. No
palette, no raw escape sequence, no second card grammar.

## Tasks

| ID | Spec | Route | Risk | Commit |
| --- | --- | --- | --- | --- |
| T1 | S1, S2, S5 | worker (`gentle-ai-worker`) | none (new module, no shared code) | `3b8a515` ✅ — `lib/message-card.js` (26 tests), `lib/bash-design.js` `TOOLS_LINE` export (+3), docs. Slice boundary: 1004 authored lines, one unit (drawing + tests + docs) |
| T2 | S1, S3, S4 | inline (parent) | item 3 (`extensions/odd-worktree-tools.ts` is a host registration surface other extensions load) | `8ca153a` ✅ — the registration beside the jobs card, same bridge-ready path and measurement seam |
| T3 | S4 | inline (parent) | none (removes a path) | `29ba811` ✅ — the capability probe removed; registration depends on the published release alone, failing closed; width guard; docs no longer overstate the cost |
| T4 | S1, S4 | inline (parent) | none (one constant + docs) | `4630d37` ✅ — the floor is `0.12.1`: `0.12.0` has `follows` but let a stored message id veto it, so it cannot keep S1 |

T1 builds `lib/message-card.js` + `tools/message-card.test.js` + the docs. T2 wires the registration in
`extensions/odd-worktree-tools.ts` and commits both slices. Suite after T2: 2623 pass, 0 fail.

Bridge versions: the surface is `gentle-shell-bridge@0.11.0` (message designs) and `0.12.0` (`follows`,
which is what S1 needs). On 0.11.0 this package registers NOTHING — an ungrouped design there would create
its own `Message <type>` switch, the parallel switch S1 forbids.

## Log

L1 — the human, verbatim, on the original defect:
> "[Image#1] recuerdas lo que lo que implemetamos de que siga float/neon las aletar de exploration y verify de gentle shell con activity activo. Y para bash background y monitor, pues no funciona, miralo."

L2 — the human, verbatim, on the gate (S1):
> "y en nuestro caso vencdria activado con el mismo de "card tags" "activity""

L3 — the human, verbatim, on the full body (S2):
> "[Image#6] igual considera que por ejemplo ese tipo demensaje deberia verse completo incluso en modo minimal, como con worktrree list o create, aunque ahi nose si seria del bridge o de aca dicha implementacion"

L4 — the human, verbatim, on who owns the work:
> "bien, agregalo al bridge, abre sesion ahi y avisale que lo agregue"

L6 — independent verification of T2 (read-only `gentle-ai-verify`) rejected the first state and named two
findings that were ours: the capability probe cannot distinguish a refused follow from an unrelated
refusal, and an accepted-then-withdrawn probe can leave the bridge's row provider installed; and the docs
claimed "no extra work per pass" when a claimed-but-inactive alert still paid a selection resolution.
T3 answers both. It also could not execute anything — its preparer refuses a linked worktree
(`unsupported repository: ordinary single-root Git directory required`), so its findings are source-level
and the suite evidence is this document's own.

L7 — bridge `0.12.1` released (tag `v0.12.1`, merge `dd7292d`, release `76b77f6`): a stored message-side id
is never consulted for a follow now (the follow is answered before the message document is opened), and an
inactive follow costs a registry walk with no store read at all. No consumer change: the registration this
package makes keeps working as-is. T4 raises the floor to it, because `0.12.0` cannot keep S1.

L5 — the bridge half is DONE and released, reported by the bridge session (evidence, not a request):
`gentle-shell-bridge@0.11.0`, merge `af3af60`, release `c794dbf`; `node --test` 858 (857 pass, 1 skipped),
`tsc --noEmit` clean, `test/message-design-pi-release.test.mjs` 5/5 against real Pi 1.6.0, byte-identical
`/bridge-status` with no message design. Two corrections it carries: adoption happens on
`CustomMessageComponent.customRenderer` (patching `pi.registerMessageRenderer` captures nobody), and
`ctx.cardStyle` is NOT the host palette (S3).
