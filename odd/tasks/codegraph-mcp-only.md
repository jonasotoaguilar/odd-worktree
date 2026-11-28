# codegraph-mcp-only

CodeGraph is reached only through its MCP server; `Codegraph+` and `Worktrees+` default Off; turning `Codegraph+` On wires the MCP entry and
the subagents. Package: pi-odd-worktree. Branch: feat/codegraph-mcp-only (base main@7ad5725).

## Specs

S1. The CodeGraph prompt text no longer describes a native `codegraph` tool with `query`/`explore` operations: the only CodeGraph tool is the MCP one,
`mcp__codegraph__codegraph_explore`. The user said: "hay que hacer ajuste a nuestro prompt /home/jona/.pi/agent/agents/gentle-ai-explore.md explore ya no
es como antes que decia del uso de codegraph se elimino por completo, hay que ajustarlo, ahora en todos la unica tool de codegraph es mcp, ya no existe
query o explore hay que ajustarlo en orchestrar prompt y demas". That agent file is a gentle-shell managed asset that carries no CodeGraph text; the text
this package appends to it is `lib/codegraph-prompt/explore.md`, so that is what is adjusted, together with the orchestrator text and every doc or test
that still names the old shape.

S2. `Codegraph+` On makes `<config home>/tools.json` carry the MCP server `mcp__codegraph` in the `add` list of the CodeGraph agents (`gentle-ai-explore`,
`gentle-ai-verify`, `gentle-ai-worker`, `jd-fix-agent`); `Codegraph+` Off takes it out. The user said: "si codegraph+ esta activo
/home/jona/.pi/gentle-ai/tools.json debe crear/configurar esos agentes agregandoles el campo de mcp codegraph (agregar solamente, para no reemplazar,
modificar si tiene otros igual) y solo si tiene codegraph+ y si lo tiene desactivado lo revisa y saca si lo tiene desactivado codegraph+, saca de ahi el
mcp codegraph". Add only: every other agent, tool name and `remove` entry stays; the file is created when missing.

S3. Turning `Codegraph+` On adds the `codegraph` server to `<agent dir>/mcp.json`. The user said: "si activa codegpah+ agrega codegraph al mcp como
esta aqui /home/jona/.pi/agent/mcp.json".

S4. Both switches default Off. The user said: "Por defecto cambia docegraph+ y worktree+ vienen mejor por defecto apagadas".

S5. `Codegraph+` can be turned On only when the `codegraph` CLI is installed. The user said: "en el caso de codegraph+ solo deja activar/on si tiene
codegraph cli instalado."

S6. The CodeGraph instructions make models use the MCP tool more and better: they say what the tool is for (not only structural questions: exploring,
researching, reading a named file or symbol, preparing an edit), how to query it, and they drop the wording that makes it optional. The user said: "ademas
me pasa todavia que las intrucciones de codegraph son precarias, aun lo ocupa demasiado poco, tanto en modelos pequenos como frontier. nose si es la
redaccion como lo dice /home/jona/dev/upstream/skill-diet o algo mas. investiga sobre el tema." and "por lo que hay que tambien revisarlo para mejorarlos y
que use mas la tool mcp codegraph, porque sigue usandola muy poco o mal". The research and the tool tests are reported to the user, not shipped.

## Tasks

- [x] T1 (S4, S5) switches: default Off, `Codegraph+` On refused without the CLI. Route: inline. Commit: see git log (feat(modules))
- [ ] T2 (S2, S3) wiring: tools.json reconcile (On adds, Off removes, checked at session start) and the mcp.json entry at the moment of the switch. Route: inline. Commit: -
- [ ] T3 (S1, S6) prompts: every role's CodeGraph text, the runtime reminders, docs and tests name only `mcp__codegraph__codegraph_explore` and say what it is for and how to query it. Route: inline. Commit: -

## Log

L1. "/home/jona/.pi/gentle-ai/tools.json bien, ya funciona, entonces hay que hacer ajuste a nuestro prompt /home/jona/.pi/agent/agents/gentle-ai-explore.md
explore ya no es como antes que decia del uso de codegraph se elimino por completo, hay que ajustarlo, ahora en todos la unica tool de codegraph es mcp,
ya no existe query o explore hay que ajustarlo en orchestrar prompt y demas"

L2. "ademas hay que agregar que si codegraph+ esta activo /home/jona/.pi/gentle-ai/tools.json debe crear/configurar esos agentes agregandoles el campo de
mcp codegraph (agregar solamente, para no reemplazar, modificar si tiene otros igual) y solo si tiene codegraph+ y si lo tiene desactivado lo revisa y
saca si lo tiene desactivado codegraph+, saca de ahi el mcp codegraph"

L3. "ademas de que si activa codegpah+ agrega codegraph al mcp como esta aqui /home/jona/.pi/agent/mcp.json. Por defecto cambia docegraph+ y worktree+
vienen mejor por defecto apagadas, y en el caso de codegraph+ solo deja activar/on si tiene codegraph cli instalado."

L4. "ademas  me pasa todavia que las intrucciones de codegraph son precarias, aun lo ocupa demasiado poco, tanto en modelos pequenos como frontier.
nose si es la redaccion como lo dice /home/jona/dev/upstream/skill-diet o algo mas. investiga sobre el tema. y pruba las tools, la del mcp, la tool nativa
de explore y query, revisa y prueba y explicame para que son y que dicen las instrucciones, quizas los modelos no tienen claro para lo que son o sus casos
de uso. Son para preguntas estructurales, pero quizas no entiende que tipo de preguntas, y no solo preguntas sino que para exploracion, investigacion. por
ejemplo si te digo que use el color de rol de checking, actualente eso lo delega o haze varias bash, cuando quizas podria ser mejor usar un explore o query
y listo, 1 tool. Es un ejemplo, pero revis mas, revisa codegraph y revisa su doc web y cli para entender todo el mundo que es la base de codigo indexada y
sus posiblidades, es muy potente, pero como es algo externo los modelos no la entienden o no la usan como principal aunque es mejor en la mayoria de casos
por lo que hay que tambien revisarlo para mejorarlos y que use mas la tool mcp codegraph, porque sigue usandola muy poco o mal"
