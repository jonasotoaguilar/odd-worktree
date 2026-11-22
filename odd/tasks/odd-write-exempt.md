# odd-write-exempt

An `odd/` path is always writable, even in the primary checkout on the default branch. Package: pi-odd-worktree.
Branch: feat/odd-write-exempt (base main@948b865).

## Specs

S1. The `edit`/`write` guard gains one exception: a path below an `odd/` folder is never refused, whatever branch the
checkout it lands in is on. The user said: "el guard de worktree que prohibe escribir en main, a ese aplicale una
excepcion y es para ruta odd/ ahi si permite escribir siempre aunque este en main".

S2. Nothing else in the guard changes: every other path of the principal checkout on the default branch is still
refused with the same sentence, and every other exemption (temp directories, another repository, a linked worktree, a
detached HEAD, another branch) still passes exactly as it did.

S3. The `odd/` folder is the one the file card already identifies (`lib/skill-odd-card.js`, `fileCardIdentity`
answering `ODD_FILE_CARD`), reused and never copied: one rule for "this path is an ODD artifact", so the card and the
guard can never disagree. A FILE whose own name is `odd` is not inside one.

## Tasks

- [x] T1 (S1, S2, S3) the exemption, its tests and its docs. inline.

## Log

L1. un detalle que me falto corergir, y es el guard de worktree que prohibe escribir en main [Image#2], a ese aplicale una excepcion y es para ruta odd/ ahi si permite escribir siempre aunque en main. Luego de esta release, implementa ese fix y sacas otra release. [Image#2 is the write refusal: "/home/jona/dev/projects/gentle-shell-bridge/odd/tasks/section-placement.md is in the primary checkout on `main`. Work in a worktree (`worktree_list` / `worktree_create`)."]
