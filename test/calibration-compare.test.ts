import { describe, expect, it } from 'vitest'
import { compareAuroc, type LabelledJudgment } from '../src/calibration/index.js'

// Judgments by id, as [probability, positive] pairs.
function judged(pairs: [number, boolean][]): LabelledJudgment[] {
  return pairs.map(([probability, positive], index) => ({
    id: `i${index}`,
    probability,
    positive,
    snapshot: 's1',
  }))
}

const BASELINE = judged([
  [0.9, true],
  [0.3, true],
  [0.6, true],
  [0.2, false],
  [0.7, false],
  [0.1, false],
])

describe('paired AUROC comparison of two judges on the same items', () => {
  it('measures no change, with a zero range, when both judges agree', () => {
    const result = compareAuroc(BASELINE, BASELINE, { seed: 7, resamples: 200 })

    expect(result.change).toBe(0)
    expect(result.range).toEqual({ low: 0, high: 0 })
    expect(result.items).toBe(6)
  })

  it('measures the change in AUROC and a range that resamples the same items for both', () => {
    // The candidate lifts the real item at 0.3 above every noise item: AUROC 7/9 to 8/9.
    const candidate = BASELINE.map((judgment) =>
      judgment.id === 'i1' ? { ...judgment, probability: 0.8 } : judgment,
    )

    const result = compareAuroc(BASELINE, candidate, { seed: 7, resamples: 500 })

    expect(result.change).toBeCloseTo(1 / 9, 10)
    // Only a real item moved up, so no resample of the same items can show a drop.
    expect(result.range?.low).toBeGreaterThanOrEqual(0)
    expect(result.range?.high).toBeGreaterThan(0.1)
  })

  it('compares only the items both judges scored', () => {
    const result = compareAuroc(BASELINE, BASELINE.slice(0, 5), { seed: 7, resamples: 50 })

    expect(result.items).toBe(5)
  })
})
