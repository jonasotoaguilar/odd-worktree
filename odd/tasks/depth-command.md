# depth-command — `/depth`: understand a request in depth and explore it in one delegated pass

Goal: one command, `/depth <request>`, that sends the request to a background
`gentle-ai-explore` subagent with extra Depth instructions embedded (from a `.md` file
of this package). The answer — the request understood and the exploration of it — lands
in the main session as a message. Nothing in gentle-shell is modified.

## Specs

- **S1** — «yo estaba pensando en un comando tipo /enhancent o algoa si y que lo que
  haga sea usar esta teoria para investigar el pedido pero no en eseion aparte sino que
  en una delegacion de explore, asi explore le devuelve su respuesta y ya obtenemos 2
  cosas, primero el entendimiento del pedido y segundo tenemos lista la exploracion de
  lo pedido.» A command applies the Depth theory by delegating to `gentle-ai-explore`;
  what comes back is (1) the understanding of the request and (2) its exploration.
- **S2** — «aca la idea no es mejorar el prompt (o sea si lo hace pero no lo devuelve el
  prompt sino el resultado de lo que el prompt correcto busca)». The improved prompt is
  an internal step. The command returns the result of exploring it, not the prompt.
- **S3** — «no podemos modificar gentle-shell por eso decia trabarlo mediante este
  odd-worktree plugin, abria que crear el comando que delegue ese agente incrustandole
  las intruccion adicionales como lo hacia ese plugin de pi-better como el helper.md u
  otros (aqui igual lo haria un .md aparte para poder verlo y modificarlo mas facil y
  solo uno o separados)». Everything lives in this package. The extra instructions are
  a separate `.md` file, easy to read and edit. No file of gentle-shell changes.
- **S4** — «no es posible que directamente en vez de mandar mensaje aca se mande al
  subagente explore incrustandole lo brief extra (pues eso extra seria solo para este
  caso) y luego al terminar la respuesta se mande a la sesion principal.» The command
  starts the explore subagent itself (no message to the model first), with the extra
  brief embedded for this case only; the answer goes to the main session when it ends.
- **S5** — «podria ser como pi-better, que hace un fork de al session en background por
  decir y miesntra trabaja sale arriba del input, aqui podria ser igual solo que en vez
  de un fork lo hace en una session de agente gentle-ai-explore y en vez de pega el
  resultado en el input le llega la respuesta como mensaje a la sesion.» It runs in the
  background, progress shows above the input while it works, and the answer arrives as a
  message in the session.
- **S6** — «bien vamos por depth, implementalo». The command is `/depth`.
- **S7** — «igual no te quedes solo con el ejemplo o recursos del plugin para armarlo,
  haz una investigacion previa primero sobre la tematica y enfoque en estudios, docs,
  etc, por si identificas algo a cosiderar». Research on the topic (studies, docs)
  comes first; whatever it shows that should change the design is reported before it is
  built.
- **S8** — «me parece perfecto» (L6), about the design proposed there: the launch is
  `ctx.executeTool("subagent_run", { agent: "gentle-ai-explore", mode: "background",
  task, label })`; progress, cancellation and delivery are gentle-agents' own (no widget,
  no cancel command, no delivery of our own); ONE file `lib/depth-prompt/depth.md`;
  pure `lib/depth-task.js` and `lib/depth-launch.js`; the command registers inside the
  bridge gate; invariant 3 goes from four commands to five. The handoff returns, in this
  order, under fixed English headings and in the language of the request:
  `## Original request` (verbatim), `## Understood` (adds nothing the original does not
  say; a material ambiguity names the chosen reading), `## Questions` (only when
  ambiguous), `## Map` (`path:line`), `## Not requested` (proposals, each tagged
  `[evidencia: path:line]` or `[inferido]`; never a requirement unless the human accepts
  it), `## How it would be verified` (only externally executable oracles, cited),
  `## Uncertainty`, and `## For the parent`: do not implement, ask the `Questions` first,
  show `Not requested` to the human, wait. `/depth` with no request is refused (the
  explorer never sees the chat). Refined by L8, headings by L9, the opening line by L10.

