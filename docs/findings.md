# Can a cheap judge filter AI review comments? Findings from public pull requests

September 2026. This article summarises three pre-registered experiments run with Quiet Review on public GitHub pull requests. The detailed records are [public-v1](../replay/public-v1.result.md), [public-v2](../replay/public-v2.result.md) and the [rich-context comparison](../replay/public-v2.rich-context.result.md); the method is specified in [spec.md](spec.md) section 10.

**Short answer: not for this task.** Jev's "worth acting on" score separated the comments developers acted on from the ones they ignored only slightly better than chance (AUROC 0.57 in both replays, against a pre-set bar of 0.75). Giving it more context known at comment time did not change that. The labels themselves never fully passed our own trust check, so the formal verdict of each replay is "inconclusive", but the gap to the bar is far larger than the remaining label noise can explain. The noise filter has been archived.

## The question

AI review bots such as CodeRabbit, Cursor Bugbot, Gemini Code Assist and Greptile leave many inline comments on every pull request. Some point at real defects; many are style preferences, restatements, or claims the code does not support.

Quiet Review tried to add a cheap filter in front of that stream. For each comment it asks [Jev](jev-guide.md), TypeSafe's typed-decision model, a fixed question: does this comment point out a concrete problem in the shown code that the author should fix before merging? Jev answers with a probability, not with text. Plain code then turns the probability into **keep**, **unsure** or **collapse**.

Jev is attractive for this because it is fast and very cheap: US$0.042 per million input tokens, with free output. Scoring a 300-comment dataset cost about two cents. The question was whether it is also accurate enough to hide noise without hiding real problems.

## Method

### Pre-registration

Before any score was seen, each experiment committed its configuration (repositories, bots, merge window, sample size, seed, label rules) and its pass rule to the repository. The bar, fixed in [spec.md](spec.md) section 10.8, was:

- **AUROC of at least 0.75** for the "worth acting on" score (0.5 is a coin flip, 1.0 is perfect ranking), and
- a threshold that **collapses at least 40% of noise while hiding at most 5% of real comments**.

A revised attempt must run under a new name; earlier results are never re-scored under new rules.

### Data

Both replays drew from the same 8 public repositories (BerriAI/litellm, elsa-workflows/elsa-core, jdx/mise, macro-inc/macro, pnpm/pnpm, ray-project/ray, ubugeeei-prod/vize, vllm-project/vllm-ascend) and the same 4 bots, with no bot or repository allowed more than 25% of the items and no pull request more than 8. The repositories were chosen from 95 qualifying candidates out of 3,349 found through GitHub search.

The window was pull requests merged from 2026-09-19 to 2026-09-23. It starts the day after the Jev version used (1.13) was released, so Jev cannot have seen these comments during training. Every item was scored with one pinned model snapshot, `typesafe/jev-1.13-20260917`.

Jev saw only what a filter would see in practice: the cleaned comment text, the file path and line numbers, the pull request's repository and title, and the last 25 lines of the diff hunk the comment sits on. It never saw who wrote the comment, the replies, or anything that happened later.

### Labels from what developers did

To grade Jev, each comment needs a label: **real** (the author acted on it, or a careful author would have) or **noise**. Labelling hundreds of comments by hand was out of budget, so labels came from GitHub history by fixed rules:

- Did the commented lines change after the comment and before merge?
- Did someone reply "fixed", "good catch" or name a later commit, or reply "won't fix", "intentional", "false positive"?
- Did the bot withdraw its own finding, or resolve its own thread?
- Did a later commit's subject repeat the comment's title, or did a follow-up commit on the main branch change the same lines within a week of the merge?

Comments whose evidence could not be read were excluded rather than guessed, most often because the pull request was rebased or force-pushed after the comment. The full rule table is in [spec.md](spec.md) section 10.5.

### An independent label check

Automatic labels are a proxy, so each replay tested them. A separate language model, GLM 5.3 at its maximum reasoning setting, labelled a seeded sample of 60 comments without seeing the automatic label. It was given more than Jev: the diff after the comment, the pull request's description, the later commit subjects, the thread replies and who resolved the thread. It ran on a flat-rate subscription, at no cost per call.

