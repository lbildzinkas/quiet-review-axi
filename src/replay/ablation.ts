import { evaluateJudgments, type Evaluation, type LabelledJudgment } from '../calibration/index.js'
import { BUILT_IN_CUTOFFS } from '../core/cutoffs.js'
import type { QuestionPack } from '../core/questions.js'
import { createJevJudge, type JevJudgeOptions, type JudgeItem } from '../jev/judge.js'
import type { DrawnItem } from './build.js'
import type { ReplayConfig } from './config.js'
import { BOOTSTRAP_RESAMPLES } from './evaluate.js'
import type { FinalLabel } from './final-labels.js'
import type { ScoreRow } from './score.js'
import { toJudgeItems } from './score.js'
import type { ReplayContext } from './context.js'
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
