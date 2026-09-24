import { describe, expect, it } from 'vitest'
import {
  calibratedBand,
  driftedSnapshots,
  judgeLabelled,
  regressionGate,
  type Judge,
  type LabelledJudgment,
} from '../src/calibration/index.js'

interface Text {
  key: string
  text: string
}

// A judge that knows a fixed probability per text and cannot judge the rest.
function tableJudge(table: Record<string, number>): Judge<Text> {
  return {
    judge: async (items) =>
      items
        .filter((item) => table[item.text] !== undefined)
        .map((item) => ({ id: item.key, probability: table[item.text] ?? 0, snapshot: 'j-1' })),
  }
}

describe('judging labelled items', () => {
  it('joins each judgment with its label and groups, and lists the items not judged', async () => {
    const judge = tableJudge({ 'null deref': 0.9, 'nice work': 0.1 })

    const result = await judgeLabelled(
      judge,
      [
        { item: { key: 'a', text: 'null deref' }, positive: true, groups: { source: 'x' } },
        { item: { key: 'b', text: 'nice work' }, positive: false },
        { item: { key: 'c', text: 'unknown' }, positive: false },
      ],
      (item) => item.key,
    )

    expect(result.judgments).toEqual([
      { id: 'a', probability: 0.9, snapshot: 'j-1', positive: true, groups: { source: 'x' } },
      { id: 'b', probability: 0.1, snapshot: 'j-1', positive: false },
    ])
    expect(result.missing).toEqual(['c'])
  })
})

describe('abstain band from a calibrated threshold', () => {
  it('takes the threshold as the lower edge and keeps the default upper edge above it', () => {
    const defaults = { lower: 0.3, upper: 0.7 }

    expect(calibratedBand({ threshold: 0.27, defaults })).toEqual({ lower: 0.27, upper: 0.7 })
    expect(calibratedBand({ threshold: 0.82, defaults })).toEqual({ lower: 0.82, upper: 0.82 })
  })
})

describe('snapshot drift', () => {
  it('lists observed snapshots other than the one a calibration was measured on', () => {
    expect(driftedSnapshots('j-1', ['j-1'])).toEqual([])
    expect(driftedSnapshots('j-1', ['j-1', 'j-2'])).toEqual(['j-2'])
  })
})

// Ten negatives at 0.00-0.27 and the given positives, all on one snapshot.
function candidate(positives: number[], extraNegatives: number[] = []): LabelledJudgment[] {
  const negatives = [...Array.from({ length: 10 }, (_, index) => index * 0.03), ...extraNegatives]
  return [
    ...positives.map((probability, index) => ({
      id: `p${index}`,
      probability,
      positive: true,
      snapshot: 'j-1',
    })),
    ...negatives.map((probability, index) => ({
      id: `n${index}`,
      probability,
      positive: false,
      snapshot: 'j-1',
    })),
  ]
}

describe('regression gate for a changed judge', () => {
  const limits = { maxAurocDrop: 0.02, maxPositivesBelow: 0.05 }

  it('accepts a candidate whose AUROC holds and that loses no more positives at the baseline threshold', () => {
    const result = regressionGate(
      { auroc: 0.95, threshold: 0.28 },
      candidate([0.9, 0.8, 0.7, 0.6]),
      limits,
    )

    expect(result).toMatchObject({ accepted: true, auroc: 1, positivesBelow: 0 })
    expect(result.aurocDrop).toBeCloseTo(-0.05, 12)
    expect(result.checks).toEqual({ auroc: true, positivesBelow: true })
  })

  it('accepts a drop of exactly the allowed amount, and rejects a larger one', () => {
    // One positive at 0.35 scores below one extra negative at 0.4: 43 of 44 pairs, 0.977.
    const judgments = candidate([0.9, 0.9, 0.9, 0.35], [0.4])
    const measured = 43 / 44

    expect(
      regressionGate({ auroc: measured + 0.02, threshold: 0.28 }, judgments, limits).accepted,
    ).toBe(true)
    const worse = regressionGate({ auroc: measured + 0.03, threshold: 0.28 }, judgments, limits)
    expect(worse.accepted).toBe(false)
    expect(worse.checks.auroc).toBe(false)
  })

  it('rejects a candidate that loses more positives at the baseline threshold', () => {
    // One of four positives now scores 0.2, below the baseline threshold 0.28.
    const result = regressionGate(
      { auroc: 0.7, threshold: 0.28 },
      candidate([0.9, 0.8, 0.7, 0.2]),
      limits,
    )

    expect(result.positivesBelow).toBe(0.25)
    expect(result.accepted).toBe(false)
    expect(result.checks).toEqual({ auroc: true, positivesBelow: false })
  })

  it('refuses a candidate judged on more than one snapshot', () => {
    const judgments = candidate([0.9]).map((judgment, index) =>
      index === 0 ? { ...judgment, snapshot: 'j-2' } : judgment,
    )

    const result = regressionGate({ auroc: 0.9, threshold: 0.28 }, judgments, limits)

    expect(result.accepted).toBe(false)
    expect(result.refusal).toBe('mixed snapshots')
  })
})