Every item where GLM and the rules disagreed (and, in the second replay, every item GLM marked "unsure") was then **adjudicated by Opus 5.5 on the maintainer's behalf**, with the maintainer's approval. The adjudicator had full context and live, read-only access to GitHub: the thread and who resolved it, later commits, the merged code, follow-up pull requests and, where needed, the source of the libraries involved. Once it ran a small local experiment to confirm a tool's behaviour. One item, in the first replay, was left to the maintainer.

A **trust gate**, also fixed in advance, decided whether the labels were good enough to judge Jev: raw agreement between GLM and the rules of at least 0.80, and at most 20% of the reviewed automatic labels overturned. If the gate failed, the replay's verdict would be "inconclusive" whatever Jev scored.

## Results

### The labels

| | public-v1 | public-v2 |
|---|---|---|
| Label rules | first version | revised after the v1 adjudication |
| Comments drawn / pull requests | 569 / 340 | 763 / 406 |
| Real / noise / excluded | 180 / 120 / 269 | 237 / 56 / 470 |
| GLM agreement with the rules (kappa) | 0.62 (0.23) | 0.85 (0.69) |
| Items adjudicated | 23 | 15 |
| Automatic labels overturned | 13 of 23 (57%) | 6 of 15 (40%) |
| Rules right on the 60-item sample | about 78% | about 90% |
| Trust gate | failed | failed (overturn rate) |

In the first replay both labellers made systematic mistakes, and each was right where the other was wrong.

- **The rules missed real fixes (9 items).** Fixes landed a few lines outside the commented range or in another file. Some came in a follow-up pull request after the merge. Several threads said so plainly, for example a bot resolving its own thread after a fix, or the author's coding agent replying "fixed in" with a commit, but the rules only trusted human replies.
- **The rules counted coincidental edits (4 items).** The commented lines changed for an unrelated reason while the thread said the finding did not apply, or the bot withdrew it.
- **GLM was too generous (10 items).** It called comments real because they sounded plausible. In most of these the bot's premise could only be checked outside the hunk, and it turned out wrong: a guard that an earlier filter already made unnecessary, a library value the bot said could be empty but never is, a suggested constant that does not exist in the codebase, a duplicate command-line flag that was a deliberate override. Every wrong "real" from GLM rested on a premise it could not verify. GLM never wrongly said "noise".

The second replay revised the rules for these patterns and told GLM to answer "unsure" when a decision turned on code it could not see. Agreement rose from 0.62 to 0.85 and GLM's wrong "real" calls fell from 10 to 4. New errors appeared, though: a withdrawal rule that overrode fixes made after the bot retracted, a bot self-resolve with no fix behind it, a parsing bug that hid short comment titles, and "follow-up fixes" that were really bulk version bumps. The overturn rate (40%) stayed above the limit. The labels are close but not fully trusted: about 90% right by the adjudicator's reading.

### Jev's scores

Because the trust gate failed, the pass rule was never formally judged. The Jev numbers are informational, measured against the final labels (the automatic labels with the adjudicated corrections applied). Ranges are 95% bootstrap intervals.

| Metric | public-v1 | public-v2 | Pass rule |
|---|---|---|---|
| Items scored (real / noise) | 300 (185 / 115) | 293 (241 / 52) | - |
| AUROC of "worth acting on" | 0.570 (0.501-0.635) | 0.569 (0.485-0.653) | at least 0.75 |
| Noise collapsed while hiding at most 5% of real | 14.8% | 9.6% | at least 40% |
| Precision of "keep" (score of 0.70 or more) | 0.647 | 0.837 | none |
| AUROC on the adjudicated 60-item sample only | 0.651 | 0.548 | - |

The AUROC is barely above a coin flip, and the best threshold would hide only 10-15% of the noise against the 40% asked for. The "keep" precision looks respectable in public-v2, but it hardly beats the share of real comments in each dataset (185 of 300 is 62%, 241 of 293 is 82%): marking every comment "keep" would do almost as well.

