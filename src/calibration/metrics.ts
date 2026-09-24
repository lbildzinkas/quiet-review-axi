// Discrimination and threshold metrics for any judge that returns a probability per item.

export interface ScoredExample {
  probability: number
  // Whether the item belongs to the class the probability is meant to detect.
  positive: boolean
}

// Area under the ROC curve by the rank method (Mann-Whitney U): the share of
// positive-negative pairs where the positive scores higher, a tie counting as half.
// Undefined (null) unless both classes are present.
export function auroc(examples: readonly ScoredExample[]): number | null {
  const positives = examples.filter((example) => example.positive).length
  const negatives = examples.length - positives
  if (positives === 0 || negatives === 0) return null
  const sorted = [...examples].sort((a, b) => a.probability - b.probability)
  let positiveRankSum = 0
  for (let start = 0; start < sorted.length;) {
    let end = start
    while (end + 1 < sorted.length && sorted[end + 1]?.probability === sorted[start]?.probability)
      end++
    // Tied scores share the mean of their 1-based ranks.
    const meanRank = (start + end) / 2 + 1
    for (let index = start; index <= end; index++)
      if (sorted[index]?.positive) positiveRankSum += meanRank
    start = end + 1
  }
  const u = positiveRankSum - (positives * (positives + 1)) / 2
  return u / (positives * negatives)
}

export interface SweepRow {
  threshold: number
  // Share of negatives scoring strictly below the threshold: what a filter at t removes.
  negativesBelow: number
  // Share of positives scoring strictly below the threshold: what it wrongly removes.
  positivesBelow: number
}

export interface SweepOptions {
  // Thresholds in hundredths, inclusive: 1 to 99 is 0.01 to 0.99.
  fromHundredths?: number
  toHundredths?: number
}

// Every threshold from 0.01 to 0.99 in steps of 0.01 by default. Thresholds are exact
// decimals (i / 100), never accumulated sums.
export function thresholdSweep(
  examples: readonly ScoredExample[],
  options: SweepOptions = {},
): SweepRow[] {
  const positives = examples.filter((example) => example.positive).map((e) => e.probability)
  const negatives = examples.filter((example) => !example.positive).map((e) => e.probability)
  const rows: SweepRow[] = []
  for (let step = options.fromHundredths ?? 1; step <= (options.toHundredths ?? 99); step++) {
    const threshold = step / 100
    rows.push({
      threshold,
      negativesBelow: shareBelow(negatives, threshold),
      positivesBelow: shareBelow(positives, threshold),
    })
  }
  return rows
}

// The share of values strictly below the threshold; 0 for an empty list.
export function shareBelow(values: readonly number[], threshold: number): number {
  if (values.length === 0) return 0
  return values.filter((value) => value < threshold).length / values.length
}

// The threshold that removes the most negatives while removing at most `maxPositivesBelow`
// of the positives. Ties go to the lower threshold. Null when no threshold qualifies.
export function chooseThreshold(
  sweep: readonly SweepRow[],
  options: { maxPositivesBelow: number },
): SweepRow | null {
  let best: SweepRow | null = null
  for (const row of sweep) {
    if (row.positivesBelow > options.maxPositivesBelow) continue
    if (best === null || row.negativesBelow > best.negativesBelow) best = row
  }
  return best
}

// Precision of the items a judge accepts: the share of positives among items scoring at or
// above the cut-off. Null when no item scores that high.
export function precisionAtOrAbove(
  examples: readonly ScoredExample[],
  cutoff: number,
): number | null {
  const accepted = examples.filter((example) => example.probability >= cutoff)
  if (accepted.length === 0) return null
  return accepted.filter((example) => example.positive).length / accepted.length
}

export interface CalibrationBin {
  from: number
  to: number
  count: number
  meanProbability: number | null
  positiveRate: number | null
}

const CALIBRATION_BINS = 10

// Probabilities in tenths ([0, 0.1), ..., [0.9, 1]) against the observed positive rate.
export function calibrationTable(examples: readonly ScoredExample[]): CalibrationBin[] {
  const bins: ScoredExample[][] = Array.from({ length: CALIBRATION_BINS }, () => [])
  for (const example of examples) {
    const index = Math.min(CALIBRATION_BINS - 1, Math.floor(example.probability * CALIBRATION_BINS))
    bins[index]?.push(example)
  }
  return bins.map((members, index) => ({
    from: index / CALIBRATION_BINS,
    to: (index + 1) / CALIBRATION_BINS,
    count: members.length,
    meanProbability:
      members.length === 0
        ? null
        : members.reduce((total, example) => total + example.probability, 0) / members.length,
    positiveRate:
      members.length === 0
        ? null
        : members.filter((example) => example.positive).length / members.length,
  }))
}
