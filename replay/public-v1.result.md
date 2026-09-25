# Replay public-v1: result

**Verdict: inconclusive.** The automatic ground-truth labels did not pass the label check's trust gate, so the pre-registered pass rule was not judged. The Jev numbers below are informational only.

- Config: [`public-v1.config.json`](public-v1.config.json), hash `sha256:e4c6041094e7929caa35ce63a766c7ee7849d34097f4d5a1326e2ae6ed177fa5`, committed and locked before any score was seen.
- Run: 2026-09-24. Jev model `typesafe/jev-1.13` (answering snapshot `typesafe/jev-1.13-20260917` for all 300 items), question pack `v0.1`.
- Go / no-go: **still open.** An inconclusive result is neither a pass nor a fail.

## Dataset

- 8 public repositories (BerriAI/litellm, elsa-workflows/elsa-core, jdx/mise, macro-inc/macro, pnpm/pnpm, ray-project/ray, ubugeeei-prod/vize, vllm-project/vllm-ascend) and 4 review bots (CodeRabbit, Cursor Bugbot, Gemini Code Assist, Greptile), each capped at 25% of the items.
- Window: PRs merged 2026-09-19 to 2026-09-23. It starts the day after Jev 1.13's release (2026-09-18), so Jev cannot have seen these comments. This is shorter than the spec's usual 3 months. The chosen repositories were busy enough to supply the full target in five days.
- Candidate discovery: 95 of 3,349 repositories found through GitHub search qualified. 3,632 eligible bot comments on the 8 chosen repositories.
- Drawn: 569 comments from 340 PRs. Automatic labels: 180 real, 120 noise, 269 excluded.
  - Excluded by reason: history rewritten 206 (the PR was rebased or force-pushed after the comment, so "did the lines change" cannot be read), diff unavailable 54, anchor unmapped 5, conflicting replies 2, file unavailable 2.

## Label check

- Label model: GLM 5.3 (`zai-coding-cn/glm-5.3`, max thinking) through the Pi CLI on a flat-rate subscription. It labelled 60 sampled comments independently, and all 60 answers were readable.
- Agreement with the automatic labels: **0.62** (Cohen's kappa **0.23**). The trust gate needs at least 0.80.
- The 23 disagreements were **adjudicated by an AI reviewer on the maintainer's behalf**, with the maintainer's approval. One low-confidence item was decided by the maintainer (noise). Final labels for the 23: 9 real, 14 noise, 0 excluded.
- The review overturned **13 of 23** automatic labels (**0.57**). The trust gate allows at most 0.20.
- Who was right: GLM on 13, the automatic rules on 10.
  - **Fixes the rules missed (9 false "noise").** Some fixes landed just outside the 2-line anchor or in another file. Some came in a follow-up PR after merge. Some comments were valid but merged over without a change. The thread often said so (the bot resolved its own thread, or a coding agent replied "fixed in ..."), but the rules only count human replies.
  - **Coincidental edits the rules counted (4 false "real").** The commented lines changed for an unrelated reason, while the author said no change was needed or the bot withdrew the finding.
  - **Comments GLM over-called (10).** GLM called them real ("a careful author would have acted on it"), but they were style, taste, false premises or intended behaviour.
- Trust verdict: **inconclusive** (agreement below 0.80, and more than 20% of reviewed automatic labels overturned).

## Jev scores (informational: labels not trusted)

Measured on all 300 scored items with the final labels (185 real, 115 noise). Each value has its 95% range from 2,000 seeded bootstrap resamples.

| Metric | Value | 95% range | Pass rule |
|---|---|---|---|
| AUROC of "worth acting on" | 0.570 | 0.501-0.635 | >= 0.75 |
| Best threshold (hides <= 5% of real) | 0.34 | - | - |
| Noise collapsed at 0.34 | 0.148 | 0.090-0.214 | >= 0.40 |
| Real hidden at 0.34 | 0.043 | 0.016-0.075 | <= 0.05 |
| Keep precision (worth >= 0.70) | 0.647 | 0.581-0.712 | none |

The best threshold is chosen on the same data it is measured on, so its two shares are optimistic.

Sweep points (noise collapsed / real hidden): 0.20 -> 0.113 / 0.016; 0.30 -> 0.139 / 0.032; 0.40 -> 0.165 / 0.076; 0.50 -> 0.191 / 0.103; 0.70 -> 0.374 / 0.286.

On the 60-item label-check sample alone (the best-checked labels: 35 real, 25 noise), AUROC is 0.651 (0.501-0.790).

AUROC per bot: CodeRabbit 0.397, Cursor 0.560, Gemini 0.662, Greptile 0.626 (75 items each).
AUROC per repository: litellm 0.393, mise 0.561, macro 0.606, pnpm 0.577, ray 0.562, vize 0.347, vllm-ascend 0.816. It is undefined for elsa-core, where all 25 items are real.
Duplicate rate: 0.077. No calibrated cut-offs were written.

Even on these labels, the numbers are far from the pass rule, not a near miss. They can't be read as Jev's accuracy, though, because the labels they are measured against failed the trust gate.

## Spend

| Step | Route | Cost |
|---|---|---|
| Discovery, build, label | GitHub reads only | $0 |
| Label check (60 comments) | GLM subscription via Pi | $0 |
| Jev scoring (300 comments, 208 calls) | OpenRouter | $0.0209 |
| **Total** | | **$0.0209** |

## Next

The spec requires that, after an inconclusive result, the labelling rules are revised under a **new replay name** before any retest. This replay's rules and pass rule stay as registered.
The adjudication points at the main gaps:

- fixes just outside the anchor or in another file;
- replies and thread resolution from bots and coding agents;
- fixes in a follow-up PR;
- the large share of rebased PRs that are excluded.
