# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Status: specification only; no source code yet. [docs/spec.md](docs/spec.md) is the v0 contract (requirements R1-R16, CLI, Jev questions, verdict rules, replay experiment, module layout, milestones). Read it before any change, and update it in the same change when behaviour diverges.
- Jev API shapes, limits and design patterns: [docs/jev-guide.md](docs/jev-guide.md). Cite it rather than restating vendor facts.
- The replay's pass rule and labelling rules (spec section 9) are pre-registered: do not change them after a replay's `score` stage has run; use a new replay name instead.
- Hard rules: v0 never writes to GitHub; API keys are never printed, logged, or cached; tests make no live network calls (recorded fixtures only).
- Replay working data (`.quiet-review/`) holds third-party comment text and must stay out of git; commit only replay configs and aggregate result summaries under `replay/`.
- Public repository: keep private details, personal data and local machine paths out of every file.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
