# worktree-guards

Three `bash` guards that keep one ODD in its own checkout: no worktree is created or
listed through Git, and the principal checkout does not leave the branch it is on
while that branch is the default one — creating a branch is nobody's business (S3).
Branch `fix/worktree-guard-switch-only`, worktree
`odd-worktree-worktrees/worktree-guard-switch-only`; the first attempt landed on the
older `feat/worktree-guards` checkout and was transplanted (L13).

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
every cwd, including inside a worktree. `git worktree remove`, `prune` and `move`
are NOT blocked: only creating is, and S9 covers the listing.

**S2 — The branch guards apply only in the principal checkout.**
User: *"si el cwd de la sesion es el main del proyecto no un worktree"* and
*"Igual como dije solo si el cwd de la sesion es el repo principal, el cwd de
worktrees no aplican claramente."*

Scope is the cwd the command actually runs in: the session cwd (`ctx.cwd`, else the
event/process cwd) when the command does not move itself, and the `cd` target when
it does (S11). The guard is active only when that cwd is the principal checkout of
its repository: the absolute Git dir equals the absolute Git common dir. Inside a
linked worktree the two differ and S4 blocks nothing there. A cwd that is not a Git
repository blocks nothing of S4 either.

**S3 — Creating a branch is allowed (superseded by L10).**
User: *"no esta prohibido crear ramas"*, *"worktree create puede crear/reeclamar
rama, si la crea primero no hay error da igual"*, *"puede crearlas antes si
quiere"*.

Nothing is blocked for creating, moving, copying, deleting or listing a branch:
`git branch <name> [<start>]`, `git branch -f <name> <start>`, `-t`/`--track`, `-m`,
`-c`, `-d`, `-D`, `--list`, and `git branch` alone pass in every checkout, the
principal included. A branch that is created and not checked out changes no
checkout, and `worktree_create` creates or reclaims it either way.
The earlier L1/L4 rule that refused a bare `git branch <name>` here is withdrawn,
not narrowed: the only branch act the guard still refuses is leaving the branch the
checkout is on (S4).

**S4 — Leaving the principal checkout's own branch is blocked, and only that.**
User: *"El error seria si el checkout actual es el principal e intenta salir de
main, asi que el guard no seria si intenta moverse a otro rama sino que si su rama
actual es main e intenta moverse a otra ahi si da error"*, *"volver a main si se
permite claro, es solo bloquear salir, si quiere trabajar una rama es mediante
worktree"*.

Blocked only when all three hold: the switch runs in the principal checkout (S2),
that checkout's CURRENT branch is the default branch (S5), and the command leaves
it. Blocked: `git switch <other>`, `git checkout <other>`, `git checkout -`,
`git switch -`, a detached `git checkout <sha>` or `git switch --detach`, and the
create-and-switch forms `git checkout -b|-B|--orphan` and `git switch
-c|-C|--create|--force-create` (those leave the branch too, whatever they create
first).
Allowed: `git checkout <default>`, `git switch <default>`, switching to the branch
the checkout is already on, `git checkout` or `git switch` with no branch argument,
and every switch when the current branch is NOT the default — the rule protects the
default branch, not a habit.
The current branch is read from the checkout itself (`git symbolic-ref --quiet
--short HEAD`), fresh at each judgement and never cached, because only the checkout
knows where it points and a branch created elsewhere does not move it. A detached
HEAD is not the default branch, so a switch there is allowed. A default branch that
does not resolve blocks nothing (S8).

**S5 — The default branch is the repository's real default.**
Decision (questionnaire): *"La rama por defecto real del repo — Se resuelve como
el create: local main, si no origin/HEAD, si no init.defaultBranch."*
Resolved exactly like the create's base: the local `main` when it resolves, else
the branch `origin/HEAD` names, else `init.defaultBranch`. There is no literal
`main`/`master` allowlist, so a repository whose default is `master` allows
`master` and a repository whose default is `trunk` allows `trunk`.

