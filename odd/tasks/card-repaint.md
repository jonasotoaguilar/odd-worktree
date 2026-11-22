# card-repaint

Switching the `Card activity` line between `default` and `activity` must repaint every card of that line already on screen, not only
the next one. Package: pi-odd-worktree. Branch: fix/card-repaint (base main@53ae2b2).

## Specs

S1. Turning the line to `activity` (or back to `default`) repaints the cards ALREADY on screen for every tool the line covers —
`bash_background`, `monitor`, `job_stop`, `job_list`, the native `codegraph` tool and the MCP explore tool — exactly as it already
does for `bash`. The user: "encontre igual un bug con bash background, monitor y los recordatorios de explore/verify que agregamos a
activity y es que alternar entre default/activity no los repinta como si lo hace con bash, codegprah. Eso es un bug, deberia
funcionar igual, si usa lo mismo del bridge."

S2. The reason it failed: Pi resolves a tool renderer ONCE per card, when the component is built
(`dist/modes/interactive/interactive-mode.js:1861`), and the bridge re-runs only the adopted design's `apply` per pass
(`src/tool-design-wiring.ts:294-318`). So the gate must move INSIDE the component's `render()`, which does run on every pass.

S3. With `activity` off, a job tool's row must be byte-identical to what Pi draws for a tool with no renderer
(`tool-execution.js`: the padded `toolPendingBg` box with `createCallFallback()` inside it), and the CodeGraph card must hand the row
back to the chain's own renderer it captured when it was built.

S4. Nothing else changes: the same rows, marks, tones, content levels and `Card style` behaviour; no new tool, command or row; the
message cards stay as they are unless a test proves they do not follow the line per pass.

S5. The message cards (`gentle-pi.exploration-budget`, `gentle-pi.verifier-settle-reminder`) are followed per pass by the bridge
(`src/message-design-wiring.ts:239-247`). Prove it with a test that flips the line and repaints the mounted component; only if that
test fails does this task change them.

## Tasks

- [ ] T1 (S1-S3) per-paint gate for the jobs card and the CodeGraph card, with the host's own default box when off. writer.
- [ ] T2 (S4, S5) prove the message cards follow per pass, and update the docs that describe the build-time limit. writer.

## Log

L1. [Image#4] encontre igual un bug con bash background, monitor y los recordatorios de explore/verify que agregamos a activity y es que alternar entre default/activity no los repinta como si lo hace con bash, codegprah. Eso es un bug, deberia funcionar igual, si usa lo mismo del bridge.
