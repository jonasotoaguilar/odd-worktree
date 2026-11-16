# Card skill and Card odd: file calls head as the file

Branch: feat/cards-skill-odd · Delivery: feature branch, no push · Tests: `node --test tools/*.test.js`

## Specs

- S1: «https://github.com/Gentleman-Programming/gentle-shell/pull/3061 en esa pr puse cambios para estilizar tools read/write/edit cuando el archivo era uno en ../skills.. o en ../odd/.. , en esas rutas. Revisalo e implementalo/replicalo en este proyecto, para estilizar esas tools. Agrega usando gentle bridge a custimize seccion cards una switch para enceder o pagar "Card skill" y "Card odd" que implementamos ahora.»
- S2: «debe ser compatible con cards style neon/float u otros y con cards content default/minimal»

Derived from S1 (not new requirements): a `read`/`edit`/`write` call whose `path` names a customized skill (a `SKILL.md` under a `skills` folder) or an ODD artifact (any file under an `odd/tasks/` folder) heads as that file — mark, label and path — while every other call keeps the host's own drawing untouched; each identity is switched on and off from `/gentle:customize` → `Cards` as `Card skill` and `Card odd` (default on), and the choice survives a restart. S2 means the cards wear the shared substrate: the style slot (`float`, `neon`, any value the shell publishes) and the content level (`default` = bounded preview, `minimal` = one row until expanded), both re-read at paint time, so a flip repaints rows already drawn.

## Tasks

- T1 [S1] `lib/skill-odd-card.js`: path-component classification (skill, odd, nothing), the file name, the read line range, and the Markdown-document rule — pure functions, `tools/skill-odd-card.test.js`.
- T2 [S1] `lib/card-files-mode.js`: the one document `<home>/card-files.json` plus the live slot, two booleans (skill, odd) defaulting on, atomic owner-only writer that refuses a document it cannot parse; `tools/card-files-mode.test.js`.
- T3 [S1,S2] `lib/file-card.js` and `lib/file-card-resolver.js`: the call/result card for `read`/`edit`/`write` on the shared substrate, claiming only those three tools, honoring both switches and the style/content slots at paint time, forwarding every other row exactly as the chain resolved it; `tools/file-card.test.js`.
- T4 [S1] `lib/cards-customize.js`: the bridge `Cards` category with the two toggles (`registerRows`, two rows per setting, action persists first), the same schema/version gate and `gentle-shell-bridge:ready` retry the issues section uses; `tools/cards-customize.test.js`.
- T5 [S1,S2] Wiring in `extensions/odd-worktree-tools.ts` (both registrations), `tools/package-surface.test.js`, and the documentation of the new surface (AGENTS.md invariants, README, docs/reference.md).

## Log

- L1: «https://github.com/Gentleman-Programming/gentle-shell/pull/3061 en esa pr puse cambios para estilizar tools read/write/edit cuando el archivo era uno en ../skills.. o en ../odd/.. , en esas rutas. Revisalo e implementalo/replicalo en este proyecto, para estilizar esas tools. Agrega usando gentle bridge a custimize seccion cards una switch para enceder o pagar "Card skill" y "Card odd" que implementamos ahora.»
- L2: «debe ser compatible con cards style neon/float u otros y con cards content default/minimal»
- L3: PR #3061 mapped: `lib/skill-odd-card.ts` (new) + `extensions/quiet-tools.ts` (heading for `read`/`edit`/`write`, expanded Markdown body). Identity table: skill = `▤`/`skill`/`toolTitle`; odd = `📑`/`odd`/`mdHeading`; ODD collapsed names the file, expanded the whole path; only a read names a line range.
- L4: Bridge contract, read from `/home/jona/dev/projects/gentle-shell-bridge` (`src/types.ts:26,74,194`, `docs/contract.md:476–497`): a toggle is two consecutive rows sharing one `choice.setting` in `category: "Cards"`, `current()` reads live state, `action()` persists FIRST; persistence belongs to the plugin, never the bridge. This repo's only bridge touch today is the issues section (`extensions/odd-worktree-tools.ts:6672,7262–7273,7591`).
- L5: Decision (S2): the Markdown body renders through this repo's own `lib/odd-markdown.js` (`renderOddMarkdown`) with a plain-text paint seam, so body rows stay plain and the substrate paints last (invariant 17); the structure — headings, bullets, fences — renders, token color stays the card's body role.
- L6: Decision: both switches default ON, live in one document, and are re-read inside the paint build like the bash card's mode, so a flip repaints a row already on screen.
