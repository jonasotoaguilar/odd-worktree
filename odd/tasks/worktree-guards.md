# worktree-guards

Two `bash` guards that keep one ODD in its own checkout: no worktree is created
through Git, and the principal checkout holds no branch work. Branch
`feat/worktree-guards`, worktree `odd-worktree-worktrees/worktree-guards`.

## Specs

**S1 — No worktree creation through `bash`, in any cwd.**
User: *"si intenta hacer tool bash de comando para crear worktree usando tool bash,
o sea un comando con git de create (tool bash) lo bloquee y le diga que use tool de
create worktree de este plugin, esto en cualquier cwd."*
User: *"el detecto de worktree create es simple si la tool bash tiene dentro el
comando para crear worktree lo bloquea, da igual el resto, revisa si adentro o
combinacion intento crear (no se pone a revisar scriopts o archivos que usa seria
muy costoso y especifico)"*

A `bash` tool call whose `command` string contains, in any combination, the token
sequence `git` … `worktree` … `add` is blocked before execution: the handler
returns `{ block: true, reason }`, so the command never runs. Detection is text
only — no shell execution, no file read, no discovery of what a script, alias,
`Makefile`, `package.json` script or subprocess would do. It covers `git -C
<path> worktree add`, `git --no-pager worktree add`, and the same sequence inside
`&&`, `||`, `;`, `|`, `&`, a newline chain and a `$(…)` substitution. It applies in
every cwd, including inside a worktree. `git worktree list`, `remove`, `prune` and
`move` are NOT blocked: only creating is.

**S2 — The branch guards apply only in the principal checkout.**
User: *"si el cwd de la sesion es el main del proyecto no un worktree"* and
*"Igual como dije solo si el cwd de la sesion es el repo principal, el cwd de
worktrees no aplican claramente."*

Scope is the session cwd (`ctx.cwd`, else the event/process cwd). The guard is
active only when that cwd is the principal checkout of its repository: the
absolute Git dir equals the absolute Git common dir. Inside a linked worktree the
two differ and nothing is blocked. A cwd that is not a Git repository blocks
nothing.

**S3 — Creating a branch in the principal checkout is blocked.**
User: *"el comando de cambiar de crear rama se bloquee tire error y diga que cree
un worktree y trabaje ahi."*

Blocked: `git checkout -b <name>`, `git checkout -B <name>`, `git checkout
--orphan <name>`, `git switch -c <name>`, `git switch -C <name>`, and a bare
`git branch <name>` whose argument is not an option. The reason says the branch is
created inside a worktree: create it with `worktree_create`, work there, and
nothing was executed.

**S4 — Switching away from the default branch in the principal checkout is blocked.**
User: *"Y el comando de cambiar de rama igual se bloquea excepto si intenta
cambiar/volver a rama main/master la principal, si intenta cambiar a otra le
bloquea y tira error y le dice que trabaje en un worktree."*

Blocked: `git checkout <ref>` and `git switch <ref>` when `ref` is not the default
branch; `git checkout -` and `git switch -`; a detached `git checkout <sha>`.
Allowed: `git checkout <default>`, `git switch <default>`, and `git checkout` or
`git switch` with no branch argument.

**S5 — The default branch is the repository's real default.**
Decision (questionnaire): *"La rama por defecto real del repo — Se resuelve como
el create: local main, si no origin/HEAD, si no init.defaultBranch."*
Resolved exactly like the create's base: the local `main` when it resolves, else
the branch `origin/HEAD` names, else `init.defaultBranch`. There is no literal
`main`/`master` allowlist, so a repository whose default is `master` allows
`master` and a repository whose default is `trunk` allows `trunk`.

**S6 — Everything else passes untouched.**
File restores (`git checkout -- <path>`, `git checkout <path>`, `git restore …`),
inspection (`git status`, `git branch` with no argument or only options,
`git branch -a`, `-v`, `-d`, `-m`), `git worktree list|remove|prune|move`, and every
non-`bash` tool call are unaffected. Staging, committing, merging, rebasing and
pushing are out of scope: not requested.

**S7 — No new surface, no escape hatch.**
Decision (questionnaire): *"Sin escape: siempre bloquean"* — no environment
variable, no config file, no command, no tool, no option. The shipped surface
stays three commands, two tools and one sidebar section (AGENTS.md invariant 3);
the guard is a `tool_call` observation registered in
`extensions/odd-worktree-tools.ts` that introduces no name the host or the agent
can call.

**S8 — Honest failure, never a false block.**
The handler never throws, because a thrown `tool_call` handler blocks the tool
fail-safe. When the repository identity for S2 cannot be resolved, only S1
applies. Every refusal states that the command did not run; an allowed call emits
nothing.

**S9 — Listing worktrees through `bash` is blocked, in any cwd.**
User: *"agrega al plan el guard que bloquee tool bash intenta usar comando git para
listado de wortrees, ahi debe usar tool."*

A `bash` tool call whose `command` string contains the token sequence `git` …
`worktree` … `list` is blocked with `{ block: true, reason }`, with the same
text-only, any-cwd, compound-aware detection as S1 (no scripts, aliases or files
are inspected). The reason says the command did not run and that `worktree_list`
is the tool to use (`all: true` also shows the worktrees Git knows outside
`<repo-name>-worktrees`). `git worktree remove|prune|move` stay untouched.

