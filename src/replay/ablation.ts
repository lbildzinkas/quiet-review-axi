import {
  compareAuroc,
  evaluateJudgments,
  type Evaluation,
  type LabelledJudgment,
  type Range,
} from '../calibration/index.js'
import { BUILT_IN_CUTOFFS } from '../core/cutoffs.js'
import type { QuestionPack } from '../core/questions.js'
import { createJevJudge, type JevJudgeOptions, type JudgeItem } from '../jev/judge.js'
import type { DrawnItem } from './build.js'
import type { ReplayConfig } from './config.js'
import { BOOTSTRAP_RESAMPLES, type Interval } from './evaluate.js'
import type { FinalLabel } from './final-labels.js'
import type { ScoreRow } from './score.js'
import { toJudgeItems } from './score.js'
import type { BlockCoverage, ReplayContext } from './context.js'
import type { ContextBlock } from './variants.js'

// One variant of the context ablation: the question pack and the context blocks it scores with.
export interface AblationVariant {
  name: string
  pack: QuestionPack
  blocks: ContextBlock[]
}

export interface VariantOutcome {
  variant: AblationVariant
  judgments: LabelledJudgment[]
  rows: ScoreRow[]
  calls: number
  // Input tokens of the variant's calls, cache hits included.
  inputTokens: number
  // What the variant's answers cost when they were paid for; cache hits count their first cost.
  costUsd: number
  // What this run paid.
  spentUsd: number
  snapshots: string[]
  // Items left unscored at --max-cost.
  unscored: number
}

// The labelled (real or noise) items of a replay, in the batches the score stage builds.
export interface LabelledJudgeItem {
  item: JudgeItem
  positive: boolean
  groups: { bot: string }
}

export function labelledJudgeItems(items: DrawnItem[], labels: FinalLabel[]): LabelledJudgeItem[] {
  const labelOf = new Map(labels.map((entry) => [entry.id, entry.label]))
  const drawnOf = new Map(items.map((item) => [item.id, item]))
  const judgeItems = toJudgeItems(
    items.filter((item) => {
      const label = labelOf.get(item.id)
      return label === 'real' || label === 'noise'
    }),
  )
  return judgeItems.map((item) => ({
    item,
    positive: labelOf.get(item.id) === 'real',
    groups: { bot: drawnOf.get(item.id)?.bot ?? '' },
  }))
}

// The labelled items with a variant's context blocks added to their requests. Without blocks
// they are the score stage's items unchanged, so their requests are byte-identical.
export function withBlocks(
  labelled: LabelledJudgeItem[],
  blocks: readonly ContextBlock[],
  context: ReplayContext,
): LabelledJudgeItem[] {
  if (blocks.length === 0) return labelled
  return labelled.map((entry) => {
    const { item } = entry
    const header = { ...item.header }
    const pull = context.pulls.get(item.batch)
    if (blocks.includes('pr_description') && pull) {
      if (pull.title !== null) header.title = pull.title
      if (pull.description !== null) header.description = pull.description
    }
    if (blocks.includes('linked_issue') && pull?.linked_issue)
      header.linkedIssue = pull.linked_issue
    const code = blocks.includes('wider_code') ? context.items.get(item.id) : undefined
    return {
      ...entry,
      item: {
        ...item,
        header,
        item: {
          ...item.item,
          ...(code?.file ? { file: code.file } : {}),
          ...(code?.hunk_rest ? { hunkRest: code.hunk_rest } : {}),
        },
      },
    }
  })
}

// Scores the labelled items under one variant, through the shared request builder, cache,
// budget and cost log.
export async function scoreVariant(input: {
  variant: AblationVariant
  labelled: LabelledJudgeItem[]
  judgeOptions: JevJudgeOptions
}): Promise<VariantOutcome> {
  const { variant } = input
  const jev = createJevJudge({ ...input.judgeOptions, pack: variant.pack })
  const results = await jev.judge.judge(input.labelled.map((entry) => entry.item))
  const facts = jev.facts()
  const byId = new Map(results.map((result) => [result.id, result]))
  const judgments: LabelledJudgment[] = []
  const rows: ScoreRow[] = []
  for (const { item, positive, groups } of input.labelled) {
    const result = byId.get(item.id)
    if (!result) continue
    judgments.push({
      id: item.id,
      probability: result.probability,
      snapshot: result.snapshot,
      positive,
      groups,
    })
    rows.push({
      id: item.id,
      snapshot: result.snapshot,
      worth: result.probability,
      category: result.category,
      severity: result.severity,
      dup_of: result.dupOf,
    })
  }
  return {
    variant,
    judgments,
    rows,
    calls: facts.calls,
    inputTokens: facts.inputTokens,
    costUsd: facts.answersCostUsd,
    spentUsd: facts.costUsd,
    snapshots: facts.snapshots,
    unscored: facts.unjudged.length,
  }
}

