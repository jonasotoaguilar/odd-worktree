# pi-odd-worktree — Agent Skills Index

When working on this project, load the relevant skill(s) BEFORE doing the work they govern.

## How to Use

1. Check the trigger column to find skills that match the current task.
2. Load the skill by reading the `SKILL.md` file at the listed path.
3. Follow the loaded skill's rules and workflow.
4. Multiple skills may apply simultaneously.

## Relevant Documentation

| Document | Use when | Path |
| --- | --- | --- |
| Codebase mental model | You need the package's boundaries, its 29 invariants in one line each, or where to start tracing a change. | [`docs/codebase/mental-model.md`](docs/codebase/mental-model.md) |
| Code map | You need to know which file owns a responsibility before opening code. | [`docs/codebase/code-map.md`](docs/codebase/code-map.md) |
| Invariants | You are about to change the package and must know which rule a change may not break, or you are following an `invariant N` citation. | [`docs/codebase/invariants.md`](docs/codebase/invariants.md) |
| Reference | You need a panel key, a refusal sentence, the test rules, or how one surface behaves in detail. | [`docs/reference.md`](docs/reference.md) |
| README | You are installing, checking requirements, or reading the shipped surface at a glance. | [`README.md`](README.md) |
| CI matrix | You need to know which Node versions the suite runs on. | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| PR gates | You are writing a commit subject or a PR title that must pass. | [`.github/workflows/pr-check.yml`](.github/workflows/pr-check.yml) |
| Release flow | You are cutting a release or checking what publishing does. | [`.github/workflows/release.yml`](.github/workflows/release.yml) |