**S10 — The refusals teach the rule, not only the block.**
Every refusal of S1, S3, S4 and S9 names the order the agent should follow:
`worktree_list` first to see whether the ODD already has a checkout, then
`worktree_create` only when it has none. A guard is a net: the rule (T4) is what
should keep the agent from reaching it.

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1–S6, S8–S10 | inline parent: `lib/worktree-guard.js`, the pure scanner and decision | `feat(guard): refuse worktree creation and branch work outside a checkout` |
| T2 | S1, S2, S7, S8, S9 | inline parent: the `tool_call` wiring in the extension, exercised through `tools/fixtures/load-extension.js` | same slice as T1 |
| T3 | S7 | inline parent: AGENTS.md invariant 20, `docs/reference.md`, README bullet | `docs: state the worktree guards` |
| T4 | S10 | parent: rule text `lib/odd-prompt/odd-worktrees.md`, the two tool descriptions in the extension, `tools/odd-worktrees-prompt.test.js`. PROPOSED, applied only after the human accepts the wording in the Log (L6) | `docs(prompt): make worktree_list the first step of every ODD` |

## Log

**L1** (user, verbatim):
> la idea es que cada odd sea en su worktree para que no choquen trabajo en paralelo.
>
> meteria al plugin un nuevo guard de que si intenta hacer tool bash de comando para crear worktree usando tool bash, o sea un comando con git de create (tool bash) lo bloquee y le diga que use tool de create worktree de este plugin, esto en cualquier cwd.
>
> y otro guarda de que si el cwd de la sesion es el main del proyecto no un worktree entonces el comando de cambiar de crear rama se bloquee tire error y diga que cree un worktree y trabaje ahi. Y el comando de cambiar de rama igual se bloquea excepto si intenta cambiar/volver a rama main/master la principal, si intenta cambiar a otra le bloquea y tira error y le dice que trabaje en un worktree. Igual como dije solo si el cwd de la sesion es el repo principal, el cwd de worktrees no aplican claramente.

**L2** (user clarification, verbatim):
> o sea, el detecto de worktree create es simple si la tool bash tiene dentro el comando para crear worktree lo bloquea, da igual el resto, revisa si adentro o combinacion intento crear (no se pone a revisar scriopts o archivos que usa seria muy costoso y especifico)

**L3** (decisions, questionnaire): default branch = the repository's real default,
resolved like the create's base; no escape hatch; bounded compound detection with
no descent into scripts or files.

**L4** (parent decision, unrequested cases): file restores and inspection are
allowed; `git checkout -`, `git switch -` and a detached `git checkout <sha>` are
blocked because they leave the default branch; `git worktree list|remove|prune`
are not blocked because they create nothing.

**L5** (user, verbatim):
> aqui otro error, no usaste tool worktree list para revisar los worktrees que existen. Nose si la regla de odd worktree lo menciona su uso muy flojo y necesita arreglo.
>
> y nose si tambien requerira un guard para forzar que use esa tool para ver los worktrees, pero lo principal seria arreglar la reglas cosa que los guards nunca salten porque el agente las sigue bien.
>
> worktree list deberia usarla previo crear un worktree o previo a iniciar cualquier odd nuevo o un odd reanudar uno existe, para ver si existe worktree asociado.
>
> revisa la regla de odd y porpon ajuste si lo consideras, y tambien agrega al plan el guard que bloquee tool bash intenta usar comando git para listado de wortrees, ahi debe usar tool.

**L6** (parent proposal for T4, pending the human's acceptance). Evidence: the
current text only says `worktree_list` "finds existing assignments" (descriptive,
no moment named), and neither tool description tells the agent to call it first.
Proposed text for `lib/odd-prompt/odd-worktrees.md`:

> ## ODD worktrees
>
> A worktree lives at `<repo-parent>/<repo-name>-worktrees/<odd>`: the directory IS the ODD it serves. One ODD, one worktree: parallel ODDs never share a checkout, so they never collide.
>
> **Call `worktree_list` first**, before you create a worktree, start a new ODD, or resume an existing one. It is the only way to see whether that ODD already has a checkout; never list worktrees with `git worktree list` through bash, it is refused.
> - The ODD has a worktree: resume there. Do the work in that checkout, never create another for it.
> - It has none: call `worktree_create` with `odd` and `branch`; pass `copy_changes: true` when pending changes belong to that work.
>
> Never create a worktree or a branch with git through bash (`git worktree add`, `git checkout -b`, `git switch -c`): it is refused. In the main checkout, do not start branch work: create the ODD's worktree and work there.
>
> Work on the same feature goes into its ODD, adding tasks, and therefore into its worktree; a different feature is a different ODD, with another worktree. You may delegate several subagents in parallel, on the same or on different worktrees, as long as they do not edit the same files.
>
> After the merge, keep the branch and remove the worktree, unless a session is standing in that checkout.

Proposed tool descriptions: `worktree_list` gains "Call this first, before creating
a worktree or starting or resuming an ODD: it tells you whether the ODD already has
a checkout."; `worktree_create` gains "Call `worktree_list` first: an ODD that
already has a worktree is resumed, not created again."

**L7** (parent, process incident): before creating `worktree-guards` the parent
checked existing checkouts with `git worktree list` through `bash` instead of
`worktree_list`, the exact behavior S9 and T4 exist to prevent. No duplicate
resulted (the ODD had no checkout), but the order was wrong.
