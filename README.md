# quiet-review-axi

Agent-first CLI that scores AI code-review comments with Jev typed decisions to separate real issues from noise.

AI review bots leave many comments on every pull request, and only some of them point at real problems.
Quiet Review asks TypeSafe's Jev model a few typed questions about each comment (is it worth acting on, what kind of issue, how severe, is it a duplicate) and turns the answers into a verdict: **keep**, **unsure** or **collapse**.
Output is compact [AXI](https://github.com/kunchenguid/axi) TOON for coding agents, with `--json` for scripts and a readable mode for people.

## Status

**v0 in progress.** Scoring works, and the accuracy replay can build, label, score and evaluate its public dataset; only the replay's AI label check is still planned.

v0 is decided by an accuracy replay on public pull requests: it checks whether Jev's scores separate comments developers acted on from comments they ignored.
The project continues only if the replay passes a rule fixed in advance (AUROC ≥ 0.75, and collapsing at least 40% of noise while hiding at most 5% of real issues).
Until then, the verdict cut-offs are the generic 0.30 / 0.70 band, labelled `uncalibrated` in every output.

| Command | State |
|---|---|
| `quiet-review-axi score <pr-url>` | Available: scores a pull request's inline review comments (read-only on GitHub) |
| `quiet-review-axi score --findings <file>` | Available: scores a generic findings file |
| `quiet-review-axi replay` | Mostly available: `build` and `label` build the public dataset and its automatic labels (read-only on GitHub, no model call), `score` scores it with Jev, and `evaluate` applies the pass rule and, on a pass, writes calibrated cut-offs; the AI label check (`check`) is planned |
| `quiet-review-axi report` | Available: prints the accuracy summary of an evaluated replay, with 95% ranges |
| `quiet-review-axi gate` | Available: checks a reworded question pack against an evaluated replay before it is adopted |
| `quiet-review-axi smoke` | Available: scores about 20 unmistakable comments by hand after a Jev model update |

Backends: OpenRouter (default) or the TypeSafe API, with your own key.

## Install

Requires Node 20.19 or later. v0 is installed from the repository, not from npm:

```sh
npm install -g github:lbildzinkas/quiet-review-axi
```

## Use

```sh
export OPENROUTER_API_KEY=...        # or TYPESAFE_API_KEY with --provider typesafe
export GITHUB_TOKEN=...              # or GH_TOKEN, or be logged in with `gh auth login`

quiet-review-axi                                   # current setup: provider, key source, cut-offs, cache, spend
quiet-review-axi score acme/widgets#412            # compact output for agents
quiet-review-axi score acme/widgets#412 --human    # readable summary
quiet-review-axi score acme/widgets#412 --json     # one JSON document with raw answers
quiet-review-axi score --findings findings.json --dry-run   # show what would be sent, send nothing
```

Each run is capped by `--max-cost` (default $0.50), and repeated runs are served from a local cache at no cost.
Private repositories are refused unless you opt in with `--allow-private`.
Run `quiet-review-axi score --help` for every flag.

## Develop

```sh
npm install
npm run check    # lint, format check, typecheck, offline tests
```

Tests never call Jev or GitHub, and neither does CI. See [docs/spec.md](docs/spec.md) section 11.3.
The calibration maths (AUROC, threshold sweep, bootstrap ranges, abstain band, snapshot drift, regression gate) lives in `src/calibration/`, a library with no Quiet Review, GitHub or provider imports that works with any judge returning probabilities.

## Documents

- [docs/spec.md](docs/spec.md): the v0 specification
- [docs/jev-guide.md](docs/jev-guide.md): how the Jev model works and how to build on it

## License

MIT, see [LICENSE](LICENSE).
