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

_Filled in below after the ablation ran._
