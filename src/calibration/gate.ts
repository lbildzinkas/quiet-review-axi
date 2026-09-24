import { auroc } from './metrics.js'
import type { LabelledJudgment } from './evaluate.js'

export interface GateBaseline {
  auroc: number
  // The threshold calibrated on the baseline: the candidate must still protect it.
  threshold: number
}

export interface GateLimits {
  maxAurocDrop: number
  maxPositivesBelow: number
}

export interface GateResult {
  accepted: boolean
  refusal: 'mixed snapshots' | 'one class' | null
  auroc: number | null
  aurocDrop: number | null
  // Share of the candidate's positives below the baseline threshold.
  positivesBelow: number | null
  checks: { auroc: boolean; positivesBelow: boolean }
}

// Rounding slack, so a drop of exactly the allowed amount is not refused by float error.
const EPSILON = 1e-9

// Regression gate for a changed judge (new wording, new prompt) re-judged on the same
// labelled items: accepted only when its AUROC drops by at most `maxAurocDrop` and it loses
// at most `maxPositivesBelow` of the positives at the baseline's calibrated threshold.
export function regressionGate(
  baseline: GateBaseline,
  candidate: readonly LabelledJudgment[],
  limits: GateLimits,
): GateResult {
  const snapshots = new Set(candidate.map((judgment) => judgment.snapshot))
  const measured = auroc(candidate)
  const positives = candidate.filter((judgment) => judgment.positive)
  const positivesBelow =
    positives.length === 0
      ? null
      : positives.filter((judgment) => judgment.probability < baseline.threshold).length /
        positives.length
  const aurocDrop = measured === null ? null : baseline.auroc - measured
  const checks = {
    auroc: aurocDrop !== null && aurocDrop <= limits.maxAurocDrop + EPSILON,
    positivesBelow: positivesBelow !== null && positivesBelow <= limits.maxPositivesBelow + EPSILON,
  }
  const refusal = snapshots.size > 1 ? 'mixed snapshots' : measured === null ? 'one class' : null
  return {
    accepted: refusal === null && checks.auroc && checks.positivesBelow,
    refusal,
    auroc: measured,
    aurocDrop,
    positivesBelow,
    checks,
  }
}
