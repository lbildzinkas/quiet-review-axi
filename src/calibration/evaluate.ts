import { bootstrapRanges, type Range } from './bootstrap.js'
import {
  auroc,
  calibrationTable,
  chooseThreshold,
  precisionAtOrAbove,
  thresholdSweep,
  type CalibrationBin,
  type ScoredExample,
  type SweepRow,
} from './metrics.js'

// One judged item with its known label.
export interface LabelledJudgment extends ScoredExample {
  id: string
  // The model version that produced the probability, as the judge reported it.
  snapshot: string
  // Grouping keys for breakdowns, for example { source: 'bot-a' }.
  groups?: Record<string, string>
}

// Pre-registered pass rule: AUROC at least `minAuroc`, and some threshold that filters at
// least `minNegativesBelow` of the negatives while losing at most `maxPositivesBelow` of the
// positives.
export interface PassRule {
  minAuroc: number
  minNegativesBelow: number
  maxPositivesBelow: number
}

export interface EvaluationOptions {
  passRule: PassRule
  // The upper cut-off of the abstain band: items at or above it are accepted.
  acceptAt: number
  seed: number
  resamples?: number
}

export interface GroupRow {
  value: string
  items: number
  positives: number
  negatives: number
  positiveRate: number
  auroc: number | null
}

export type Verdict = 'pass' | 'fail' | 'refused'

export interface Evaluation {
  counts: { items: number; positives: number; negatives: number }
  snapshots: string[]
  auroc: number | null
  sweep: SweepRow[]
  // The chosen threshold t*: the most negatives below within the positives limit.
  threshold: SweepRow | null
  acceptPrecision: number | null
  // 95% bootstrap ranges. The two rates are read at the chosen threshold, held fixed.
  ranges: {
    auroc: Range | null
    negativesBelow: Range | null
    positivesBelow: Range | null
    acceptPrecision: Range | null
  }
  calibration: CalibrationBin[]
  // Breakdowns by each grouping key, and always by snapshot.
  groups: Record<string, GroupRow[]>
  verdict: Verdict
  // Why the pass rule was not applied: judgments from more than one snapshot, or a class
  // with no items (AUROC undefined).
  refusal: 'mixed snapshots' | 'one class' | null
  checks: { auroc: boolean; threshold: boolean }
}

// Evaluates judged items against their labels and applies the pass rule to the measured
// values. The bootstrap ranges inform the reading of a thin margin but never change the
// verdict. Judgments from more than one snapshot are reported per snapshot, and the pass
// rule is refused until they are re-judged on one.
export function evaluateJudgments(
  judgments: readonly LabelledJudgment[],
  options: EvaluationOptions,
): Evaluation {
  const { passRule } = options
  const positives = judgments.filter((judgment) => judgment.positive).length
  const measuredAuroc = auroc(judgments)
  const sweep = thresholdSweep(judgments)
  const threshold = chooseThreshold(sweep, { maxPositivesBelow: passRule.maxPositivesBelow })
  const snapshots = [...new Set(judgments.map((judgment) => judgment.snapshot))].sort(compareText)
  const at = threshold?.threshold
  const ranges = bootstrapRanges(
    judgments,
    {
      auroc,
      negativesBelow: (sample) => (at === undefined ? null : classShareBelow(sample, false, at)),
      positivesBelow: (sample) => (at === undefined ? null : classShareBelow(sample, true, at)),
      acceptPrecision: (sample) => precisionAtOrAbove(sample, options.acceptAt),
    },
    { seed: options.seed, resamples: options.resamples },
  )
  const checks = {
    auroc: measuredAuroc !== null && measuredAuroc >= passRule.minAuroc,
    threshold: threshold !== null && threshold.negativesBelow >= passRule.minNegativesBelow,
  }
  const refusal =
    snapshots.length > 1 ? 'mixed snapshots' : measuredAuroc === null ? 'one class' : null
  const verdict: Verdict =
    refusal !== null ? 'refused' : checks.auroc && checks.threshold ? 'pass' : 'fail'
  return {
    counts: { items: judgments.length, positives, negatives: judgments.length - positives },
    snapshots,
    auroc: measuredAuroc,
    sweep,
    threshold,
    acceptPrecision: precisionAtOrAbove(judgments, options.acceptAt),
    ranges,
    calibration: calibrationTable(judgments),
    groups: breakdowns(judgments),
    verdict,
    refusal,
    checks,
  }
}

// Share of one class below the threshold; undefined when the sample has none of that class.
function classShareBelow(
  sample: readonly ScoredExample[],
  positive: boolean,
  threshold: number,
): number | null {
  const members = sample.filter((example) => example.positive === positive)
  if (members.length === 0) return null
  return members.filter((example) => example.probability < threshold).length / members.length
}

function breakdowns(judgments: readonly LabelledJudgment[]): Record<string, GroupRow[]> {
  const keys = new Set(judgments.flatMap((judgment) => Object.keys(judgment.groups ?? {})))
  const result: Record<string, GroupRow[]> = {}
  for (const key of [...keys].sort(compareText))
    result[key] = groupRows(judgments, (judgment) => judgment.groups?.[key])
  result.snapshot = groupRows(judgments, (judgment) => judgment.snapshot)
  return result
}

function groupRows(
  judgments: readonly LabelledJudgment[],
  valueOf: (judgment: LabelledJudgment) => string | undefined,
): GroupRow[] {
  const members = new Map<string, LabelledJudgment[]>()
  for (const judgment of judgments) {
    const value = valueOf(judgment)
    if (value !== undefined) members.set(value, [...(members.get(value) ?? []), judgment])
  }
  return [...members.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([value, group]) => {
      const positives = group.filter((judgment) => judgment.positive).length
      return {
        value,
        items: group.length,
        positives,
        negatives: group.length - positives,
        positiveRate: positives / group.length,
        auroc: auroc(group),
      }
    })
}

function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}
