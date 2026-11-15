# codegraph-guards

Two non-blocking reminders appended to the result of a search or read tool call, so a model that skips the `## CodeGraph` rule is
pointed back to it at the moment it does. Package: pi-odd-worktree. Branch: feat/codegraph-guards (base main@1745e3c).

## Specs

S1. Guard 1, "another checkout": the user said "si es otro cwd da igual mismo u otro proyecto le inyecte que use tool mcp con projectpath
y delegue si no resuelve la duda segun regla #CodeGrapg." and drafted "Revisaste otro checkout, sigue regla #CodeGraph y llama primero a
mcp__codegraph__codegraph_explore con ese path." The injected text (English, final, approved):
`This call went to <path>, another checkout. Follow the CodeGraph rule: call mcp__codegraph__codegraph_explore with projectPath set to <path> first.`
(`<path>` is the real checkout root, `mcp__codegraph__codegraph_explore` and `projectPath` in backticks.) "guard 1 seria solo para
orchestrator claro": it runs in the primary session only, never in a subagent child. "un recordatorio por checkout por sesion": once per
other checkout per session. Both the same project's other worktree and another git project count.

S2. Guard 2, "same checkout": the user drafted "Recuerda seguir regla #CodeGraph y usar query o explore primero si corresponde." and asked
"tambien poner ese recordatorio si usan grep/find/ls/read o bash y demas un subagente antes que codegraph". Injected text (English, final):
for a primary session and for the explore agent: `Follow the CodeGraph rule: run codegraph query or explore first, if it applies.`
(`codegraph`, `query` and `explore` each in backticks, as in the rule texts); for every other agent (verify, worker, fix, judges, generic):
`Follow the CodeGraph rule: call mcp__codegraph__codegraph_explore first, if it applies.` The role is chosen exactly like
`lib/codegraph-rules.js` chooses a rule text (the native operations only where the role holds the native tool). Once per session, on the
session's own checkout. "guard 2 es transversal para orchestrator y agentes definimos, (todos menos review- agents)": it runs in the
primary session and in every subagent except the `review-*` agents, which get nothing (as in `lib/codegraph-rules.js`). "la segunda una vez
por sesion".

S3. What counts as a call: `grep`, `find`, `ls`, `read` and `bash`. `read` counts only for a code file: not `.md`, `.json`, `.yml`,
`.yaml`, `.toml` or `.txt` (the rule exempts configs and docs). `bash` counts only when the command reads code with a search or read verb
(`grep`, `rg`, `find`, `fd`, `ls`, `cat`, `sed`, `head`, `tail`, `awk`, `tree`) and, for guard 1, when a `cd <path>` target or an absolute
path argument of the command lies in another checkout: "bash cwd es por sesion pero dentro puede hacer un cd <ruta> o sea, ejecutar bash
en otra ruta ... asi que el guard debe protegerlo." A command that only mentions a checkout (`git -C`, `curl`, `echo`) is not a call.

S4. What is "another checkout": the git toplevel (`git -C <dir> rev-parse --show-toplevel`) of the target directory differs from the
session's own. A path with no git checkout (tmp, /etc, home, logs) triggers nothing: "no podemos bloquear tmp u otros, solo bloquearia si es
otro proyecto git" (nothing blocks any more, see S6; the criterion for what counts stays).

S5. Precision: "la idea es que sea preciso". Guard 1 stays silent if this session already called `mcp__codegraph__codegraph_explore` with that
checkout as `projectPath` since the last compaction. Guard 2 stays silent if the session already used `codegraph` or the MCP tool
since the last compaction. A reminder that does not fire does not use up its once-per-key slot.

S6. Nothing blocks. The reminder is one extra text part appended to the tool result of that call (the result is kept whole), never a
separate message and never a block. It applies only when the `codegraph` CLI is installed and the session holds a CodeGraph tool (the same
gate as the prompt section). It adds no tool and no command.

S7. Reset: both guards forget what they reminded on a compaction ("Que se reseatean si compacta"). The session's own checkout can change
(`/warp`): guard 2 is keyed by that checkout, so a warp re-arms it.

