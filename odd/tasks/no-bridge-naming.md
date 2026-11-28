# no-bridge-naming

Remove every trace of the old "bridge" name from this package: code, tests, docs. Only the
persistence location survives, for compatibility with data already on disk.
Branch `refactor/no-bridge-naming`, worktree `odd-worktree-worktrees/no-bridge-naming`.

## Specs

- S1: "habismos dicho que ya nada de bridge, ni nombre ni doc ni nada, ahora lo pasamos todo a nativo, parece que aun quedo algunas cosas silenciosas del bridge."
- S2: "Lo unico que queda es donde guarda persistencia, para compatibilidad /home/jona/.pi/gentle-ai/gentle-shell-bridge"
- S3: "no te me salgas del proyecto, estamos solo aca"

Reading of S2 used here (agent decision D1, see Log): the persistence DIRECTORY name and the four
store file names already written inside it (`bridge-card-style`, `bridge-message-designs`,
`bridge-tool-designs`, `bridge-sections`, each `<id>.json`) are kept byte for byte, because renaming
them would orphan the user's saved selections and no migration was asked for. They live in named
constants marked as legacy on-disk names. Nothing else keeps the word.

## Tasks

- [x] T1 (S1, S2, S3) route: writer `gentle-ai-worker` (crashed at ~90%, finished inline by the parent). Rename code, tests, fixtures and docs in one unit (tests and docs of the same behavior are one unit). Commit: `refactor: drop the bridge name from code, tests and docs`.

## Log

- L1 (user, original request that opened this feature): "habismos dicho que ya nada de bridge, ni nombre ni doc ni nada, ahora lo pasamos todo a nativo, parece que aun quedo algunas cosas silenciosas del bridge. Lo unico que queda es donde guarda persistencia, para compatibilidad /home/jona/.pi/gentle-ai/gentle-shell-bridge"
- L2 (user): "no te me salgas del proyecto, estamos solo aca"
- L3 (agent decision D1, awaiting the user's veto): the four legacy store file names stay as they are on disk (see Specs). Reason: orphaning saved selections.
- L4 (agent decision D2, awaiting the user's veto): the public in-process slot becomes `Symbol.for("odd-worktree/shell-api/v1")`, schema `odd-worktree/shell-api`, ready event `odd-worktree:shell-ready`, each defined ONCE in `lib/shell-api/api.ts` and imported elsewhere. The user was asked this and did not answer; this is the proposal, one constant to change.
- L5 (agent decision D3): `odd/tasks/**` are historical records of past decisions and are left untouched, except this file. Reported to the user as a deliberate exception.
- L6 (evidence): `npm test` 3557 tests, 0 fail, 5 skipped; `npm run test:shell-api` 883 tests, 0 fail, 1 skipped. `git grep -i bridge -- . ':!odd/tasks'` leaves only the persistence directory path, the four on-disk store ids, config-home test fixtures and the false positive `abridged`; the only file name left is this historical `odd/tasks/native-bridge.md` (D3).
- L7 (behavior change found by tests, fixed): the card-style fallback row label was `Bridge card style` (3 words). `Shell API card style` has 4 and the bus drops names over `MAX_ROW_NAME_WORDS = 3` silently, so the row vanished. It is now `API card style`. This is a user-visible label change.
- L8 (contract change, high risk item 3): the public slot, schema and ready event changed to `odd-worktree/shell-api/v1`, `odd-worktree/shell-api` and `odd-worktree:shell-ready`; every exported identifier lost the old name. A plugin that still reads the old slot (herdr-gentle-shell does, outside this project, not touched) no longer finds it.
- L9: `.github/workflows/ci.yml`: the `# v6.5.0` comment moved above the `setup-node` pin so the line stays within 80 columns; the pinned SHA is unchanged; `actionlint` exits 0.
- L10 (independent verifier, gentle-ai-verify, on 7ecc2c0): S2 and S3 met; S1 unmet. Findings fixed in the follow-up commit: `docs/codebase/code-map.md:8` still documented the old slot key family; cited file names of another project (`pi-lens` `clients/`) had been mangled by the word replacement and now cite its `clients/` modules without the word; `invariants.md` named the attribution tag `shell API` while code uses `shell-api`; `reference.md` had dropped the host-present condition of the `Tools` page; a fixture lost its dotted-name case (`gentle.shell.kit` restored); a comment about the removed status command was inaccurate.
- L11 (test changes, stated plainly): two negative assertions in `tools/package-surface.test.js` that the entry never imports the retired separate package were REMOVED: the package no longer exists, the positive assertion that the entry imports this package's own shell API stays, and the manifest test pins the dependencies. The `status` absence check in `tools/shell-api-rpc.test.js` could not keep the retired command's exact name without the word and still checks `status`; that test needs a real Pi and was skipped in the verifier's isolated run.
- L12 (define-once, not done, by design): the slot, schema and ready event are defined once in `lib/shell-api/api.ts`; `lib/file-card-resolver.js` (plain CommonJS, cannot import a `.ts` file) and `extensions/odd-worktree-tools.ts` (its plain-JS copy stubs that one import) still spell them. Instead of centralising across that boundary, `tools/shell-api/slot-literals.test.ts` fails if either spelling drifts from `api.ts`.
- L13 (evidence after fixes): `npm test` 3557 tests, 0 fail, 5 skipped; `npm run test:shell-api` 884 tests, 0 fail, 1 skipped; word gate empty. Native review (RDD high risk, item 3) stopped before creating authority: `lens_context_budget_exceeded` on the 166-file candidate; it cannot be split into smaller commits that each build and pass, so the independent verifier is the second view.
