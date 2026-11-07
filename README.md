# odd-worktree

[![CI](https://github.com/jonasotoaguilar/odd-worktree/actions/workflows/ci.yml/badge.svg)](https://github.com/jonasotoaguilar/odd-worktree/actions/workflows/ci.yml)

A Pi package for agent worktrees, ODD documents and GitHub issues:
create/list/close/warp checkouts from the agent, drive the same work from the
`/warp` panel, read the project's `odd/` documents with `/odd-list`, and read
this checkout's GitHub issues with `/issues`.

It runs in Pi alone. Herdr is optional, and only `worktree_create` uses it (the
best-effort workspace association): every Herdr call there is attempted first
and falls back to plain `git`, so nothing here requires a Herdr install. Removal
never touches Herdr at all — a close never closes, opens or removes a Herdr
workspace, and it removes the checkout with `git worktree remove`.

## Surface

Three commands:

| Command | What it does |
|---|---|
| `/warp` | Move this session to another checkout of the project. No argument opens the selector (list, create, delete); `/warp <name>` jumps straight to the flattened branch slug or `principal`. |
| `/odd-list` | Two-pane viewer of this checkout's `odd/` documents: list on the left, styled markdown on the right. |
| `/issues` | Full-screen reader of this checkout's repository issues: My issues / Assigned / Involved / All, live server search, issue preview with comments, and label/assignee, comment and close actions when the repository permits them. |

Four agent tools:

| Tool | What it does |
|---|---|
| `worktree_create` | Create a branch and its checkout from local `main`, register it, run the creation hooks, optionally copy pending changes. |
| `worktree_list` | Read-only listing: principal first, then the session's own checkout, then the rest. Prunes rows whose checkout is gone. |
| `worktree_close` | Remove a registered checkout and keep the branch. Needs `force: true` for a dirty checkout. Refuses while a live Pi session is working in that checkout — this session (warp first) or another (let it finish, close it, or warp it away). |
| `worktree_warp` | Queue the session move to another checkout. The tool only queues it as `/warp <handoff>`; the command performs the move when the turn ends. |

Create and close ask for approval when the host offers dialog UI. `list` never
mutates anything.

## Install

```bash
pi install .            # from this directory
```

`package.json` declares `pi.extensions`, so Pi loads
`extensions/odd-worktree-tools.ts` on its own.

## Requirements

- Node.js >= 18 and `git`.
- Pi (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) — peer
  dependencies, provided by the host.
- Optional: `herdr` for the create's workspace association; `codegraph` for the
  create hook's index step. Both are detected at runtime and skipped when
  absent. Gentle Shell's published presence store (when Gentle Shell is
  installed) is what makes the active-session check see *other* sessions; without
  it, only this session's own checkout is detected.
- `/issues` needs the GitHub CLI (`gh`) installed and authenticated
  (`gh auth login`). Without it the command stays registered, says once per
  session what is missing and never opens the reader.

## Where state lives

The registry is per repository at `<git-common-dir>/pi-worktrees.json`, so a
worktree of the same clone sees the same rows. Session names derived from an
ODD write and the warp's fork/resume bookkeeping travel in the Pi session files
the host already owns. Nothing is written to user config.

## Contract worth knowing

- A new branch is born from the LOCAL `main` ref. A repository without a local
  `main` is refused before anything is written, rather than seeding the branch
  from whatever the invoking checkout had.
- `worktree_create` requires `changes`: `"all"`, `"none"`, or an explicit list
  of checkout-relative paths. The create never guesses.
- Paths, branches and arguments reach `git`/`herdr`/`gh` as fixed argv
  arrays, never as a shell string.
- Deleting a checkout is refused while a live Pi session is working in it, and
  the SAME check runs for the `worktree_close` tool and for the warp panel's
  `ctrl+d` — before the pending-change question, and again immediately before
  the removal. This session's own checkout is refused with "warp first"; another
  session's is refused naming its REAL session id — the guard joins the
  presence hash to Gentle Shell's published transport activation record for that
  session. When no record joins (a peer that has not published one, an over-cap
  or unreadable registry), the refusal shows the presence hash and says the
  session id could not be resolved; it never invents one from a label. Nothing
  is auto-warped and nothing is closed on the human's behalf: the history is
  theirs to move.
- That check is BEST EFFORT, not a guarantee. It reads Gentle Shell's published
  presence records (heartbeat plus workspace) and transport activation records
  (the raw session id) when Gentle Shell is installed and running, and it always
  catches the checkout this session stands on. A record whose heartbeat is older
  than 15 s cannot prove a session is gone, so it is disclosed in the close
  output as a stale record instead of blocking the removal forever; the same
  close output also discloses live records that published no workspace (so they
  could not be attributed to a checkout) and a presence or transport scan that
  hit its bound. A presence store that is absent or unreadable blocks nothing
  and is disclosed. Gentle Shell's scratch ledger is deliberately not used: it
  records what a session *created*, not where it is working.
- Removal is `git worktree remove <absolute path>`, with `--force` only when the
  caller asked for it. The branch is kept, and no Herdr panel is closed, opened
  or removed on any path.
- The `/warp` selector never offers the checkout the session already stands in:
  warping there would move the session to the route it is already on. The
  exclusion is by checkout identity (the resolved real path), not by spelling,
  so a symlinked or otherwise differently-spelled path to the current checkout
  is excluded too, while a checkout whose name merely shares a prefix is still
  offered.
- `/issues` pins the repository identity (`<host>/<owner>/<repo>`) when the
  list loads. Every page, detail, label and assignee read binds it, and so do
  the actions and the `o` browser opener (`gh issue view <n> --web -R`). If the
  checkout's remote moves while the reader is open, mutations refuse and the
  reads keep the displayed repository, so an issue number on screen can never
  be sent to another repository.
- `/issues` resolves the viewer's permission for that pinned repository before
  an action editor opens, not when the write is sent. The evidence is the
  repository role the issue detail already reads (`viewerPermission`), it is
  cached for the panel session, and `r` re-reads it. Anything but a confirmed
  capability fails closed — the footer hint is absent, the key refuses with the
  reason on screen, and no editor opens and no mutation is attempted:

  | Action | Minimum role |
  | --- | --- |
  | close / reopen an issue | triage |
  | apply or remove an existing label | triage |
  | assign or unassign | triage |
  | create a repository label | write |
  | comment | none beyond read access |

  Creating a label is a SEPARATE, write-level capability, so a triage-only
  viewer opens the labels editor normally and sees neither a create row nor its
  `n` keybinding. Commenting is deliberately ungated: GitHub lets anyone with
  read access to the repository comment, so demanding triage would hide an
  action the viewer is allowed to take.
- Refusals are reported, not swallowed: a rejected name, a dirty checkout, a
  failed move, or a denied GitHub capability names the reason and leaves the
  repository as it was.

## Deliberately absent

This package is the worktree/ODD/issues surface only. It has no customize
panel, no plugin-tools toggles, no Herdr plugin management, and no
worktree↔issue association — there is nothing to configure, and the three
commands above are always on.

## Tests

```bash
node --test tools/*.test.js
```

`tools/package-surface.test.js`, `tools/worktree-tools.test.js`,
`tools/commands.test.js` and `tools/issues-command.test.js` cover this
package's own surface: registration, manifest, the three checkout tools against
a real temporary repository with a deliberately unusable Herdr, the three
command handlers, and `/issues` end to end against an injected `gh` runner (no
network, no real GitHub mutation). `tools/worktree-session-guard.test.js` pins
the active-session guard against synthetic presence stores (live, stale,
malformed and linked records), `tools/worktree-close-herdr-async.test.js` pins
that a close removes with git and spawns no Herdr at all, and
`tools/warp-delete-confirm.test.js` drives the real `/warp` command to prove the
session check runs before the deletion question and again after it. The
remaining suites cover the shared `lib/` modules (the warp create panel, warp
selector view, ODD viewer and document reader, the GitHub issue client and
view, delete evidence, change transfer, registry, session bookkeeping).

Tests keep every temporary repository, stub binary and extension copy under the
system temp directory and remove them on exit.

## CI and releases

| Workflow | Trigger | What it runs |
|---|---|---|
| `ci.yml` | push to `main`, every pull request | `node --test tools/*.test.js` on Node 18, 20, 22 and 24 — the range `engines` declares, 18 as its floor |
| `pr-check.yml` | pull request opened, edited, reopened or updated | the PR title and every non-merge commit subject must follow [Conventional Commits](https://www.conventionalcommits.org/), plus one test run on Node 22 |
| `release.yml` | tag `v*` push, or a manual dispatch naming an existing tag | tag/`package.json` version parity, the suite, the GitHub Release, then `npm publish`, then verification |

The suite uses Node builtins only, so CI installs nothing and needs no lockfile.
No workflow stores a registry credential: npm publication uses
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers), with
`id-token: write` granted to the `release` job and nowhere else.

### Cutting a release

1. Set `version` in `package.json`, then tag the exact commit:
   `git tag -a v0.2.0 -m v0.2.0 && git push origin v0.2.0`. The tag must be `v`
   plus the `package.json` version, or the run stops in preflight.
2. The workflow creates the GitHub Release with generated base notes. Curate the
   title and body afterwards by editing the published release
   (`gh release edit v0.2.0 --title ... --notes-file ...`); notes are never
   committed to the repository.
3. A version npm already serves is reported and left alone; a version npm does
   not have is published with provenance. A published version is immutable — fix
   the cause and cut the next patch tag.

### npm publication prerequisites

`odd-worktree` is not on npm yet, and OIDC cannot publish a
package's first version, so the npm step of `release.yml` fails visibly until
these are done by hand. It is never silently skipped.

- Publish the first version by hand (`npm publish --access public`, 2FA, no
  stored token).
- Bind the trusted publisher to this repository, workflow file `release.yml`
  and the `release` environment, then cut the next version within two days — npm
  expires a configuration that has not completed a publish in that window.
- Add a `repository` field to `package.json` before the first publish: the
  provenance attestation binds to the public repository it names,
  case-sensitively, and published version metadata is immutable. This repository
  is currently private, and provenance requires a public repository, so that has
  to be resolved (make it public, or decide not to publish attestations) before
  `--provenance` can succeed.
- Create the `release` environment (Settings → Environments) and attach required
  reviewers if a release should pause for approval.
- Confirm `files[]` still lists every shipped surface with
  `npm pack --dry-run` before the first publish.

### Enforcement still manual

Workflow presence is not enforcement. Required status checks on `main`
(`CI / Test (Node …)` and the `PR Check` gates) need a branch protection rule or
ruleset, which this repository cannot currently apply: it is private, and GitHub
only offers those settings to public repositories or GitHub Pro.
`.github/CODEOWNERS` names the owner for review requests; review-from-code-owners
is part of the same protection rule.
