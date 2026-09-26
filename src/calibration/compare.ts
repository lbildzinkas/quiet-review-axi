import { bootstrapRanges, type BootstrapOptions, type Range } from './bootstrap.js'
import type { LabelledJudgment } from './evaluate.js'
import { auroc } from './metrics.js'

export interface AurocComparison {
  // Items both judges scored, by id.
  items: number
  // The candidate's AUROC minus the baseline's, on those items; null when either is undefined.
  change: number | null
  // Paired bootstrap range of the change: each resample draws the same items for both judges,
  // so the range reflects the difference, not each judge's own spread.
  range: Range | null
}

// Compares two judges scored on the same labelled items, such as two versions of one judge.
export function compareAuroc(
  baseline: readonly LabelledJudgment[],
  candidate: readonly LabelledJudgment[],
  options: BootstrapOptions,
): AurocComparison {
  const candidateOf = new Map(candidate.map((judgment) => [judgment.id, judgment]))
  const pairs = baseline.flatMap((judgment) => {
    const other = candidateOf.get(judgment.id)
    return other ? [{ baseline: judgment, candidate: other }] : []
  })
  const change = (sample: readonly (typeof pairs)[number][]) => {
    const before = auroc(sample.map((pair) => pair.baseline))
    const after = auroc(sample.map((pair) => pair.candidate))
    return before === null || after === null ? null : after - before
  }
  const { change: range } = bootstrapRanges(pairs, { change }, options)
  return { items: pairs.length, change: change(pairs), range }
}