## Tasks

- [x] **T0** · S7 · research · web explorer (task `mwrbl1jk-2-u08f`) + inline synthesis
  (L8) · commit: — (no code)
- [x] **T1** · S1, S2, S3, S8 · `lib/depth-prompt/depth.md` + `lib/depth-task.js` with
  tests (RED first) · inline · commit: 519ede4
- [x] **T2** · S4, S5, S8 · `lib/depth-launch.js` (injected `executeTool`/`tools`;
  refusals: empty request, no `subagent_run`, the host tool's own refusal) with tests ·
  inline · commit: 519ede4
- [x] **T3** · S3, S6 · register `/depth` in the gate, one `registerCommand`, and the
  three closed-list tests · inline · commit: bc08b3b
- [x] **T4** · S3, S6 · docs: invariant 3 (four → five commands) and 29, `code-map.md`,
  `mental-model.md`, `reference.md`, `README.md`, `AGENTS.md` · inline · commit: the
  commit that closes this feature (`docs(depth)`)
- [x] **T5a** · S8 · real explorer runs on the exact task `buildDepthTask` builds (L10);
  contract hardened · inline · commit: 8e9a631
- [ ] **T5b** · S4, S5 · run `/depth` once in a live interactive session: does
  `executeTool` work from a command's ctx, does the handoff arrive as a message, does
  the parent obey the closing line · needs the human · commit: — (evidence only)

## Log

- **L1** — «yo estaba pensando en un comando tipo /enhancent o algoa si y que lo que
  haga sea usar esta teoria para investigar el pedido pero no en eseion aparte sino que
  en una delegacion de explore, asi explore le devuelve su respuesta y ya obtenemos 2
  cosas, primero el entendimiento del pedido y segundo tenemos lista la exploracion de
  lo pedido. Pues si usamos ese plugin aparte se tiraria un fork de la session que
  explora para mejorar prompt, pero se piede esa exploracion, aca la idea no es mejorar
  el prompt (o sea si lo hace pero no lo devuelve el prompt sino el resultado de lo que
  el prompt correcto busca). seria como si en vez de devolver el prompt mejorado y yo
  mandarlo y ahi que explore directamente lo entiende (indirectamene aqui tiene el
  prompt bueno, el pedido correcto) y explora enseguida y luego devuelve esa
  exploracion que seria lo que buscaba realmente y lo explorado para trabajarlo. que
  piensas? y como lo integrariamos o si tienes otra idea.»
- **L2** — «si, pero no podemos modificar gentle-shell por eso decia trabarlo mediante
  este odd-worktree plugin, abria que crear el comando que delegue ese agente
  incrustandole las intruccion adicionales como lo hacia ese plugin de pi-better como
  el helper.md u otros (aqui igual lo haria un .md aparte para poder verlo y modificarlo
  mas facil y solo uno o separados) me parece lo que dices, que propueta final das?»
- **L3** — «no es posible que directamente en vez de mandar mensaje aca se mande al
  subagente explore incrustandole lo brief extra (pues eso extra seria solo para este
  caso) y luego al terminar la respuesta se mande a la sesion principal. de hecho
  podria ser como pi-better, que hace un fork de al session en background por decir y
  miesntra trabaja sale arriba del input, aqui podria ser igual solo que en vez de un
  fork lo hace en una session de agente gentle-ai-explore y en vez de pega el resultado
  en el input le llega la respuesta como mensaje a la sesion.»
- **L4** — «me parece perfecto pero enhance sera lo correcto? ya no es para mejorar el
  prompt solamente sino para un nuevo pedido no?»
- **L5** — «bien vamos por depth, implementalo, igual no te quedes solo con el ejemplo o
  recursos del plugin para armarlo, haz una investigacion previa primero sobre la
  tematica y enfoque en estudios, docs, etc, por si identificas algo a cosiderar»
- **L6** — «me parece perfecto» (answer to the final design proposal: launch through
  `ctx.executeTool("subagent_run", … background)`, native progress/cancel/delivery, one
  `depth.md`, the six-section handoff). Recorded as S8.
- **L7** — Evidence, not a user decision: an explorer read gentle-shell's sources and
  confirmed (a) `subagent_run` is callable through `ctx.executeTool`, schema
  `agent, task, label, context, work, workspace_root, repository_root, mode`, extra keys
  rejected; (b) a finished background task reaches the parent as
  `gentle-agents.result` with `triggerTurn: true`, not customizable by the launcher;
  (c) it draws its own widget; (d) cancel exists natively (`subagent_cancel`, stop key).
  Unverified: `executeTool` from a *command* ctx (precedent: `job_list`). Worktree:
  `/home/jona/dev/projects/odd-worktree-worktrees/depth-command`, branch
  `feat/depth-command`.
- **L8** — Research findings (S7), evidence not a user decision. Retrieved by the
  explorer: RaR (arXiv:2311.04205) helps on ambiguous tasks but can alter the question
  and over-complicate simple ones; ClarifyGPT (arXiv:2310.10996) shows unclear
  requirements make models deviate from intent and that clarifying questions help;
  Anthropic's multi-agent write-up and the Claude SDK docs: a subagent sees only its
  prompt string, so the verbatim request goes inside it, and a defined output format is
  the most important subagent improvement; Cognition: read-only research subagents are
  the safe case; Lost in the Middle (arXiv:2307.03172): put the key items first and
  last; Huang et al. (arXiv:2310.01798) and Rieseberg himself: use an outside judge, not
  self-review; Rieseberg's Range warning: do what a professional does, do not write like
  one. Unverified by the parent: the 2026 arXiv items the explorer cited (over-eager
  agents benchmark, small-model delegation); none is load-bearing. Refinements applied
  to S8: ambiguity gate (`## Preguntas`), `## Lo pedido` adds nothing, evidence tags on
  proposals, external oracles only, effort scaling, method-not-voice, empty `/depth`
  refused. Not possible: choosing a stronger model for the explorer (`subagent_run` has
  no model parameter), so T5 measures the judgment sections.
- **L9** — Not a user decision: the handoff headings went from Spanish to English. This
  package's prompts and docs are English and the parent reads the headings as a fixed
  contract, so they are English whatever the language of the request; only the body
  follows the request's language. `tools/depth-task.test.js` holds the shipped file to
  the eight headings in order. A new invariant, 29, records that `/depth` only launches;
  invariant 3 goes from four commands to five. Three closed-list tests
  (`package-surface`, `files-bridge`, `files-command`) now expect `depth`.
- **L10** — Evidence, not a user decision. T5a: the real `gentle-ai-explore` ran the exact
  task `buildDepthTask` builds on two Spanish requests. One run translated every heading
  and dropped `## For the parent`, the only barrier against the woken parent
  implementing. Fix (8e9a631): a fixed opening line, "copy each heading character for
  character", and the closing paragraph also in the built-in fallback, held in step by a
  test. Rerun on three requests (two Spanish, one English), checked mechanically:
  opening line first, eight headings in order, none translated, `For the parent` present,
  all three. Content was substantive (it found that a `--dry-run` would make invariant
  29 stale and that the host-tool check is irrelevant when nothing launches) but the
  economical model leaves noise: a self-referential question in `## Questions` and
  repeated, garbled commands in `## How it would be verified`. Read those two sections
  with care. Not covered: `executeTool` from a command's ctx (T5b); `/depth` as
  invoked by the host. Slice boundary: commit 1 was 512 authored lines (tests, the
  feature document and the libs) and commits 1-2 together 617, past the ~400 guide.