S8. Constraints (AGENTS.md): plain CommonJS under lib/, Node 18 floor, node:test, no dependencies, no network; every child is a fixed argv
with a bounded timeout and is awaited, never `spawnSync`; the git toplevel is read once per directory and cached; every seam
injectable; tests use temp dirs and fakes; a hook never throws into the host and never delays a tool result by more than the bounded git
read. The CodeGraph module list in `tools/package-surface.test.js` and AGENTS.md (layout row, a new invariant for "reminders, never
blocks") are updated together with the code.

## Tasks

- [ ] T1 (S1, S2, S5, S6, S7): the decision core `lib/codegraph-guard.js`: from one finished tool event, the session checkout, the role
  and what the session already used, decide the reminder (or none), keep the once-per-key state, reset on compaction. Pure, injectable.
  Route: worker. Commit: feat(codegraph): decide the two CodeGraph reminders.
- [ ] T2 (S3, S4, S8): the target analysis: which checkout a `grep`/`find`/`ls`/`read`/`bash` call went to (paths, `cd`, absolute
  arguments, code-file filter for `read`), the async cached git toplevel. Route: worker. Commit: feat(codegraph): find the checkout a
  search call went to.
- [ ] T3 (S6, S7): wire it in `lib/codegraph-session.js` (`tool_result`, `session_compact`, the role and tool gate, the warp re-arm) and
  append the text to the result. Route: worker. Commit: feat(codegraph): append the reminders to the result of a search call.
- [ ] T4 (S8): AGENTS.md layout row and invariant, `docs/reference.md`, README line, `tools/package-surface.test.js` closed list.
  Route: worker. Commit: docs: describe the two CodeGraph reminders.

## Log

L1 (user, original request, verbatim): "habria que crear un guard que bloquee tool grep/find/ls/bash en otro cwd (solo se admite otro cwd si
resulta ser un worktree del actual, mismo proyecto), si es otro path de otro proyecto lo bloquea y en el error exige delegar a agente explore
para investigarlo. Si es otro cwd pero es un worktree en la primera de grep/find/ls/bash (solo una por sesion y resetea si compacta) se le
inyecta que recuerde delegar a explorer si es una investigacion no menor (revisa aqui cual era la regla de cuando delegar a explorer, creo
que era 2k tokens o mas, lo de explroer budge). Y otro guarda para la primera grep/find/ls/bash por sesion si es dentro del mismo cwd (igual
se reseatea si compacta), que le recuerde que use codegraph primero si corresponde segun reglas #CodeGraph. que te parece?"

L2 (user): "1 estoy de acuerdo, no podemos bloquear tmp u otros, solo bloquearia si es otro proyecto git / 2 bash cwd es por sesion pero
detro puede hacer un cd <ruta> o sea, ejecutar bash en otra ruta como aqui [Image#6], asi que el guard debe protegerlo. / 3. revisa bien,
existe un exploration.budget que es cuando alcanza cierta cantida de tokens leidos inlines, si tiene una regla."

L3 (user): "entonces no hay que crear otra tool sino que agregar a orchestration rule codegraph su uso si necesita consultar a uno de sus
worktrees u revisar otro proyecto git." (done in PR #47; no new tool.)

L4 (user): "juntmeos A y B, si es otro cwd da igual mismo u otro proycto le inyecte que use tool mcp con projectpath y delegue si no resuelve
la duda segun regla #CodeGrapg." (so nothing blocks, S6.)

L5 (user): "muy detallado para agente / Revisaste otro checkout, sigue regla #CodeGraph y llama primero a mcp__codegraph__codegraph_explore con
ese path. / y el otro / Recuerda seguir regla #CodeGraph y usar query o explore primero si corresponde. / Son bien simples y una vez por
sesion la seguna y la primera una vez por sesion igual pero considerando checkout, o sea un recordartorio por checkout por sesion. Que se
reseatean si compacta. / igual revisa si estan bien el recordatorio, la idea es que sea preciso, si el detalle ya lo tiene su syrtem prompt
de codegraph seccion."

L6 (user): "eso esta bien igual, tambien poner ese recordatorio si usan grep/find/ls/read o bash y demas un subagente antes que codegraph".

L7 (user): "me parece bien, impelenta los guard" (answering the proposal with the `read` code-file filter, the warp re-arm and "never block").

L8 (user): "guard 1 seria solo para orchestrator claro".

L9 (user): "guard 2 es transversal para orchestrator y agentes definimos, (todos menos review- agents)"
