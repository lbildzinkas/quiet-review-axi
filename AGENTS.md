# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- [docs/spec.md](docs/spec.md) is the v0 contract (requirements R1-R17 and design decisions D1-D13, CLI, Jev questions, verdict rules, replay experiment, module layout, milestones). Read it before any change, and update it (and the README's user-facing sections, such as "Verdict cut-offs") in the same change when behaviour diverges. Every v0 command and replay stage is implemented. Milestones are tracked as GitHub issues labelled `milestone`.
- TypeScript/ESM on `axi-sdk-js`; `npm run check` runs lint, format check, typecheck and the offline tests, as CI does. Work test-first: behaviour tests drive the real CLI through `main(context)` with injected fakes (`test/helpers/`).
- Question wording lives only in `src/core/question-pack.json` (spec 5.4.5), and the label-check prompt only in `src/replay/label-prompt.json` (spec 10.6). A question wording change is a new pack version gated by `quiet-review-axi gate` against an evaluated replay, not by unit tests; `smoke` is the by-hand check after a Jev model update. A label-prompt change is a new prompt version, which relabels the check sample. The automatic labelling rules live in `src/replay/label.ts` behind `LABEL_RULES_VERSION` (per-bot resolve settings included): a rule change is a new version that must not relabel an existing replay — it ships under a new replay name (`label-rules-v1` froze `public-v1`; the current rules are `label-rules-v2`, revised after the public-v1 adjudication).
- `src/calibration/` is a judge-agnostic library meant to be published on its own later: it imports only its own modules (a test enforces this). Put generic metric or calibration logic there and Quiet Review specifics outside it.
- The label check reaches its model through a `LabelBackend` (`src/replay/label-model.ts`): OpenRouter (paid) or the `pi` CLI on a subscription, picked by `label_check.backend`. A new model route, such as `claude -p`, is another backend of that shape. Subscription backends run a signed-in CLI as a subprocess (never read its credentials), cost $0 against `--max-cost`, and are for modest volume within the provider's terms; Jev never goes through a subscription. Tests use the fake `pi` on `PATH` (`test/helpers/fake-pi.ts`), never the real CLI.
- Jev API shapes, limits and design patterns: [docs/jev-guide.md](docs/jev-guide.md). Cite it rather than restating vendor facts.
- The replay's pass rule and labelling rules (spec section 10) are pre-registered: do not change them after a replay's `score` stage has run; use a new replay name instead. The first live replay, `public-v1`, has scored: inconclusive (the labels failed the trust gate, go/no-go open) — [replay/public-v1.result.md](replay/public-v1.result.md).
- Hard rules: v0 never writes to GitHub; request building is deterministic (same data, byte-identical request); API keys and GitHub tokens are never printed, logged, or cached; tests make no live network calls (fixtures and scripted fakes only).
- Replay working data (`.quiet-review/`) holds third-party comment text and must stay out of git; commit only replay configs and aggregate result summaries under `replay/`.
- Public repository: keep private details, personal data and local machine paths out of every file.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
