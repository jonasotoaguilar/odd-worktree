# skill-read-full

A skill's Markdown is read WHOLE: a `read` of a `.md` below a `skills` folder drops its `offset` and `limit`. Package:
pi-odd-worktree. Branch: feat/skill-read-full (base main@9c01e49).

## Specs

S1. When a `read` call targets a Markdown file below a `skills/` or an `odd/` folder, the call delivers the whole file: an
`offset` and/or `limit` the caller sent are dropped before the tool runs. The user said: "que me pasa que lee skills pero las corta,
y es un comportamiento incorrecto, las skills se leen completas no a medias... si el path es un .md dentro de /skills ruta,
si pone un offet y/o limit da igual, se entrega igual el .md completo, es eso posible?" and, on the mechanism: "o sea,
interceptar la tool".

S2. The interception is a `tool_call` mutation of `event.input`, the host's own documented seam ("`event.input` is mutable...
Mutations to `event.input` affect the actual tool execution... No re-validation is performed after mutation"). It blocks
nothing, adds no command and no tool, and returns no answer.

S3. Nothing else changes: a read of any other path, a skill's non-Markdown file, and a read that already carries no
`offset`/`limit` are left exactly as the host proposed them.

S4. "A skill's or an ODD's Markdown" is the file card's own identity (`lib/skill-odd-card.js`: the `skills` and `odd`
folders, read by path components), reused and never copied, so the card's heading and this rule can never disagree.

S5. The rule — and the `bash` reader guard beside it — exists only while the `Worktrees+` module is on: "que el guard
este activo/funcionando solo si esta on worktree+". With that module off, neither the refusal nor the whole-file read is
registered.

## Tasks

- [x] T1 (S1-S4) the pure decision, the extension's `tool_call` wiring, tests and docs. inline.

## Log

L1. es posible modificar el uso de read, [Image#3] que me pasa que lee skills pero las corta, y es un comportatamiento incorrecto, las skills se leen completas no a medias. Mi idea si es posible si el path es un .md dentro de /skills ruta, si pone un offet y/o limit da igual, se entrega igual el .md completo, es eso posible?
L2. o sea, interceptar la tool
L3. aplicalo tanto para .md de ruta skills/ y odd/ , para tool read, y que el guard este activo/funcionando solo si esta on worktree+
L4. el guard que bloquea bash para imprimir skills creo que cat y otros, igual solo activo con worktree+
