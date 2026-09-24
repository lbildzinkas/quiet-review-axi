import { describe, expect, it } from 'vitest'
import {
  auroc,
  calibrationTable,
  chooseThreshold,
  precisionAtOrAbove,
  thresholdSweep,
} from '../src/calibration/index.js'

// Examples as [probability, positive] pairs, to keep hand-computed cases readable.
function examples(pairs: [number, boolean][]) {
  return pairs.map(([probability, positive]) => ({ probability, positive }))
}

describe('AUROC by the rank method', () => {
  it('is 1 when every positive scores above every negative', () => {
    expect(
      auroc(
        examples([
          [0.9, true],
          [0.8, true],
          [0.2, false],
          [0.1, false],
        ]),
      ),
    ).toBe(1)
  })

  it('is 0 when every positive scores below every negative', () => {
    expect(
      auroc(
        examples([
          [0.1, true],
          [0.9, false],
        ]),
      ),
    ).toBe(0)
  })

  it('counts a tied positive-negative pair as half', () => {
    // Pairs: 0.5~0.5 half, 0.5>0.3, 0.7>0.5, 0.7>0.3 -> 3.5 of 4.
    expect(
      auroc(
        examples([
          [0.5, true],
          [0.7, true],
          [0.5, false],
          [0.3, false],
        ]),
      ),
    ).toBe(0.875)
  })

  it('is 0.5 when every score is tied', () => {
    expect(
      auroc(
        examples([
          [0.4, true],
          [0.4, true],
          [0.4, false],
        ]),
      ),
    ).toBe(0.5)
  })

  it('is undefined (null) when only one class is present', () => {
    expect(
      auroc(
        examples([
          [0.4, true],
          [0.6, true],
        ]),
      ),
    ).toBeNull()
    expect(auroc([])).toBeNull()
  })
})

// Negatives at 0.1, 0.2, 0.6, 0.9; positives at 0.15, 0.5, 0.8, 0.95.
const SPREAD = examples([
  [0.1, false],
  [0.2, false],
  [0.6, false],
  [0.9, false],
  [0.15, true],
  [0.5, true],
  [0.8, true],
  [0.95, true],
])

describe('threshold sweep', () => {
  it('steps from 0.01 to 0.99 by 0.01 with exact thresholds', () => {
    const sweep = thresholdSweep(SPREAD)

    expect(sweep).toHaveLength(99)
    expect(sweep[0]?.threshold).toBe(0.01)
    expect(sweep[28]?.threshold).toBe(0.29)
    expect(sweep.at(-1)?.threshold).toBe(0.99)
  })

  it('gives the share of each class scoring strictly below the threshold', () => {
    const at = (threshold: number) =>
      thresholdSweep(SPREAD).find((row) => row.threshold === threshold)

    expect(at(0.15)).toEqual({ threshold: 0.15, negativesBelow: 0.25, positivesBelow: 0 })
    expect(at(0.2)).toEqual({ threshold: 0.2, negativesBelow: 0.25, positivesBelow: 0.25 })
    expect(at(0.61)).toEqual({ threshold: 0.61, negativesBelow: 0.75, positivesBelow: 0.5 })
  })
})

describe('chosen threshold', () => {
  it('takes the most negatives below among thresholds within the positives limit, ties to the lower', () => {
    expect(chooseThreshold(thresholdSweep(SPREAD), { maxPositivesBelow: 0 })).toEqual({
      threshold: 0.11,
      negativesBelow: 0.25,
      positivesBelow: 0,
    })
    expect(chooseThreshold(thresholdSweep(SPREAD), { maxPositivesBelow: 0.25 })?.threshold).toBe(
      0.21,
    )
  })

  it('is null when no threshold keeps the positives below the limit', () => {
    const sweep = thresholdSweep(
      examples([
        [0.005, true],
        [0.5, false],
      ]),
    )

    expect(chooseThreshold(sweep, { maxPositivesBelow: 0 })).toBeNull()
  })
})

describe('precision at or above a cut-off', () => {
  it('is the share of positives among items scoring at or above it', () => {
    expect(precisionAtOrAbove(SPREAD, 0.91)).toBe(1)
    expect(precisionAtOrAbove(SPREAD, 0.7)).toBeCloseTo(2 / 3, 12)
  })

  it('is undefined (null) when nothing scores that high', () => {
    expect(precisionAtOrAbove(SPREAD, 0.99)).toBeNull()
  })
})

describe('calibration table', () => {
  it('bins probabilities into tenths against the observed positive rate', () => {
    const table = calibrationTable(SPREAD)

    expect(table).toHaveLength(10)
    expect(table[1]).toEqual({
      from: 0.1,
      to: 0.2,
      count: 2,
      meanProbability: 0.125,
      positiveRate: 0.5,
    })
    expect(table[2]).toMatchObject({ from: 0.2, to: 0.3, count: 1, positiveRate: 0 })
    expect(table[9]).toMatchObject({ from: 0.9, to: 1, count: 2, positiveRate: 0.5 })
    expect(table[9]?.meanProbability).toBeCloseTo(0.925, 12)
  })

  it('leaves empty bins without a rate, and puts a probability of 1 in the top bin', () => {
    const table = calibrationTable(examples([[1, true]]))

    expect(table[0]).toEqual({
      from: 0,
      to: 0.1,
      count: 0,
      meanProbability: null,
      positiveRate: null,
    })
    expect(table[9]).toMatchObject({ count: 1, positiveRate: 1 })
  })
})
