# gentle-shell-bridge — Agent Skills Index

When working on this project, load the relevant skill(s) BEFORE doing the work they govern.

## How to Use

1. Check the trigger column to find skills that match the current task.
2. Load the skill by reading the `SKILL.md` file at the listed path.
3. Follow the loaded skill's rules and workflow.
4. Multiple skills may apply simultaneously.

## Skills

| Skill | Trigger | Version | Path |
| --- | --- | --- | --- |
| `gentle-shell-bridge-plugins` | Authoring or extending a Pi plugin that contributes a `/gentle:customize` row or page, a sidebar section, a card style, a transcript transform, a per-tool card design or persisted state through this bridge. | `1.1` | [`skills/gentle-shell-bridge-plugins/SKILL.md`](skills/gentle-shell-bridge-plugins/SKILL.md) |

## Relevant Documentation

| Document | Use when | Path |
| --- | --- | --- |
| PRD | Product intent, users, requirements, success criteria or non-goals decide the change. | [`PRD.md`](PRD.md) |
| ADR — stateless composition | The change touches persistence, the store, or bridge-owned section visibility. | [`docs/state.md`](docs/state.md) |
| Architecture | The change touches the interception, the capture, the arm lifecycle, the rail or a hook into the host. | [`docs/architecture.md`](docs/architecture.md) |
| Contract | Any change to a `register*` call, a row, a section, a style, a transform, a design or `/bridge-status`. | [`docs/contract.md`](docs/contract.md) |
| Worked consumer | You need a real plugin to copy: design, style, section, rows and store, end to end. | [`examples/bash-card.ts`](examples/bash-card.ts) |
| README | Setup, install, the surfaces the host must support, and the limits. | [`README.md`](README.md) |
