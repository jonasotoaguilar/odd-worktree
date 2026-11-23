# odd-rail-section

A second gentle-shell sidebar section, titled `ODD`, listing the ODDs this machine is working on
across every owned worktree checkout, each row clickable to open the ODD panel on that ODD.
Registered only while the `worktrees` module is on.

Branch `feat/odd-rail-section` (base `main@53ae2b2`).

## Specs

S1. The section is titled `ODD` and sits right after the native `AGENTS` rail part, not at the top.
The user said: "si es posible no lo pondria al pricnipio lo pondria mejor luegoo de seccion AGENTS".
Mechanism: `registerSection({ …, placement: { after: "agents" } })`.

S2. The section shows at most 4 ODD rows. With more, a 5th line reads `N more` and is inert.
The user said: "maximo 4, si hay mas sale linea 5 con N more".

S3. The ODD list comes from scanning the `odd/` directory of every worktree checkout, not one
checkout. The user said: "lo que hace es revisar la ruta odd/ de todos los worktrees para obtener
todos los odd".

S4. When one ODD name exists in several checkouts, the most recently modified one is shown. The user
said: "si un ODD se repite muestra el mas reciente modificado".

S5. Each row carries the ODD's location at its far right, in gray: `main` or, for a worktree, the
worktree name only — never the full path. When the ODD is in both and equally recent, `main` wins.
The user said: "en el listado de odd a su derecha del todo en gris sale si es "main" o es un
worktree, si es un worktree solo el nombre del worktree no la ruta completa. SI esta en ambos que es
lo mas probable y en ambos es igual gana main".

S6. Every ODD row is clickable and opens the ODD panel positioned on that specific ODD. The user
said: "cada odd de la sidebar es clicleable, al clickearlo abre vista ODD panel en ese ODD
especifico".

S7. The section exists only while the worktrees module is active. With it off, the section is never
registered at all — not registered and hidden. The user said: "igual esto solo es funcional con
worktree tools os ea si worktree+ esta activo, asi que si no esta activo, sidebar ODD nunca se agrega
como secction".

## Tasks

| ID | Task | Spec | Route | Commit |
| --- | --- | --- | --- | --- |
| T1 | Cross-worktree ODD scan module: enumerate owned checkouts, scan `odd/`, dedupe by name with mtime, main wins ties | S3, S4 | worker (parallel A) | |
| T2 | ODD panel positional open: `createOddView` accepts an initial document; view starts on it | S6 | worker (parallel B) | |
| T3 | `lib/odd-rail-section.js`: factory with injected `load`/`open`, section object carrying `placement: { after: "agents" }`, rows with `meta` = checkout name, click seam, max 4 + `N more`, issues-style snapshot+TTL | S1, S2, S5, S6 | worker (parallel C) | |
| T4 | Extension wiring: register the section gated by `oddModules.worktrees`; `/odd <target>` accepts a target instead of refusing it; the click dispatches that command through the issues one-shot token+guard pattern and the panel opens on the target's own checkout root | S6, S7 | worker (serial, after T1-T3) | |
| T5 | Amend invariant 3 ("one sidebar section") and `tools/package-surface.test.js` for the second section | S1 | worker (serial) | |
| T6 | Independent verification against S1-S7 | S1-S7 | verifier | |

## Log

L1. User's original request, verbatim: "cuando este listo me gustaria agregar al inicio del todo una
sidebar (arriba) que se llame ODD y lo que haga sea mostrar los ODD que esta trabajando la sesion, el
cual los obtiene de worktree create, pues el worktree create tool resive el nobmre del odd. Asi que
ahi muestras todos los odd que usa, cada odd de la sidebar es clicleable, lo al clickearlo abre vista
ODD panel en ese ODD especifico. / Puede que ODD solo exista en el worktree asi que modificaremos ODD
list, como obtieen los ODD el panel y muestra, lo que hace es revisar la ruta odd/ de todos los
worktrees para obtener todos los odd, y si un ODD se repite muestra el mas reciente modificado. /
ademas haria que agregar a ODD list la ruta del odd, en el listado de odd a su derecha del todo en
gris sale si es "main" o es un worktree, si es un worktree solo el nombre del worktree no la ruta
completa. SI esta en ambos que es lo mas probable y en ambos es igual gana main. / igual esto solo es
funcional con worktree tools os ea si worktree+ esta activo, asi que si no esta activo, sidebar ODD
nunca se agrega como secction, ve si es posible esto primero."

L2. Feasibility study (read-only, `gentle-ai-explore`): all four points feasible on the installed
bridge 0.13.0. Load-bearing facts confirmed by the parent: `SectionRow.onClick` (`src/types.ts:146`),
`SectionPlacement` incl. `{ after }` (`src/types.ts:171`), `meta` + `tone: "muted"`, and this package
already ships clickable rail rows (`lib/issues-section.js:382`). Gaps: no positional open (`/odd`
rejects args, `extensions/odd-worktree-tools.ts:6715`; `createOddView` has no initial-selection
option, `lib/odd-view.js:323-344`); invariant 3 and `tools/package-surface.test.js:126` assert exactly
one section; rail body is capped at 8 rows by the bridge, which S2 tightens to 4 by the user's choice.

L3. User's decision on how we proceed, verbatim: "Implementala ahora, completa (4 puntos)".

L4. User's correction on S1, verbatim: "si es posible no lo pondria al pricnipio lo pondria mejor
luegoo de seccion AGENTS". Supersedes the "al inicio del todo (arriba)" placement in L1.

L5. Wire-up recipe (`gentle-ai-explore`, read-only), two findings that shape T3/T4: (a) a rail row does not mount a panel itself — the issues section's `onClick` defers an injected `open` seam which DISPATCHES a command via `pi.sendUserMessage` (`extensions/odd-worktree-tools.ts:9051-9095`), with a module-scope token + 10 s guard and a hint consumed by the command handler (`:7633-7640`, `:7676-7683`); (b) `executeOdd` refuses any argument (`:6695`) and `createOddView` starts at `state.index = 0` (`lib/odd-view.js:345`), so a positional open means accepting a target on the command and setting the initial selection. Also: the panel's scan source is the checkout root, so a foreign ODD needs that root's own scan.