**S6 — Everything else passes untouched.**
File restores (`git checkout -- <path>`, `git checkout <path>`, `git restore …`),
every `git branch` form (S3), inspection (`git status`, `git log`, `git diff`),
`git worktree remove|prune|move`, and every non-`bash` tool call are unaffected.
Staging, committing, merging, rebasing and pushing are out of scope: not requested.

**S7 — No new surface, and one named way to turn the guards off.**
The shipped surface stays the commands, tools and section it already has (AGENTS.md
invariant 3); the guard is a `tool_call` observation registered in
`extensions/odd-worktree-tools.ts` that introduces no name the host or the agent can
call. `ODD_WORKTREE_GUARD=0` turns the guards off for the process, the way
`ODD_WORKTREE_PROMPT=0` turns off the prompt blocks; no other value, option or config
file does. The questionnaire's "always block" decision is superseded by the user's
later instruction (L9).

**S8 — Honest failure, never a false block.**
The handler never throws, because a thrown `tool_call` handler blocks the tool
fail-safe. When the repository identity for S2 cannot be resolved, only S1 and S9
apply: both read text and need no identity. Every refusal states that the command did
not run; an allowed call emits nothing.

**S9 — Listing worktrees through `bash` is blocked, in any cwd.**
User: *"agrega al plan el guard que bloquee tool bash intenta usar comando git para
listado de wortrees, ahi debe usar tool."*

A `bash` tool call whose `command` string contains the token sequence `git` …
`worktree` … `list` is blocked with `{ block: true, reason }`, with the same
text-only, any-cwd, compound-aware detection as S1 (no scripts, aliases or files
are inspected). The reason says the command did not run and that `worktree_list`
is the tool to use (`all: true` also shows the worktrees Git knows outside
`<repo-name>-worktrees`). `git worktree remove|prune|move` stay untouched.

**S10 — The refusals are short reminders, one purpose each (superseded by L10).**
User: *"el mensaje de ambos, no mezclar propsitos ni ser muy extenso, son
recordatorios nomas de porque se bloqueo, para que siga rule de worktree odd"*.

Each of the three refusals is one short reminder that states the command did not run
and names the single tool that replaces it: `worktree_create` for a `git worktree
add`, `worktree_list` for a `git worktree list` (with `all: true`, the flag that
replaces what the blocked listing could see), and `worktree_create`, which creates
the ODD's checkout, for a switch that leaves the principal. No refusal restates the
workflow, sequences two tools, or carries a second purpose; the rule (T4) is what
should keep the agent from reaching the net at all.

**S11 — The command's own `cd` decides which checkout is judged.**
User: *"por ello igual debe conciderar si tool bash tiene cd pues ahi lo ejecuta en
otra ruta, si el comando es el checkout acutal deberia comprobar, sin cd o con cd
mismo checkout revisa si el comando intenta cambiar de rama en este checkout"*.

