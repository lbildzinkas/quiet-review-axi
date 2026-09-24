import { describe, expect, it } from 'vitest'
import { auroc, bootstrapRanges, type ScoredExample } from '../src/calibration/index.js'

function alternating(count: number): ScoredExample[] {
  return Array.from({ length: count }, (_, index) => ({
    probability: (index % 10) / 10,
    positive: index % 2 === 0,
  }))
}

const positiveShare = (sample: readonly ScoredExample[]) =>
  sample.filter((example) => example.positive).length / sample.length

describe('bootstrap 95% ranges', () => {
  it('gives the same ranges for the same seed, and different ones for another seed', () => {
    const data = alternating(60)
    const run = (seed: number) => bootstrapRanges(data, { auroc, share: positiveShare }, { seed })

    expect(run(20260923)).toEqual(run(20260923))
    expect(run(20260923)).not.toEqual(run(7))
  })

  it('draws 2,000 resamples by default', () => {
    let calls = 0
    bootstrapRanges(alternating(20), { count: () => ++calls }, { seed: 1 })

    expect(calls).toBe(2000)
  })

  it('matches the binomial spread of a share: about ±0.1 around 0.5 for 100 items', () => {
    const range = bootstrapRanges(alternating(100), { share: positiveShare }, { seed: 3 }).share

    expect(range?.low).toBeGreaterThan(0.38)
    expect(range?.low).toBeLessThan(0.45)
    expect(range?.high).toBeGreaterThan(0.55)
    expect(range?.high).toBeLessThan(0.62)
  })

  it('collapses to a point when every resample gives the same value', () => {
    const separated: ScoredExample[] = [
      { probability: 0.9, positive: true },
      { probability: 0.8, positive: true },
      { probability: 0.2, positive: false },
      { probability: 0.1, positive: false },
    ]

    expect(bootstrapRanges(separated, { auroc }, { seed: 5 }).auroc).toEqual({ low: 1, high: 1 })
  })

  it('skips resamples where the statistic is undefined, and is null when all are', () => {
    const onePositive: ScoredExample[] = [{ probability: 0.5, positive: true }]

    expect(bootstrapRanges(onePositive, { auroc }, { seed: 5 }).auroc).toBeNull()
  })
})
