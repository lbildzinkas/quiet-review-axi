# Replay public-v2: result

**Verdict: inconclusive.** The revised automatic labels agreed much better with the label model than in public-v1, but the review of the disagreements still overturned more automatic labels than the trust gate allows, so the pre-registered pass rule was not judged. The Jev numbers below are informational only.

- Config: [`public-v2.config.json`](public-v2.config.json), hash `sha256:86f389db1d0228e611443e6087d6c2e215279ee4b28abfcbcc86fc6a1b6e5615`, committed before build and score.
- Run: 2026-09-25. Jev model `typesafe/jev-1.13` (one answering snapshot, `typesafe/jev-1.13-20260917`, for all 293 scored items), question pack `v0.1`, label rules `label-rules-v2`.
- Go / no-go: **still open.** An inconclusive result is neither a pass nor a fail.

**This is not a fully independent test.** The labelling rules (`label-rules-v2`) were revised using the disagreements adjudicated after public-v1, and the replay reuses public-v1's repositories, bots and window with a new seed, so much of the same material was scored again (the adjudication found 14 previously-adjudicated comments redrawn here). Treat the v1-to-v2 comparison as a measurement of the rule revision on overlapping data, not a fresh experiment.

## Dataset

- The same 8 public repositories (BerriAI/litellm, elsa-workflows/elsa-core, jdx/mise, macro-inc/macro, pnpm/pnpm, ray-project/ray, ubugeeei-prod/vize, vllm-project/vllm-ascend) and 4 review bots (CodeRabbit, Cursor Bugbot, Gemini Code Assist, Greptile) as public-v1, with the same caps (25% per repository, 25% per bot, 8 per PR) and a new seed (20260925).
- Window: PRs merged 2026-09-19 to 2026-09-23, as in public-v1.
- Drawn: 763 comments from 406 PRs (public-v1: 569 from 340). Automatic labels: 237 real, 56 noise, 470 excluded. The draw stopped 7 items short of the 300 target: every stratum was exhausted or capped.
  - Excluded by reason: history rewritten 325, diff unavailable 67, no commits after comment 66 (the new label-rules-v2 exclusion), anchor unmapped 7, rewrite 2, file deleted 1, file renamed 1, file unavailable 1.

## Label check

- Label model: GLM 5.3 (`zai-coding-cn/glm-5.3`, max thinking) through the Pi CLI on a flat-rate subscription. It labelled 60 sampled comments independently; 59 answers were readable, 1 could not be read and counted as `unsure`.
- Agreement with the automatic labels: **0.85** (Cohen's kappa **0.69**). The trust gate needs at least 0.80. Public-v1 scored 0.62 (kappa 0.23).
- 15 items went to review (8 disagreements and 7 `unsure`). They were **adjudicated by an AI reviewer on the maintainer's behalf**, with the maintainer's approval; every item was decided at medium confidence or better, so none needed the maintainer. Final labels for the 15: 5 real, 10 noise, 0 excluded.
- The review overturned **6 of 15** automatic labels (**0.40**). The trust gate allows at most 0.20, so the result is inconclusive even though raw agreement passed. (Measured against the whole 60-item sample, the corrections are 6 of 60, or 10%.)
- The adjudication's overall reading: **the rules improved to about 90% accuracy** on the sample (54 of 60, or 53 of 60 on the stricter count below), against roughly 78% in public-v1, but **new failure patterns remain**:
  - the withdrawal rule now overrides genuine fixes the author made after the bot retracted (3 of the 6 corrections);
  - a Cursor self-resolve was trusted as a fix when nothing was fixed (1);
  - a title-extraction bug stops the commit-matching rule reading short Greptile comments (1);
  - outside the sample, the new follow-up rule counts bulk commits (version bumps, translation syncs, integration squashes) as fixes, which re-labels some comments public-v1 adjudicated as noise. One such item sat in the sample itself: both labellers agreed on it, so the check could not catch it. That is the reason for the stricter 53-of-60 figure.
- Trust verdict: **inconclusive** (overturn rate over 20%).

## Jev scores (informational: labels not trusted)

Measured on all 293 scored items with the final labels (241 real, 52 noise). Each value has its 95% range from 2,000 seeded bootstrap resamples. The public-v1 values are shown for comparison; the two runs share most of their material, so the deltas are small by construction.

| Metric | public-v2 | public-v1 | Pass rule |
|---|---|---|---|
| AUROC of "worth acting on" | 0.569 (0.485-0.653) | 0.570 (0.501-0.635) | >= 0.75 |
| Best threshold (hides <= 5% of real) | 0.37 | 0.34 | - |
| Noise collapsed at best threshold | 0.096 (0.021-0.184) | 0.148 (0.090-0.214) | >= 0.40 |
| Real hidden at best threshold | 0.050 (0.024-0.079) | 0.043 (0.016-0.075) | <= 0.05 |
| Keep precision (worth >= 0.70) | 0.837 (0.786-0.884) | 0.647 (0.581-0.712) | none |

The best threshold is chosen on the same data it is measured on, so its two shares are optimistic.

Sweep points (noise collapsed / real hidden): 0.20 -> 0.038 / 0.004; 0.30 -> 0.058 / 0.025; 0.40 -> 0.096 / 0.075; 0.50 -> 0.135 / 0.120; 0.70 -> 0.346 / 0.278.

On the 60-item label-check sample alone (34 real, 26 noise), AUROC is 0.548 (0.402-0.697); public-v1's sample gave 0.651 (0.501-0.790).

AUROC per bot: CodeRabbit 0.327, Cursor 0.665, Gemini 0.646, Greptile 0.518 (public-v1: 0.397, 0.560, 0.662, 0.626).
AUROC per repository: litellm 0.564, mise 0.403, macro 0.583, pnpm 0.380, ray 0.666, vize 0.357, vllm-ascend 0.710. It is undefined for elsa-core, where all 28 items are real.
Duplicate rate: 0.106. No calibrated cut-offs were written.

As in public-v1, the numbers are far from the pass rule and cannot be read as Jev's accuracy, because the labels they are measured against failed the trust gate.

## Spend

| Step | Route | Cost |
|---|---|---|
| Build, label | GitHub reads only | $0 |
| Label check (60 comments) | GLM subscription via Pi | $0 |
| Jev scoring (293 comments, 187 calls) | OpenRouter | $0.0164 |
| **Total** | | **$0.0164** |

## Next

The spec requires that, after an inconclusive result, the labelling rules are revised under a **new replay name** before any retest. This replay's rules and pass rule stay as registered. The go/no-go decision and the choice of next steps are the maintainer's.

The adjudication's concrete suggestions for a `label-rules-v3`, each to be pre-registered with the next replay: make the withdrawal rule order-aware, match the "Intended:" refusal pattern, fix the Greptile title extraction, ignore bulk follow-up commits in the follow-up rule, and give the label model each follow-up's size. It also observed that the 20% overturn limit is measured on a review set enriched for errors by construction, which belongs in the next pre-registration discussion rather than in a change made after seeing this result.
