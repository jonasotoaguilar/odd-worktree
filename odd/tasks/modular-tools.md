# modular-tools

Make the plugin modular: two switches, `Codegraph+` and `Worktrees+`, on a new `Tools` page of gentle-shell-bridge's `/gentle:customize`, plus four
cleanups. Package: pi-odd-worktree. Branch: feat/modular-tools (base main@f43e613).

## Specs

S1. Two Off/On switches, `Codegraph+` and `Worktrees+`, registered through the bridge under a new customize section `Tools`. The user said: "agregar con
bridge a customize seccion Tools, ahi dentro se agrega opciones Off/On para "Codegraph+" esa opcion apagada desactiva todo lo agregado del plugin
respecto a codegraph, seria los guards, recordatorios, prompts (orchestrator y agentes)". Both default to On. Everything else (issues, cards, /odd,
/files, the skill-read guard) is transversal and stays as it is.

S2. `Worktrees+` Off disables everything worktree: "prompts orchestrator, tools agentes y comandos (warp, worktree create y list), y todos los guards y
recordatorios". That is the ODD worktrees prompt (both texts), the tools `worktree_create` and `worktree_list`, `/warp` with its card and warp
bookkeeping, and the worktree bash and write guards.

S3. Changing either switch needs a restart, so after a change one short notice says so: "para aplicar cambios haz /reload e inicia una nueva sesion.
Algo breve, pues no basta con reload pues la sesion actual ya tiene las reglas incrustadas." The notice is a Pi notification (the one-line style of
"Switched to ... model").

S4. Delete `lib/odd-prompt/odd-worktrees-child.md` (the one-line child rule): "esa regla, creo que es de subagente, no me gusto, esta demas, borrala."

S5. Review `lib/codegraph-prompt/explore.md` against gentle-shell's `gentle-ai-explore` agent (`assets/agents/gentle-ai-explore.md`), which already
carries CodeGraph rules: "no quiero redundar o repetir lo mismo, quizas corregir redaccion o algo punto, o si ya esta bien dejalo."

S6. Remove the bash guard that blocks listing worktrees through git: "saca/elimina el guard que bloqueaba el git worktree, el para ver la lista, que a
veces lo usa para revisar tras borrar, esta demas creo."

S7. `worktree_list` rows read `path · branch`: "el listado deberia ser path · rama. Actualmente me muestra el path acotado, solo el nombre ... pero deberia
ver el path diria."

## Tasks

- [x] T1 (S4, S5, S6, S7) cleanups: child prompt deleted, explore.md reworded, the list guard removed, `worktree_list` rows as `path · branch`; tests and docs alongside. inline.
- [ ] T2 (S1, S2, S3) `lib/modules.js` + the `Tools` page rows + the notice; gate the Codegraph and Worktree surfaces in the extension; tests and docs. inline.

## Log

L1. Quiero hacer mi plugin modular, o sea, cada uno escoge que activar.
Quiero agregar con bridge a customize seccion Tools, ahi dentro se agrega opciones Off/On para "Codegraph+" esa opcion apagada desactiva todo lo agregado del plugin respecto a codegraph, seria los guards, recordatorios, prompts (orchestrator y agentes). El otro es "Worktrees+" que desactiva/enciende todo lo de worktrees que seria prompts orchestrator, tools agentes y comandos (warp, worktree create y list), y todos los guards y recordatorios. ESos 2 de momento, lo demas es transversal, ya tiene switches como issues, etc, queda igual.
Para esos 2 de tools probablemente requiere reinicio, asi que tras enceder/apagar debe salir mensaje de [Image#1] para aplicar cambios haz /reload e inicia una nueva sesion. Algo breve,pues no asta con reload pues la sesion actual ya tiene las reglas incrustadas.
Otro punto @lib/odd-prompt/odd-worktrees-child.md es que eliminaria esa regla, creo que es de subagente, no me gusto, esta demas, borrala.
/home/jona/dev/upstream/gentle-shell @lib/codegraph-prompt/explore.md igual revisa esa regla de codegraph pues gentle-ai-eplore ya tiene algo de reglas de eso y no quiero redundar o repetir lo mismo, quizas corregir redaccion o algo punto, o si ya esta bien dejalo.
Tambien saca/elimina el guard que bloqueaba el git worktree, el para ver la lista, que a veces lo usa para revisar tras borrar, esta demas creo. Y el worktree list tool arregla la lista o revisala, el listado deberia ser path  · rama. Actualmente me muestra el path acotado, solo el nombre, nose si asi lo pinta o asi lo ve el agente, pero deberia ver el path diria. [Image#1 = a one-line Pi notification "Switched to Claude Sonnet 5.5 1M (thinking: high)"]
