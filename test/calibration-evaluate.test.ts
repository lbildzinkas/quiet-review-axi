import { describe, expect, it } from 'vitest'
import { evaluateJudgments, type LabelledJudgment } from '../src/calibration/index.js'

const RULE = { minAuroc: 0.75, minNegativesBelow: 0.4, maxPositivesBelow: 0.05 }
const OPTIONS = { passRule: RULE, acceptAt: 0.7, seed: 20260923 }

// `count` items of one class at evenly spread probabilities from `low` to `high`.
function spread(
  count: number,
  positive: boolean,
  low: number,
  high: number,
  extra: Partial<LabelledJudgment> = {},
): LabelledJudgment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${positive ? 'p' : 'n'}${low}-${index}`,
    probability: low + ((high - low) * index) / Math.max(1, count - 1),
    positive,
    snapshot: 'judge-2026-09-17',
    ...extra,
  }))
}

describe('evaluating a judge against labels', () => {
  it('passes when AUROC and the filter condition both hold on the measured values', () => {
    const judgments = [...spread(20, true, 0.6, 0.99), ...spread(20, false, 0.05, 0.4)]

    const evaluation = evaluateJudgments(judgments, OPTIONS)

    expect(evaluation.verdict).toBe('pass')
    expect(evaluation.checks).toEqual({ auroc: true, threshold: true })
    expect(evaluation.auroc).toBe(1)
    expect(evaluation.threshold).toEqual({ threshold: 0.41, negativesBelow: 1, positivesBelow: 0 })
    expect(evaluation.counts).toEqual({ items: 40, positives: 20, negatives: 20 })
    expect(evaluation.acceptPrecision).toBe(1)
    expect(evaluation.ranges.auroc).toEqual({ low: 1, high: 1 })
    expect(evaluation.ranges.negativesBelow).toEqual({ low: 1, high: 1 })
    expect(evaluation.sweep).toHaveLength(99)
    expect(evaluation.calibration).toHaveLength(10)
  })

  it('fails on AUROC below the minimum', () => {
    // Positives 0.3-0.7 against negatives 0.2-0.6: heavy overlap.
    const judgments = [...spread(10, true, 0.3, 0.7), ...spread(10, false, 0.2, 0.6)]

    const evaluation = evaluateJudgments(judgments, OPTIONS)

    expect(evaluation.auroc).toBeLessThan(0.75)
    expect(evaluation.verdict).toBe('fail')
    expect(evaluation.checks.auroc).toBe(false)
  })

  it('fails when no threshold filters enough negatives within the positives limit', () => {
    // Two of twenty positives score 0.01, so every threshold above 0.01 loses 10% of them.
    const judgments = [
      ...spread(18, true, 0.7, 0.99),
      ...spread(2, true, 0.01, 0.01),
      ...spread(20, false, 0.05, 0.5),
    ]

    const evaluation = evaluateJudgments(judgments, OPTIONS)

    expect(evaluation.auroc).toBeGreaterThan(0.75)
    expect(evaluation.threshold).toEqual({ threshold: 0.01, negativesBelow: 0, positivesBelow: 0 })
    expect(evaluation.verdict).toBe('fail')
    expect(evaluation.checks).toEqual({ auroc: true, threshold: false })
  })

  it('refuses the pass rule when judgments span more than one snapshot, and reports each', () => {
    const judgments = [
      ...spread(10, true, 0.6, 0.99),
      ...spread(10, false, 0.05, 0.4),
      ...spread(4, true, 0.5, 0.9, { snapshot: 'judge-2026-10-01' }),
      ...spread(4, false, 0.1, 0.3, { snapshot: 'judge-2026-10-01' }),
    ]

    const evaluation = evaluateJudgments(judgments, OPTIONS)

    expect(evaluation.verdict).toBe('refused')
    expect(evaluation.refusal).toBe('mixed snapshots')
    expect(evaluation.snapshots).toEqual(['judge-2026-09-17', 'judge-2026-10-01'])
    expect(evaluation.groups.snapshot).toEqual([
      {
        value: 'judge-2026-09-17',
        items: 20,
        positives: 10,
        negatives: 10,
        positiveRate: 0.5,
        auroc: 1,
      },
      {
        value: 'judge-2026-10-01',
        items: 8,
        positives: 4,
        negatives: 4,
        positiveRate: 0.5,
        auroc: 1,
      },
    ])
  })

  it('refuses the pass rule without both classes', () => {
    const evaluation = evaluateJudgments(spread(5, true, 0.2, 0.9), OPTIONS)

    expect(evaluation.verdict).toBe('refused')
    expect(evaluation.refusal).toBe('one class')
    expect(evaluation.auroc).toBeNull()
  })

  it('breaks results down by each grouping key, sorted by value', () => {
    const judgments = [
      ...spread(3, true, 0.6, 0.9, { groups: { source: 'b' } }),
      ...spread(1, false, 0.1, 0.1, { groups: { source: 'b' } }),
      ...spread(2, false, 0.2, 0.3, { groups: { source: 'a' } }),
    ]

    const evaluation = evaluateJudgments(judgments, OPTIONS)

    expect(evaluation.groups.source).toEqual([
      { value: 'a', items: 2, positives: 0, negatives: 2, positiveRate: 0, auroc: null },
      { value: 'b', items: 4, positives: 3, negatives: 1, positiveRate: 0.75, auroc: 1 },
    ])
  })

  it('gives identical results, ranges included, for the same data and seed', () => {
    const judgments = [...spread(15, true, 0.2, 0.95), ...spread(15, false, 0.05, 0.75)]

    expect(evaluateJudgments(judgments, OPTIONS)).toEqual(evaluateJudgments(judgments, OPTIONS))
    expect(evaluateJudgments(judgments, OPTIONS).ranges.auroc).not.toEqual(
      evaluateJudgments(judgments, { ...OPTIONS, seed: 1 }).ranges.auroc,
    )
  })
})