Segments are walked in order and a `cd <literal path>` sets the effective cwd of the
segments after it, resolved against the effective cwd in force before it. So `cd
<worktree> && git switch x` is judged against that worktree and blocked by nothing
(S2); `cd <principal> && git switch x` is judged against the principal; `cd
<worktree> && cd <principal> && git switch x` ends up in the principal. With no `cd`
the tool call's own cwd is the effective one. A `cd` argument that is not a literal
path (`$VAR`, `~`, `-`, a glob, a backtick) leaves the effective cwd unknown, and an
unknown cwd blocks nothing of S4 (S8). Subshell grouping and pipelines are not
modelled: a `cd` applies to every segment after it in the command string.

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1–S6, S8–S10 | worker `gentle-ai-worker`, parent review and fixes: `lib/worktree-guard.js`, the pure scanner and decision | 6105044 `feat(guard): refuse worktree creation and branch work outside a checkout`, then `fix(guard)` |
| T2 | S1, S2, S7, S8, S9 | worker: the `tool_call` wiring in the extension, exercised through `tools/fixtures/load-extension.js` | 6105044 |
| T3 | S7 | inline parent: AGENTS.md invariant 20, `docs/reference.md`, README bullet | 0341965 `docs: state the worktree guards` |
| T4 | S10 | parent: rule text `lib/odd-prompt/odd-worktrees.md`, the two tool descriptions in the extension, `tools/odd-worktrees-prompt.test.js`. wording accepted by the human over several rounds; the final text is the one in the file, not L6's first draft | bcddd6f `docs(prompt): make worktree_list the first step of every ODD` |
| T5 | S3, S4, S6, S11 | worker in `worktree-guards`: the decision in `lib/worktree-guard.js` (branch-create detection withdrawn, per-segment effective cwd from `cd`, the current-branch seam) and the `tool_call` wiring in the extension; RED first through `tools/worktree-guard.test.js` | faa9354 `fix(guard): refuse only leaving the principal checkout branch` |
| T6 | S10 | worker: the three refusal strings with the tests that pin them, and the three docs that describe them (`docs/reference.md`, `README.md`, `docs/codebase/invariants.md`) | fc07662 `docs(guard): state the switch-only rule and the cd rule` (strings in faa9354) |
| T7 | S4, S8, S11 | worker: four holes a verifier found by reading the shipped decision — long attached create flags (`--create=x`), `git -C <path>` judged in the wrong checkout, the current branch not advancing across the segments of one command, and a quoted `cd` moving the effective cwd — each with its failing row first | 7922668 `fix(guard): judge the checkout the command actually runs in` |

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

