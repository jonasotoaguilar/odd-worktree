# /card:bash — the bash activity card, toggled

Branch: feat/card-bash · Delivery: single PR, no push yet · Tests: `node --test tools/*.test.js`

## Specs

- S1: «agregaria el comando /card:bash el cual es un toogle, que alterna entre el diseno default de gentle y el nuestro, o sea apaga o enciende el nuestro.»
- S2: «que el nuestro seria que pinta las cards de tool bash por activadad y las genericas no reconocidas las deja como "$ bash"»
- S3: «Estava el cheking, explore y varios mas.»
- S4: «basado en esas feat para gentle shell me gustaria implementar lo mismo pero mediante plugin.»
- S5: «Revisalo para ver como implementarlo en este plugin odd-worktree. / nose si seria mendiante un wrapper o mediante repintando la tool, ahi revisa solucion»
- S6: «Nuestro, encendido (activity)» — the default state is OUR card on.
- S7: «Sí, en un archivo del home de Pi» — the choice survives a restart, in the Pi home.

Reference: the user's own gentle-shell branch `cards-bash-v2` (`/home/jona/dev/projects/gentle-shell-worktrees/cards-bash-v2`), commits `1daaf00b2 c80793071 3904d7a8a 2efdb1007 5f3ee0685 869254e2c e5f7470f5 ccaa49f52 43353dbb3 8c2a19561 31e8b21fd 781db4626`, read-only.

## Tasks

- T1 [S1,S6,S7] The mode: `lib/card-bash-mode.js` (process-wide slot + strict `<home>/card-bash.json`, read live, written atomically on toggle, `own` the default) and the `card:bash` command that flips it, reports the new state, and repaints what is on screen. Surface tests and the AGENTS.md invariant update land with it. Commit: `feat(cards): toggle the bash activity card with /card:bash`.
- T2 [S2,S3,S4] The classifier port, part 1: `lib/bash-activity.js` — the shell segmenter and the named families (checking, formatting, preparing, publishing, versioning, codegraph, exploring) with their marks and theme roles, plus the ported assertions that state each family's rule. Commit: `feat(cards): classify bash activity families`.
- T3 [S2,S3,S4] The classifier port, part 2: the destructive family — the SQL and heredoc evidence (`lib/bash-destructive.js`, ported from `destructive-card-activity.ts` + the recognizer it reuses), and `x bash` generic whenever any segment is unnamed. Commit: `feat(cards): name the destructive bash family`.
- T4 [S2,S5] The card and the seam: `lib/bash-card.js` (heading identity, collapsed detail, rail, elapsed, body rows, generic `$ bash` fallback) drawn on `lib/shell-card.js`, and the resolver registered through the host's `registerToolRenderer`, composing with `lib/codegraph-card.js` (a `codegraph …` command keeps the CodeGraph identity; every other bash call is ours when the mode is `own`, the host's own drawing when it is `default`). Commit: `feat(cards): draw bash calls as activity cards`.
- T5 [S1,S2,S3] Docs and the shipped surface: README, `docs/reference.md`, AGENTS.md purpose and invariants, `npm pack --dry-run`, whole-suite green. Commit: `docs(cards): document the bash card and its toggle`.

## Log

- L1: «/home/jona/dev/projects/gentle-shell-worktrees/cards-bash-v2

basado en esas feat para gentle shell me gustaria implementar lo mismo pero mediante plugin.

agregaria el comando /card:bash el cual es un toogle, que alterna entre el diseno default de gentle y el nuestro, o sea apaga o enciende el nuestro.

que el nuestro seria que pinta las cards de tool bash por activadad y las genericas no reconocidas las deja como "$ bash". Estava el cheking, explore y varios mas. Revisalo para ver como implementarlo en este plugin odd-worktree.

nose si seria mendiante un wrapper o mediante repintando la tool, ahi revisa solucion»
- L2: Answers to the two open decisions: «Nuestro, encendido (activity)» (S6) and «Sí, en un archivo del home de Pi» (S7).
- L3: Design decision, from the host's own API: the seam is `pi.registerToolRenderer(resolver)` — `(toolName, next) => ToolRenderers | undefined`, resolved per row and per paint, `next()` yielding the built-in bash renderers. No wrapper (nothing spawns or intercepts `bash`) and no tool redefinition (nothing is registered, executed or shadowed): the change is the drawing, switched live by re-deciding per paint. Repaint of rows already on screen is `context.invalidate()`. `renderShell: 'self'` is required so the host does not frame our card in its own box.
- L4: `/card:bash` is a valid command name: the host validates a non-empty string and a handler only, and Gentle Shell already registers `gentle:customize`.
- L5: Composition with the CodeGraph card: both resolvers delegate through `forwardedComponent(inherited, …)` in either load order. A `codegraph …` bash command keeps the CodeGraph identity and its full output (one program, one card); every other bash call is this feature's.
- L6: Out of scope, deliberately: the reference's per-row reveal meter and its `activity|output` sub-modes. The toggle here is ours-vs-host, and expansion follows the host's `expanded` and its own key hint, as the CodeGraph card already does.
- L8: Live repaint needs no seam. `ToolExecutionComponent` (`dist/modes/interactive/components/tool-execution.js`) resolves the renderers once per row in its constructor, but the component a renderer RETURNS has its `render(width)` called on every frame, and every display update (`updateResult`, `setExpanded`, `invalidate`) replaces it. So a card that builds its rows INSIDE `render(width)` re-decides per frame: this package's `component(build)` in `lib/codegraph-card.js` already works that way, and it is why gentle-shell's `ToolCardRows.render` re-reads its own preference on every pass. The mode is read at PAINT time, never at construction, and the toggle repaints rows already on screen with no `ctx.ui` seam — the first implementation wrongly concluded the opposite because it looked for an explicit repaint call.
- L9: Slice note, recorded as required: T1 landed as one 832-line commit. The mode file, the command and the amended invariants are one contract (a command whose file format the invariants do not describe is not reviewable alone), and the tests of the three are the same three descriptions.
- L7: This changes the package's declared surface (AGENTS.md "exactly three commands", "no configuration surface"), so the purpose line, invariant 3 and `tools/package-surface.test.js` are amended by T1 and T5 rather than quietly bypassed.
