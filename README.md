# quiet-review-axi

Agent-first CLI that scores AI code-review comments with Jev typed decisions to separate real issues from noise.

AI review bots leave many comments on every pull request, and only some of them point at real problems.
Quiet Review asks TypeSafe's Jev model a few typed questions about each comment (is it worth acting on, what kind of issue, how severe, is it a duplicate) and turns the answers into a verdict: **keep**, **unsure** or **collapse**.
Output is compact [AXI](https://github.com/kunchenguid/axi) TOON for coding agents, with `--json` for scripts and a readable mode for people.

## Status

**v0 in progress.** Scoring works, and the accuracy replay can build, label, check, score and evaluate its public dataset.

v0 is decided by an accuracy replay on public pull requests: it checks whether Jev's scores separate comments developers acted on from comments they ignored.
The project continues only if the replay passes a rule fixed in advance (AUROC ≥ 0.75, and collapsing at least 40% of noise while hiding at most 5% of real issues).
Until then, the verdict cut-offs are the generic 0.30 / 0.70 band, labelled `uncalibrated` in every output.

| Command | State |
|---|---|
| `quiet-review-axi score <pr-url>` | Available: scores a pull request's inline review comments (read-only on GitHub) |
| `quiet-review-axi score --findings <file>` | Available: scores a generic findings file |
| `quiet-review-axi replay` | Available: `build` and `label` build the public dataset and its automatic labels (read-only on GitHub, no model call); `check` asks a pinned OpenRouter chat model to label a seeded sample (paid, within `--max-cost`), reports agreement and Cohen's kappa, and writes the disagreements to `review.jsonl` for the maintainer; `score` scores the dataset with Jev; and `evaluate` applies the pass rule and, on a pass, writes calibrated cut-offs |
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

## Verdict cut-offs

### What Jev gives and what Quiet Review decides

For each comment, Jev returns one number: the probability, from 0 to 1, that the comment is worth acting on.
It appears as `worth` in the output.
Jev does not pick the verdict.
Quiet Review compares `worth` with two cut-offs that it owns and you can configure:

| `worth` | Verdict | What it means |
|---|---|---|
| at or above `keep_at` | **keep** | Worth acting on. |
| from `collapse_below` up to `keep_at` | **unsure** | Shown, never collapsed, marked low confidence. |
| below `collapse_below` | **collapse** | Low value. Can be hidden. |

The category, severity and duplicate answers never change the verdict.

The built-in cut-offs are `collapse_below` **0.30** and `keep_at` **0.70**.
They come from the Jev vendor's general guidance on uncertain answers, not from measurements on review comments.
Because of that, every output marks them `uncalibrated`.

There are two cut-offs, not one, because Jev's answers can shift by a few hundredths between runs.
With a single cut-off, a borderline comment could flip between keep and collapse from one run to the next.
The unsure band in the middle absorbs that drift.

### Where the cut-offs are set

Each cut-off is taken from the first of these sources that sets it.
The two cut-offs are looked up separately, so one can come from one source and the other from another.

1. **Flags**, for one run only: `--collapse-below <p>` and `--keep-at <p>`.
2. **Repository config**: a `.quiet-review.json` file in the directory you run from. Commit it to share cut-offs with everyone who works in that repository. It may hold only `cutoffs`. Keys and private-repository opt-ins are refused there.

   ```json
   { "cutoffs": { "collapse_below": 0.25, "keep_at": 0.75 } }
   ```

3. **User config**: `~/.config/quiet-review-axi/config.json`, or `$XDG_CONFIG_HOME/quiet-review-axi/config.json` when that variable is set. It uses the same `cutoffs` object. A passing replay writes it (see below), and you can also edit it by hand.
4. **Built-in**: 0.30 and 0.70.

Rules for configured values:

- Both cut-offs are numbers from 0 to 1, and `collapse_below` is at most `keep_at`. When they are equal, there is no unsure band.
- A file that sets both cut-offs must hold them in that order on its own, even if a flag overrides one of them for a run.
- An unknown key inside `cutoffs`, such as a misspelled `keep`, is refused instead of being ignored.
- A bad value stops the run before anything is sent. The command exits with code 2 and a `VALIDATION_ERROR` that names the file and the key to fix.

### Seeing which cut-offs are in effect

Run `quiet-review-axi` with no command.
The `cutoffs` line shows both values, where each one came from (`flag`, `repo config`, `user config` or `built-in`), and its state:

- `uncalibrated`: the built-in values;
- `hand-set`: set by a flag, the repository config, or by hand in the user config;
- `calibrated on <model snapshot> by replay <name>`: written by a passing replay.

The `repo_config` and `user_config` lines give the path of each file, or `none (<path>)` with the place it would go when it does not exist yet.
Every `score` output prints the same `cutoffs` line, so each result records the cut-offs it used.

```
cutoffs: "collapse<0.27 keep>=0.70 (user config, calibrated on typesafe/jev-1.13-20260917 by replay public-v1)"
repo_config: none (/path/to/project/.quiet-review.json)
user_config: /home/you/.config/quiet-review-axi/config.json
```

### Calibrating the cut-offs from Jev's scores

`quiet-review-axi replay <name>` measures how well Jev's scores separate useful review comments from noise, on public pull requests:

1. `build` and `label` collect bot review comments and label each one `real` (mainly: the lines it pointed at changed before the pull request merged) or `noise` (they did not change). Comments with unclear evidence are excluded.
2. `score` asks Jev for each comment's `worth`.
3. `evaluate` tries every collapse cut-off from 0.01 to 0.99. It picks the one that collapses the most noise while hiding at most 5% of the real comments.

When the replay passes its fixed rule (AUROC of at least 0.75, and at least 40% of noise collapsed with at most 5% of real comments hidden), `evaluate` writes the chosen value to the `cutoffs` object in the user config as `collapse_below`.
`keep_at` stays 0.70 unless the chosen value is higher, in which case it is raised to match.
The write keeps every other field in the file, leaves the file readable only by you, and records where the values came from:

```json
{
  "cutoffs": {
    "collapse_below": 0.27,
    "keep_at": 0.7,
    "replay": "public-v1",
    "snapshot": "typesafe/jev-1.13-20260917",
    "tested_collapse_below": 0.27,
    "written_at": "2026-10-01"
  }
}
```

Before it replaces existing cut-offs, `evaluate` prints the old values.
A replay that fails or cannot reach a verdict writes nothing.
The replay tests only the collapse cut-off.
`quiet-review-axi report` shows how often comments at or above `keep_at` were real, so you can judge the keep cut-off yourself.

### When to calibrate again

- **The model snapshot changed.** The pinned model name can move to a newer dated snapshot. When a run's snapshot differs from the `snapshot` recorded with the calibrated cut-offs, the output marks them `stale`, warns, and suggests re-running the replay. The cut-offs are still used until you do.
- **You raised `collapse_below`.** When the collapse cut-off in effect, from any source, is above the `tested_collapse_below` value the last replay measured, the output warns that more real issues than the replay measured may be collapsed.

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
