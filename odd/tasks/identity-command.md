# identity-command — the user's own name in the prompt card and the orchestrator prompt

Feature: one new transversal command (`/identity`) that stores the user's display name, paints it in
the user prompt card instead of `You`, and appends one line about it to the orchestrator's system
prompt; clearing the name puts `You` back and removes the line.

## Specs

S1. The user asks for a command that configures their name: "agreguemos un comando /identity que
permita configurar mi nombre, por ejemplo "Jona" y lo guarda". So `/identity <name>` stores the
name, and the stored name survives a restart of Pi (it is persisted, not session state).

S2. With a name stored, the user's prompts show it instead of `You`: "haciendo que ahora mis
mensajes nuevos y antiguos se repinten y se vean con "Jona" en vez de "You"". Both prompts painted
after the change AND prompts already on screen must show it, which means the name change repaints
the transcript.

S3. With a name stored, one line about the user is injected into the orchestrator's prompt: "si este
apodo esta configurado incrusta un mensaje a orchestrators (como lo hace codegraph y worktree) que
sea bien simple, una linea". Without a stored name nothing is injected.

S4. The command unsets the name: "tambien el comando debe permitir desasignar nombre, para que
vuelva a meter "You" en tui y quitar la inyeccion de nombre de usuario a orchestrator". After
clearing, the card heads with `You` again (already-painted prompts included) and nothing is
injected.

## Tasks

| ID | Spec | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1, S3, S4 | inline: `lib/user-identity.js` — the persisted document, the normalization, the injected block | 1 |
| T2 | S2, S4 | inline: `lib/user-prompt-card.js` — the heading name and the memo that repaints it | 1 |
| T3 | S1, S2, S4 | inline: `extensions/odd-worktree-tools.ts` — the `/identity` command and the one repaint | 1 |
| T4 | S3 | inline: `extensions/odd-worktree-tools.ts` — the append in `before_agent_start` | 1 |
| T5 | S1-S4 | inline: `tools/user-identity.test.js` + the pins the surface change breaks | 1 |
| T6 | S1-S4 | inline: `README.md`, `docs/reference.md`, `docs/codebase/{invariants,code-map}.md` | 1 |

## Decisions (the spec's shape, decided by the parent)

D1. **Where the name lives.** The bridge's own store, the one `lib/modules.js` already uses:
`createStore('odd-worktree')` → document key `identity` → `{ schema: 1, name: "<name>" }`. It is
persisted by the bridge, it is read synchronously (`bridgeApi()` from `lib/file-card-resolver.js`)
so a paint can read it, and it keeps this package's one preference mechanism instead of adding a
second document format. A missing, malformed, wrong-version or unreadable document means NO name —
never a guess and never a throw.

D2. **What a name may be.** Trimmed, internal whitespace runs collapsed to one space, C0/C1 control
characters dropped, no markdown heading run (`## `), 1 to 40 code points after that; a name that
normalizes to nothing, to more than 40, or to something carrying a heading run, is refused with one
sentence and nothing is written. The name reaches a system prompt, so it stays one printable line —
never a multi-line injection, and never a string that could form another prompt block's marker (the
block above is found by `## ODD worktrees`, the CodeGraph one by `## CodeGraph`, and a name carrying
`## ` could make either vanish from the next append). `C#` and `#designer` carry no run and stay
names. The reserved word `clear` is decided on the NORMALIZED value: a name that only becomes
`clear` once its controls are dropped is the verb, never a name the command could never unset.

D3. **The injected line.** The block is the marker heading plus exactly one sentence:

```
## User identity

The user's name is Jona.
```

A fact, not a relation: "You are working for Jona" would state whom the agent works for and leave
the name of the person it addresses unstated, while "the user's name is Jona" is the one fact every
later answer can render (address them, name them in a document) without adding a rule the user did
not ask for. The heading is the identity of the block, which is what makes the append idempotent,
exactly like `## ODD worktrees` and `## CodeGraph`.

D4. **Where it is injected.** `systemPromptOptions.appendSystemPrompt`, append-only, in the same
`before_agent_start` handler that already appends the other two blocks. It follows their guards: a
`GENTLE_PI_AGENTS_CHILD=1` session gets nothing and a named-agent event gets nothing, because this
line is the orchestrator's. There is no environment switch: the name itself is the switch.

D5. **How the old prompts repaint.** The card memo gains the name as one of its keys, so a name
that changed recomposes instead of serving the remembered parts, and the command asks the bridge for
ONE `requestRepaint()` (the call the install already makes) after a successful write or clear. The
gate, the frames, the clock and the body are untouched. A clear on a store that already holds no
usable name writes nothing, so a repeated `clear` costs no write and no repaint.

D6. **The command surface.** `/identity` with no argument reports what is set; `/identity <name>`
sets it; `/identity clear` unsets it (`clear` is reserved and documented in the command's own
description). It is transversal like `/odd` and `/files`, so it is registered wherever the bridge is
and takes no module switch.

## Log

L1 (user, verbatim): "Me gustaria agrega identida, actualmente mis mensaje con diseno se ven asi
[Image#1], dice You, asi que agreguemos un comando /identity que permita configurar mi nombre, por
ejemplo "Jona" y lo guarda, haciendo que ahora mis mensajes nuevos y antiguos se repinten y se vean
con "Jona" en vez de "You", ademas tambien si este apodo esta configurado incrusta un mensaje a
orchestrators (como lo hace codegraph y worktree) que sea bien simple, una linea, algo como en
ingles "Estas trabajando para Jona" o "el nombre del usuario es Jona", ahi analiza cual opcion es
mejor, puede ser otra no esas 2 quizas. Y solo se incrusta si esta el nombre configurado, tambien
el comando debe permitir desasignar nombre, para que vuelva a meter "You" en tui y quitar la
inyeccion de nombre de usuario a orchestrator."

L2 (evidence, after the independent verifier): the first candidate stored `cle\u0001ar` as the name
`clear` (the reserved check ran on the raw argument), let a mention of the heading inside prose
suppress the block, let a name carrying `## CodeGraph` or `## ODD worktrees` cost an older block its
marker, and rewrote the cleared document on a second `clear`. Fixed in `lib/user-identity.js`
(normalization refuses a `## ` run; the marker is matched as a whole line; a clear writes only when
a usable name is stored), in the `/identity` handler (the reserved word is decided on the normalized
value) and in the refusal sentence (`identity: a name needs 1-40 printable characters and no
markdown heading`). Five RED tests in `tools/user-identity.test.js` pin them, plus one that proves
the identity block and `## ODD worktrees` both survive one append.