The two replays share much of their material, so the matching AUROCs are not independent confirmations, but they show the result did not move when the labels got substantially better.

By bot, the picture was uneven. Gemini's comments came out at 0.66 and 0.65, Cursor's at 0.56 and 0.67. CodeRabbit's were below chance in both replays (0.40 and 0.33): Jev tended to rate CodeRabbit's ignored comments above the ones developers acted on. No bot came near 0.75.

### Does more context help?

A natural objection is that Jev was judging with too little information. A human reviewer would look at what the pull request is for, the issue it fixes and the rest of the file. So a third, pre-registered experiment scored public-v2's 293 labelled comments again with extra context blocks, each holding only what existed when the comment was written (anything later would leak the answer):

- **pr**: the pull request's title and description;
- **issue**: the issue it linked, when there was one (40 of 187 pull requests);
- **code**: the file around the comment, up to 60 lines each side, and the rest of the diff hunk;
- **all**: all three together.

| Variant | AUROC (95% range) | Change vs baseline (paired 95% range) | Noise collapsed at ≤ 5% real hidden | Tokens per item |
|---|---|---|---|---|
| baseline | 0.569 (0.483-0.653) | - | 9.6% | 1,647 |
| pr | 0.560 (0.466-0.651) | -0.008 (-0.068 to 0.050) | 11.5% | 2,277 |
| issue | 0.576 (0.489-0.661) | +0.008 (-0.027 to 0.042) | 7.7% | 1,764 |
| code | 0.543 (0.455-0.627) | -0.026 (-0.071 to 0.018) | 9.6% | 3,292 |
| all | 0.569 (0.475-0.664) | +0.001 (-0.065 to 0.066) | 9.6% | 3,963 |

Every change straddles zero. Giving Jev everything known at comment time more than doubled its input for a change of +0.001. Context moved individual bots around (CodeRabbit rose from 0.33 to 0.48 with everything, Cursor fell from 0.67 to 0.50), but no bot reached the bar under any variant. By the rule written before the run, no variant passed and the noise filter was archived.

## Why Jev falls short here

The adjudications show why. Almost every hard call turned on a fact that is not in the comment or the lines around it:

- **Library behaviour.** Is the value the bot worries about ever empty? Does the framework keep the first or the last of two duplicate flags? Does this class already inherit from a dictionary, as the bot's claim assumed it did not? The adjudicator settled these by reading the library's or the project's own source.
- **Reachability.** A race in a router is real in the abstract, but it needs an asynchronous middleware the application never registers. A configuration field the bot says may be missing is always set by the loader. A parsing bug needs a contrived nested call, and the maintainers left the function unchanged through three later edits. The project's policy labels such latent defects as noise, and deciding it requires tracing how the code is actually used.
- **Repository idioms and intent.** A "blocking call" the bot flags repeats a pattern already used on the same code path. A setting the bot calls a typo is used consistently. A suggested constant does not exist. A change the bot calls accidental was applied deliberately to two example files.

None of these facts is visible in a 25-line hunk, and most are not in the (at most) 120 surrounding lines, the pull request description or the linked issue either. That is why the context blocks did not help: they added more of the same kind of text, not the missing facts. The adjudicator got these cases right because it could follow a lead: open another file, read a dependency, look at the history, try something.

Jev is built for a different kind of question. By design it is a fast rater that fills in a typed form from the material it is given: it returns probabilities, does not write text or explain itself, and has no way to look anything up ([jev-guide.md](jev-guide.md) part 1). "Is this review comment worth acting on?" sounds like a narrow classification, but in practice it is a verification task: check the bot's claim against the real code. A one-shot judge without tools can only rate how plausible the claim sounds, and AI review comments almost always sound plausible. The label check shows the same limit from another angle: GLM, a strong reasoning model given more evidence than Jev, still made its errors on claims it could not verify.

### What Jev might still be good at

