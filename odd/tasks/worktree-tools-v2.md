# worktree-tools-v2 — two tools with the gentle-shell contract and its own cards

Goal: shrink this package to **two agent tools** — `worktree_create` and
`worktree_list` — carrying the design and the code that the `feat/worktree-tools`
branch of gentle-shell already built and specified, remove the three CodeGraph
commands, keep `/warp` as a command with no agent front, and give both tools a
custom result card in the style of the `cards-bash-v2` branch.

## Specs

- **S1** — «habia hecho un worktree con cambios de worktree tols a gentle-shell,
  /home/jona/dev/projects/gentle-shell-worktrees/worktree-tools ... me gusta mas
  los de gentle shell, haber si usamos eso y modificamos los de este plugin, que
  sean solo 2 tools la de worktree create y worktree list (que funcionen sean las
  mismas de esa rama de gentle-shell que construi)». The two tools behave as that
  branch behaves: the same parameters, the same refusals sentence for sentence,
  the same state vocabulary, the same read-only listing.
- **S2** — «igual eliminaria los 3 comandos de codegraph». `/codegraph-hook`,
  `/codegraph-init` and `/codegraph-sync` do not exist, and nothing registers,
  probes or syncs CodeGraph: no session gate, no edit/write sync, no
  `codegraph init` step in a create, no `with-codegraph` prompt variant.
- **S3** — «dejaria la de warp pero solo como comando, no tool de agente». `/warp`
  stays with its queue, its live-session guard and its selector; `worktree_warp`
  is not registered and no agent surface can move the session.
- **S4** — «me parece bien, implementalo.» The approved scope, beyond S1-S3:
  `worktree_delete` is also not registered (deletion stays human, through the
  panel's `ctrl+d` and the one guard); `odd` is an **optional** create parameter;
  the clone metadata lives in the existing `pi-worktrees.json` extended with
  optional per-row fields, never in a second file; setup runs automatically on
  the package's own tracked task with no configuration file. What "optional"
  means concretely: an omitted `odd` is not validated, the plan carries
  `odd: null`, the record stores it as absent, and both the create output and
  the list print `odd: -` so the fixed line order never changes shape.
- **S5** — «pero lo de las tools asegura de darle estilo personalizado. que sea
  como la bash versioning de esta rama
  /home/jona/dev/projects/gentle-shell-worktrees/cards-bash-v2». Both tools render
  a custom result card matching that branch's bash card: its geometry, its
  palette, its status vocabulary, and its collapsed/expanded behaviour. The
  derived visual contract, from that branch:
  - a rounded frame (outline style, `╭─ … ╮` / `│ … │` / `╰ … ╯`), inner content
    width = frame width − 4 columns, every body row space-padded to the full
    inner width and truncated with a literal `…`;
  - header = glyph + space + title, then ` · `-separated detail, a rule filling
    the remaining width, and an optional right-aligned dim hint;
  - collapsed call = one heading row with the detail truncated, plus up to three
    preview body rows; expanded call = the heading wrapping onto continuation
    body rows instead of losing the detail;
  - a running tool shows one muted `running…` body row;
  - the result draws the body and the closing rule, with the elapsed time
    right-aligned on that closing rule when it fits (at least 3 free columns);
  - tone from state: success, warning while pending, error on failure; colours
    come from theme roles through an injected `fg(role, text)`, never hardcoded
    ANSI.

## Tasks

Every task is closed, with the commit that holds it and the check observed at the time. `✔` marks a landed task; a task naming a defect found in review records the commit that closes it.

- **T1** ✔ S1 · metadata substrate: `lib/worktree-metadata.js` + suite · `d983d5f` · 54/54
- **T2** ✔ S1 · preparation substrate: `lib/worktree-hooks.js`, `lib/worktree-setup.js` + suites · `d983d5f` · 68/68
- **T3** ✔ S1 · the two cores: `lib/worktree-create.js`, `lib/worktree-list.js` + suites · `d983d5f` · 46/46
- **T4a** ✔ S4 · metadata preserves the `worktrees` key · `d983d5f` · 54/54
- **T4b** ✔ S1, S4 · the two tools wired on the ported cores · `d983d5f` (odd-absent fixed in `c2e85db`) · 128/128
- **T4c** ✔ S4 · registry preserves every key it does not own · `d983d5f` · 46/46, sha256 identical across add/remove/prune
- **T4d** ✔ S1, S4 · the setup runner (tracked task, own log, proven settle) · `d983d5f` · runner 10/10, tools 70/70
- **T4e** ✔ S1, S4 · the `/warp` create front on the same pipeline · `d983d5f` · 147/147
- **T4f** ✔ S1 · the five suites re-pointed off `changes` · `d983d5f` · 90/90, one vacuous pass repaired
- **T5a** ✔ S5 · card drawing substrate, outline only · `d983d5f` · 16/16, zero width drift at 20/40/80
- **T5b** ✔ S5 · the renderer module · `d983d5f` · 14/14, twelve deliberate breakages each caught
- **T5c** ✔ S5 · **the cards wired to both definitions** (T5b shipped unused until here) · `5f64cb0` · framed at width 60 + plain fallback
- **T5d** ✔ S1 · panel preview path and the `interrupted` derivation · `5f64cb0` · preview equals create
- **T6** ✔ S3, S4 · delete and warp unregistered; the guard discloses on the panel · `ab31bbe` · 1091/1091
- **T7** ✔ S2 · CodeGraph removed: modules, commands, gate, sync, prompt variant, suites · `d983d5f` · full suite green
- **T8** ✔ S2, S3 · docs and invariants to the shipped surface · `972d0d8`, `56f7a3b`, `c2e85db` · doc-pinning suites green
- **T9a** ✔ S6 · the Herdr legacy in code and in `package.json` · `d983d5f` · zero matches in `lib/`, `extensions/`, `package.json`
- **T9b** ✔ S6 · `worktree-close-herdr.js` → `worktree-remove.js` and every name · `d983d5f` · grep clean
- **T9c** ✔ S6 · dead `HERDR_BIN_PATH` scaffolding and the app citations · `a2589c3` · 1091/1091, no case deleted
- **T9d** ✔ S2 · the producer-less CodeGraph card row and prose row · `ab31bbe` · grep survivors are absence guards only
- **T10** ✔ S4, S5 · the independent review's four findings: a false `interrupted`, two spellings of an absent `odd`, the "byte for byte" claim, the whitespace divergence · `c2e85db` · 1102/1102

## Delivery state

Code complete and verified; **not delivered**. The branch has no upstream, nothing is pushed, no PR exists, nothing is merged, and no release was cut. `feat/worktree-tools-v2` is 7 commits and 11,552 insertions over `origin/main`, past any single review slice, so it needs a chained PR. That is the only decision left with the maintainer.

Resolved while closing: the two `*.0.1.0.tgz` archives that were tracked at the repository root are removed, and `odd/` is trackable again through a repository-local negation in `.gitignore`, so this document can travel with the change that produced it.
