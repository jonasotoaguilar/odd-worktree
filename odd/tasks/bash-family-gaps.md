# bash-activity: familias faltantes y veto por sustitución

Feature: cerrar los huecos del clasificador de cards bash (`lib/bash-activity.js`) que hoy mandan
comandos claros a la card genérica `$ bash`, sin agregar identidades ni tocar la precedencia.

## Specs

- **S1** `npm version <bump>` (y `pnpm`/`yarn`/`bun`) nombra `versioning`. `npm version` sin
  argumento o con `--version` imprime y nombra `exploring`.
- **S2** `npm publish` (y `pnpm`/`yarn`/`bun publish`) nombra `publishing`.
- **S3** `gh api` que escribe (`-X PUT|POST|PATCH|DELETE`, `-f`, `-F`, `--input`) nombra
  `publishing`; el `gh api` de lectura sigue nombrando `exploring` como hoy.
- **S4** `gh workflow run|enable|disable` nombra `publishing`.
- **S5** `docker build` nombra `preparing`.
- **S6** `mix test`, `dotnet test`, `./gradlew test`, `gradle test`, `mvn test` nombran `checking`.
- **S7** `uv run pytest` y `poetry run pytest` (y `uv`/`poetry run` de un checker ya conocido:
  `pytest`, `vitest`, `jest`, `ruff`, `mypy`, `tsc`, `eslint`) nombran `checking`.
- **S8** Un `--body "$(cat <<'EOF' … EOF)"` cuyo **cuerpo** trae backticks nombra `publishing`:
  el body es data, no una sustitución que el lector no puede seguir. Caso real que hoy falla:
  `gh pr create --base main --head feat/jobs-activity-card --title "feat(cards): draw background-job tools in the active card style" --body "$(cat <<'EOF' … `bash_background`, `monitor` … EOF)"`
- **S9** Una sustitución que el lector **no puede seguir** sigue dejando la llamada sin nombre, y son
  tres las formas que lo prueban: un backtick en el texto que actúa el shell (``echo "a `b` c"``), una
  sustitución de proceso (`<( … )`) y el cuerpo de un heredoc con delimitador **sin** comillas.
  `$(git log --oneline -1)` NO es una de ellas: el segmenter sí la sigue y nombra `publishing` desde
  antes de este trabajo, así que un arreglo que la nombre no viola nada. *(Corregido: la versión
  original de S9 nombraba ese comando como el guardián; la verificación independiente probó que
  nunca fue genérico.)*
- **S10** No se agregan identidades a `SHELL_ACTIVITIES` ni se cambia la precedencia de
  `inferBashActivity`. Las pruebas existentes siguen pasando (2547 casos en la base `4f7ea7b`;
  2588 con este trabajo sobre `main` al día).
- **S11** Un *herestring* `<<<` no es un heredoc: `gh pr create --body "$(cat <<<date)" && ./unclassified.sh`
  queda sin nombre, y el texto que sigue a la sustitución se sigue leyendo.
- **S12** El cuerpo de un heredoc se saltea, pero la **línea del header** se lee como texto común:
  `gh pr create --body "$( (cat <<'X')\nplain\nX\n)" && ./unclassified.sh` queda sin nombre.
- **S13** `gh api` sólo nombra `publishing` desde un write probado: `-X "GET"`, `--method='HEAD'`,
  `-X GET -f per_page=1`, `-H "X-Custom: -filename"` y un `-f` sin valor quedan sin nombre.
- **S14** Un subcomando tiene que ser un argumento entero: `gradle test-fixtures:publish`,
  `uv run pytest-deploy` y `poetry run jest-reporter` quedan sin nombre; `uv run ruff format --check .`
  nombra `checking`, igual que el `ruff` pelado.

## Tasks

| ID | Specs | Route | Commit |
| --- | --- | --- | --- |
| T1 | S1-S7 | un solo writer, tablas en `lib/bash-activity.js` + tests RED primero | `fix(bash-activity): name the missing families` |
| T2 | S8, S9 | mismo writer, veto por sustitución en el heredoc anidado + tests RED primero | `fix(bash-activity): read a heredoc body as data` |
| T3 | S10 | parent: suite completa, docs si enumeran comandos | `docs(bash-activity): …` sólo si hace falta |
| T4 | S11-S14 | correcciones pedidas por la verificación independiente | `fix(bash-activity): …` |

## Log

- **L1** «recuerdas los ultimos cambios para mejorar tags de bash? en que quedo las de versionig y publising?»
- **L2** «nose de que hablas, sv-home nada que ver, que mierda hablas, te dije lo del comando bash no pone la tag que hicimos, revisa el proyecto este, nose pa donde mierda te vas si te hablo de odd-worktree. esas debieron ser versiong o publishigng, hace poco mejoramos el detector se supone pero se salta varios importantes»
- **L3** «si fetech es versioning estaba bien, pero recisa porque las demas caian en bash, commit, o add debio ser versioning»
- **L4** «audita bien, esos eran ejemplos, mira lo que tenemos, falta muchos que caen en bash»
- **L5** El humano muestra `$ bash` en `cd /tmp && cat > extract.js <<'EOF' … EOF` + `node extract.js …`.
- **D1** `git fetch` queda en `versioning` por decisión del humano; no se toca.
- **D2** Alcance autorizado: S1 + S2 ahora; "correr un script" (`node x.js`, `./build.sh`, `python x.py`,
  146 de 218 comandos genéricos del corpus) queda fuera hasta que el humano elija su identidad.
- **E1** Auditoría: 4210 comandos reales de las sesiones de este proyecto, 218 genéricos (5.2%).
  Causas medidas: `node <script>` 146x, `gh pr create --body` con heredoc 9x, `gh api` write 7x,
  `<(…)` y keywords (`for/do/done`) sueltos.
- **E2** `lib/bash-activity.js:544` ya llama `hasHiddenSubstitution(segment)`, y esa función ya
  ignora el cuerpo de un heredoc **con comillas** (`<<'EOF'`). El disparador real está en el texto
  que actúa el shell: el `$(cat …)` que envuelve el heredoc. Verificar con un bisect antes de tocar.
- **E3** Causa final: `findSubstitutionEnd` leía comillas pero no cuerpos de heredoc; el body del PR
  tenía 11 apóstrofos (impar), el scan quedó dentro de un quote, el `)` del `$( … )` nunca apareció y
  el `gh pr create` con sus 20 líneas de body salió como un solo segmento que el shell “actúa”.
- **L6** Verificación independiente sobre `6f1fc10..d881ef8`: **FAIL**. S8 pasa; S9 estaba mal
  escrito (ver corrección arriba); la suite pasa (2588 tests, 2559 pass, 0 fail, 29 skip, iguales 29
  en la base). Regresiones encontradas, todas `undefined → named` respecto de la base:
  `<<<` (herestring leído como heredoc), `)` en la línea del header comida por el skip,
  `gh api -X "GET"` / `--method='HEAD'` / `-X GET -f …` / `-H "X-Custom: -filename"` / `-f` pelado,
  `gradle test-fixtures:publish`, `uv run pytest-deploy`, `poetry run jest-reporter`.
- **L7** El parent corrige S9 en este documento (su ejemplo guardián nunca fue genérico) y agrega
  S11-S14 con los casos que la verificación midió, para que la corrección quede especificada y no
  dependa del reporte del worker.