These experiments did not test other uses, so the following are hypotheses, not findings. Jev looks better suited to questions whose answer is visible in the material itself: whether a comment is a summary, praise or a question rather than a claim; what category of issue it describes; whether two comments say the same thing; routing items to the right queue. Quiet Review already asks Jev for category, severity and duplicates, but only to label and group its output; none of those answers was measured for accuracy here. A pipeline that first gathers the missing facts with a tool-using model and then asks Jev a narrow, checkable question is another open possibility, though it would give up much of Jev's cost advantage.

## Limitations and threats to validity

- **A small, short sample.** Eight repositories, four bots, one five-day window, about 300 scored comments per replay (only 52 noise items in public-v2). Per-bot numbers rest on 68 to 75 items each.
- **Labels are a proxy.** "The developer changed the code" is not the same as "the comment was worth acting on". Developers merge over valid comments, and change lines for unrelated reasons. The label check measured this, and the labels never passed its gate.
- **Heavy exclusion.** 47% of drawn comments in public-v1 and 62% in public-v2 were excluded, mostly because the pull request's history was rewritten. The scored set over-represents pull requests that were not rebased, which may differ in other ways.
- **The replays overlap.** Public-v2 reused public-v1's repositories and window with a new seed, and its label rules were revised using public-v1's adjudication; 14 adjudicated comments were drawn again. Public-v2 measures the rule revision on overlapping data, not an independent retest.
- **AI adjudication on the maintainer's behalf.** The final word on 38 disputed labels came from Opus 5.5 rather than a person familiar with each project, although it worked from live evidence and recorded its reasons and confidence. Its errors are not measured.
- **The trust gate measures an enriched set.** The 20% overturn limit is applied to the items sent to review, which are disagreements by construction. In public-v2 the corrections were 6 of the full 60-item sample (10%). This was noted after the result and not changed, since changing it would be post hoc.
- **Optimistic thresholds.** The best threshold is chosen on the data it is measured on, so the "noise collapsed" figures flatter Jev slightly.
- **One question wording and one model version.** The rules allow one reworded question set after a failed verdict; both verdicts were inconclusive, so it was never triggered. The context variants did use a lightly reworded question that points at the new blocks, with no gain. Only English-language repositories and one Jev snapshot were tested.

## What we would do differently

- **Test the premise before the product.** A pilot on 50 to 100 carefully adjudicated comments would likely have shown the near-chance separation early, and given a yardstick for the automatic rules.
- **Draw each replay from disjoint data**, such as a later window, so a retest is independent.
- **Set the trust gate on the whole label-check sample**, not only on the disagreements.
- **Measure an upper bound early**: score the same comments with a tool-using model that can read the repository, to separate the task's difficulty from the judge's.

## Reproducing this

The configurations are committed and were locked before scoring: [public-v1.config.json](../replay/public-v1.config.json), [public-v2.config.json](../replay/public-v2.config.json) and [public-v2.variants.json](../replay/public-v2.variants.json). With an OpenRouter key and a GitHub token:

```sh
quiet-review-axi replay public-v2    # build, label, check, then stop for the disagreement review
quiet-review-axi replay public-v2    # after review.jsonl is filled in: score and evaluate
quiet-review-axi report public-v2
quiet-review-axi ablate public-v2    # the rich-context comparison
```

The label check in these configs runs through the Pi CLI on a GLM subscription; an OpenRouter model can be configured instead ([README](../README.md), "Which model checks the labels"). Public-v1 was labelled with the first rule version, which the current code no longer carries: reproduce it from the commit that recorded its result. Three things will not reproduce exactly. GitHub data changes over time (comments get edited or deleted, branches rewritten). The adjudication decisions are not committed, because the working data holds third-party comment text. And the label model may answer differently on a new run.

**Spend.** All GitHub reads and the label checks cost nothing. Jev scoring cost:

| Step | Cost |
|---|---|
| public-v1 (300 comments, 208 calls) | $0.0209 |
| public-v2 (293 comments, 187 calls) | $0.0164 |
| Rich-context comparison, including a discarded first attempt | $0.1428 |
| **Total** | **about $0.18** |

The cheapness held up. The accuracy did not.
