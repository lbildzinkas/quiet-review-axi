# Replay public-v2: rich-context ablation result

**Status: pre-registered, not yet run.** This section is committed before any paid call of the
ablation. Everything below "Run" is filled in after the run; nothing in this section may change
afterwards.

## Pre-registered pass rule (written before the run)

The question: does context the model could have known at comment time (the pull request's title
and description, the issue it linked, wider code around the comment) lift Jev's "worth acting
on" separation of real from noise comments above the chance level the two public replays found
(AUROC 0.57 both times)?

A variant is said to **pass** (that is, the noise filter built on it would go forward) when, on
the replay's final labels, it meets public-v2's pre-registered pass rule:

- AUROC of "worth acting on" **>= 0.75**, and
- at the best threshold (the most noise collapsed while hiding at most 5% of real items),
  **>= 40% of noise collapsed** with **<= 5% of real hidden**.

Any variant that does not meet all three counts as **not passing**, and a result where no
variant passes means the noise filter is archived. The ablation itself is exploratory: it never
changes the replay's verdict or cut-offs, and the labels it measures against carry public-v2's
`inconclusive` trust verdict, so "passes" here is a screen for whether a context-carrying pack
is worth a pre-registered replay of its own, not a go decision.

Run plan (committed here so the variants are fixed before scoring): baseline (the replay's own
requests, from the cache), then `pr` (pull request title and description), `issue` (linked
issue), `code` (wider code around the comment), each alone, then `all` (all three blocks
together), through OpenRouter, capped at $0.40 for the whole ablation.

## Run

- Run: 2026-09-26. Every variant answered through one Jev snapshot, `typesafe/jev-1.13-20260917`, over OpenRouter. Question packs: `v0.1` for the baseline, `v0.1-context.1` for every context variant. Bootstrap: 2,000 resamples with the replay config's seed (20260925).
- Measured on the replay's 293 final-label items (241 real, 52 noise). The labels carry public-v2's `inconclusive` trust verdict (the label check overturned 40% of its reviewed sample against a 20% limit), so every number below inherits that caveat: this measures Jev with context against labels that are close but not fully trusted.
- Context availability, as each block could be read at comment time:
  - PR title and description: **187 of 187 pull requests**.
  - Linked issue: **40 of 187 pull requests (21%)**; the other 147 had none linked before the comment.
  - Wider code: **291 of 293 comments** (file window shown; rest of the hunk on 279). Missing: file unavailable 2; rest of hunk: comment at the hunk end 12, diff unavailable 1, hunk not found 1.
- Run history: a first attempt scored the PR-level blocks as empty for every pull request (a reading bug in the context gatherer, fixed before this run), so its variant scores were discarded; its $0.0613 counts in the spend below, and the baseline and wider-code requests it paid for are the ones reused here.

## Result

**No variant passes the pre-registered rule.** The best AUROC of any variant is 0.576 (linked issue) against the required 0.75, and the best noise collapsed at <= 5% real hidden is 11.5% (PR description) against the required 40%. Per the pre-registration, the noise filter is **archived**.

Per variant, on all 293 items (the baseline is the replay's own scoring, from the cache):

| Variant | Context given | AUROC (95% range) | Change vs baseline (paired 95% range) | Noise collapsed at <= 5% real hidden (95% range) | Real hidden | Tokens per item | Cost when paid |
|---|---|---|---|---|---|---|---|
| baseline | comment and hunk tail | 0.569 (0.483-0.653) | - | 9.6% (2.0-18.2) | 5.0% | 1,647 | $0.0203 |
| pr | + PR title and description | 0.560 (0.466-0.651) | -0.008 (-0.068 to 0.050) | 11.5% (3.7-21.1) | 2.9% | 2,277 | $0.0280 |
| issue | + linked issue | 0.576 (0.489-0.661) | +0.008 (-0.027 to 0.042) | 7.7% (1.8-15.3) | 2.5% | 1,764 | $0.0217 |
| code | + wider code | 0.543 (0.455-0.627) | -0.026 (-0.071 to 0.018) | 9.6% (2.1-18.0) | 5.0% | 3,292 | $0.0405 |
| all | all three blocks | 0.569 (0.475-0.664) | +0.001 (-0.065 to 0.066) | 9.6% (2.0-18.5) | 5.0% | 3,963 | $0.0488 |

The best threshold is chosen on the same data it is measured on, so its two shares are optimistic. Keep precision at worth >= 0.70 barely moves either: baseline 0.837, pr 0.854, issue 0.865, code 0.842, all 0.853.

**Reading.** Every paired change interval straddles zero: no block, alone or together, moved Jev's separation of real from noise comments by more than noise. The linked-issue block is the only positive mover (+0.008) and it existed for only 21% of pull requests; wider code, the most expensive block, trends slightly negative (-0.026). Giving Jev everything known at comment time doubled its input per item (1,647 to 3,963 tokens) for a change indistinguishable from zero (+0.001). On these labels the model's "worth acting on" stays barely above chance with or without context, so the shortfall is not a context problem.

AUROC per bot (items / real):

| Bot | baseline | pr | issue | code | all |
|---|---|---|---|---|---|
| CodeRabbit (75 / 59) | 0.327 | 0.408 | 0.352 | 0.357 | 0.476 |
| Cursor (75 / 71) | 0.665 | 0.563 | 0.676 | 0.590 | 0.502 |
| Gemini (68 / 45) | 0.646 | 0.605 | 0.682 | 0.573 | 0.592 |
| Greptile (75 / 66) | 0.518 | 0.465 | 0.525 | 0.467 | 0.452 |

Context helps CodeRabbit's comments most (0.327 to 0.476 with everything, still under chance) and hurts Cursor's and Greptile's; no bot reaches the pass rule under any variant, and each bot's spread across variants sits inside the others' noise.

## Spend

| Step | Cost |
|---|---|
| First ablation attempt (discarded after the reading bug; baseline and wider-code requests reused) | $0.0613 |
| Re-run: pr $0.0280 + issue $0.0217 + all $0.0488 (baseline and wider-code served from the cache at no cost) | $0.0816 |
| **Total, against the $0.40 cap** | **$0.1428** |

## Next

Per the pre-registered statement above, the noise filter is archived: no context variant is worth a pre-registered replay of its own. The measurement's caveat stays what public-v2's was — the labels are ~90% trusted, not fully — but a 0.18 AUROC shortfall against the pass rule is far beyond what residual label noise explains. The go/no-go question the two public replays left open now has its context answer: richer context known at comment time does not rescue Jev's "worth acting on" signal on this data.