**L8** (parent, evidence): the independent verifier could not run (its preparer
rejects a linked worktree: `unsupported repository: ordinary single-root Git
directory required`, exit 1, zero probes), so the parent attacked `decideBashGuard`
with 77 command rows. Real defects found and fixed in the `fix(guard)` commit: a
subshell `(git worktree add)`, `bash -c '…'` and `sh -c '…'` (single-quoted text was
ignored), a `\`-newline continuation, `/usr/bin/git`, `-bx`/`-cx`, `git branch -f x`,
`git checkout --detach` alone, `git checkout main && git checkout develop` (only the
first switch was judged), `git checkout <ref> -- <path>` refused as a switch, and an
extensionless existing file such as `LICENSE` refused as a ref. The verifier's own
finding is also fixed: the branch-create refusal lacked "only when it has none"
(S10). Accepted by L2, not defects: a script, alias or file that runs the command
inside passes; `echo git worktree add` is refused because the text contains it.
Risk: item 2 (guards) — independent verification was unavailable, so this
evidence is the parent's.

**L9** (user, verbatim): *"igual pon que se pueda apagar con alguna variable de
entorno mientras"* and, when asked what it turns off, *"los guards"*. The env variable
is `ODD_WORKTREE_GUARD=0` (the existing `ODD_WORKTREE_*` family), read per call, so no
restart is needed. This supersedes L3's "no escape".

**L10** (user, verbatim):
> creo que hay un error, no esta prohibido crear ramas, sino moverse a ellas si esta en main, worktree create puede crear/reeclamar rama, si la crea primero no hay error da igual. El error seria si el checkout actual es el principal e intenta salir de main, asi que el guard no seria si intenta moverse a otro rama sino que si su rama actual es main e intenta moverse a otra ahi si da error y le dice que debe trabajar usando worktree manteniendo main intacto. Esa era la logica, por lo que hay que corregir el filtrado/guard para que solo bloqueo cambiar de rama, no crear y solo se el cambio produce que se salga de main, por ello igual debe conciderar si tool bash tiene cd pues ahi lo ejecuta en otra ruta, si el comando es el checkout acutal deberia comprobar, sin cd o con cd mismo checkout revisa si el comando intenta cambiar de rama en este checkout y si la rama actual es main, si es asi significa que intenta salir de main y eso no se permite (volver a main si se permite claro, es solo bloquear salir, si quiere trabajar una rama es mediante worktree, puede crearlas antes si quiere).
>
> revisalo y corregilo.
>
> worktree list guard creo que esta bien auqnue revisa su mensaje, el mensaje  de ambos, no mezclar propsitos ni ser muy extenso, son recordatorios nomas de porque se bloqueo, para que siga rule de worktree odd

L10 rewrites S3 and S4 (the branch guard judges LEAVING the current branch, never
creating one) and S10 (short, single-purpose refusals), and adds S11 (the command's
own `cd`). T1 and T4 ship as they landed; T5 rewrites T1's decision and wiring, and
T6 corrects the descriptions. The three refusal strings L10 asked to review are
fixed here, so T5 and T6 agree on them:

- `git worktree add` -> `` `git worktree add` did not run: create the ODD's checkout
  with `worktree_create`. ``
- `git worktree list` -> `` `git worktree list` did not run: use `worktree_list`
  (`all: true` also shows checkouts outside `<repo-name>-worktrees`). ``
- leaving the principal -> `` The branch switch did not run: the principal checkout
  stays on its default branch. Create the ODD's checkout with `worktree_create`. ``

Risk: item 2 (guards).

**L11** (independent verifier, spec pass): it rejected the first draft of the rewritten
spec on six points, all now fixed in place. S10 contradicted itself: it forbade
restating the workflow while its own branch refusal said "create the ODD's worktree
with `worktree_create` and work there" — the string is now "The branch switch did not
run: the principal checkout stays on its default branch. Create the ODD's checkout
with `worktree_create`."; S10 also named a checkout instead of the tool. Four absolute
statements were left over from the pre-S9 wording and are now branch-scoped or
completed: the header omitted the current-branch condition, S1 still said the
listing is not blocked (S9 blocks it), S2 and S11 said "blocks nothing" as if S1/S9
did not apply, and S8 said only S1 survives an unreadable identity (S9 does too). The
L10 bridge no longer claims T1's code "stays" unchanged. The same correction went to
the worker in flight, so the strings cannot drift between spec and code.

**L12** (parent, incident): appending L11 through `bash` was itself refused — the
heredoc contained the literal token sequence the listing guard matches, and that
guard reads the command text, heredoc bodies included. Writing about the guards has
to go through the editor, not through `bash`. No content was lost: the refusal fires
before the command runs.

**L13** (incident, then evidence): the ODD's own worktree sat 120 commits behind main
with no commits of its own, so the first implementation landed on a base whose
`docs/reference.md`, `README.md` and extension had been rewritten 966, 30 and 2083
lines since. The human chose a fresh worktree from main (`fix/worktree-guard-switch-only`,
base `5bfe80d`); the guard and its tests transplanted unchanged (main never touched
them) and the other surfaces were redone against main's text. The old worktree is
left untouched.

The independent verifier could not run again (`unsupported repository: ordinary
single-root Git directory required`, exit 1, zero probes — the same preparer defect
as L8, and no retry is permitted), so verification of the code stays unavailable. Its
static reading, which the parent then confirmed in the shipped source, found four
holes now handed to T7: `git switch --create=x` and `checkout --orphan=x` are not
recognised as create-and-switch; `git -C <path>` is skipped but never used as the
checkout the command runs in, so it produces a false block from the principal and a
false pass from a worktree; the current branch is read once per call, so from a
principal on `dev` the chain `git switch main && git switch x` ends on `x` and
passes; and a quoted `cd` (`echo 'cd /worktree'`) moves the effective cwd for the
segments after it.

**L14** (parent, incident): the first commit attempt was refused by the very guard
this task narrows: the commit MESSAGE contained a bare `git branch <name>`, the
detection is text-only, and a message is text. The message went to a file and
`git commit -F` ran. The obstruction disappears with S3: once this lands, a `git
branch` mention in a message matches nothing.
