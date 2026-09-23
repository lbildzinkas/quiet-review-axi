# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- [docs/spec.md](docs/spec.md) is the v0 contract (requirements R1-R17 and design decisions D1-D12, CLI, Jev questions, verdict rules, replay experiment, module layout, milestones). Read it before any change, and update it in the same change when behaviour diverges. `score` is implemented; the replay stages and `report` are not yet. Milestones are tracked as GitHub issues labelled `milestone`.
- TypeScript/ESM on `axi-sdk-js`; `npm run check` runs lint, format check, typecheck and the offline tests, as CI does. Work test-first: behaviour tests drive the real CLI through `main(context)` with injected fakes (`test/helpers/`).
- Question wording lives only in `src/core/question-pack.json` (spec 5.4.5). A wording change is a new pack version gated by the replay, not by unit tests.
- Jev API shapes, limits and design patterns: [docs/jev-guide.md](docs/jev-guide.md). Cite it rather than restating vendor facts.
- The replay's pass rule and labelling rules (spec section 10) are pre-registered: do not change them after a replay's `score` stage has run; use a new replay name instead.
- Hard rules: v0 never writes to GitHub; request building is deterministic (same data, byte-identical request); API keys and GitHub tokens are never printed, logged, or cached; tests make no live network calls (recorded fixtures only).
- Replay working data (`.quiet-review/`) holds third-party comment text and must stay out of git; commit only replay configs and aggregate result summaries under `replay/`.
- Public repository: keep private details, personal data and local machine paths out of every file.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