// The replay's evaluation (spec 10.7) of one variant's judgments: same pass-rule limits, seed
// and resamples, so the variants' numbers compare with each other and with the replay's.
export function evaluateVariant(judgments: LabelledJudgment[], config: ReplayConfig): Evaluation {
  const rule = config.pass_rule
  return evaluateJudgments(judgments, {
    passRule: {
      minAuroc: rule.min_auroc,
      minNegativesBelow: rule.min_noise_collapsed,
      maxPositivesBelow: rule.max_real_hidden,
    },
    acceptAt: BUILT_IN_CUTOFFS.keepAt,
    seed: config.seed,
    resamples: BOOTSTRAP_RESAMPLES,
  })
}

// One variant's line of the comparison: accuracy with its 95% ranges, the change against the
// baseline on the same items (paired range), and token cost. Aggregates only, no comment text.
export interface VariantResult {
  variant: string
  question_pack: string
  blocks: ContextBlock[]
  items: number
  auroc: number | null
  auroc_ci95: Interval | null
  auroc_change: number | null
  auroc_change_ci95: Interval | null
  best_threshold: number | null
  noise_collapsed: number | null
  noise_collapsed_ci95: Interval | null
  real_hidden: number | null
  real_hidden_ci95: Interval | null
  keep_precision: number | null
  keep_precision_ci95: Interval | null
  calls: number
  input_tokens: number
  tokens_per_item: number
  cost_usd: number
  snapshots: string[]
}

export interface AblationResult {
  replay: string
  evaluated_at: string
  provider: string
  variants_file: string
  items: number
  real: number
  noise: number
  // The replay's label-check trust verdict, null without a check stage: an inconclusive one
  // means the labels every variant is measured on are not trusted.
  trust: string | null
  context: BlockCoverage[]
  variants: VariantResult[]
  // AUROC per bot and variant.
  by_bot: { bot: string; items: number; real: number; auroc: Record<string, number | null> }[]
  bootstrap: { resamples: number; seed: number }
  cost_usd: number
}

// The comparison of the scored variants; the first is the baseline.
export function compareVariants(input: {
  replay: string
  config: ReplayConfig
  outcomes: VariantOutcome[]
  provider: string
  variantsFile: string
  trust: string | null
  context: BlockCoverage[]
  costUsd: number
  evaluatedAt: string
}): AblationResult {
  const { config, outcomes } = input
  const evaluated = outcomes.map((outcome) => ({
    outcome,
    evaluation: evaluateVariant(outcome.judgments, config),
  }))
  const [baseline] = evaluated
  const bootstrap = { resamples: BOOTSTRAP_RESAMPLES, seed: config.seed }
  const variants = evaluated.map(({ outcome, evaluation }): VariantResult => {
    const { threshold } = evaluation
    const items = outcome.judgments.length
    const comparison = baseline
      ? compareAuroc(baseline.outcome.judgments, outcome.judgments, bootstrap)
      : null
    return {
      variant: outcome.variant.name,
      question_pack: outcome.variant.pack.version,
      blocks: outcome.variant.blocks,
      items,
      auroc: evaluation.auroc,
      auroc_ci95: interval(evaluation.ranges.auroc),
      auroc_change: comparison?.change ?? null,
      auroc_change_ci95: interval(comparison?.range ?? null),
      best_threshold: threshold?.threshold ?? null,
      noise_collapsed: threshold?.negativesBelow ?? null,
      noise_collapsed_ci95: interval(evaluation.ranges.negativesBelow),
      real_hidden: threshold?.positivesBelow ?? null,
      real_hidden_ci95: interval(evaluation.ranges.positivesBelow),
      keep_precision: evaluation.acceptPrecision,
      keep_precision_ci95: interval(evaluation.ranges.acceptPrecision),
      calls: outcome.calls,
      input_tokens: outcome.inputTokens,
      tokens_per_item: items === 0 ? 0 : Math.round(outcome.inputTokens / items),
      cost_usd: outcome.costUsd,
      snapshots: outcome.snapshots,
    }
  })
  const bots = baseline?.evaluation.groups.bot ?? []
  const counts = baseline?.evaluation.counts
  return {
    replay: input.replay,
    evaluated_at: input.evaluatedAt,
    provider: input.provider,
    variants_file: input.variantsFile,
    items: counts?.items ?? 0,
    real: counts?.positives ?? 0,
    noise: counts?.negatives ?? 0,
    trust: input.trust,
    context: input.context,
    variants,
    by_bot: bots.map((row) => ({
      bot: row.value,
      items: row.items,
      real: row.positives,
      auroc: Object.fromEntries(
        evaluated.map(({ outcome, evaluation }) => [
          outcome.variant.name,
          evaluation.groups.bot?.find((group) => group.value === row.value)?.auroc ?? null,
        ]),
      ),
    })),
    bootstrap,
    cost_usd: input.costUsd,
  }
}

function interval(range: Range | null): Interval | null {
  return range === null ? null : [range.low, range.high]
}
