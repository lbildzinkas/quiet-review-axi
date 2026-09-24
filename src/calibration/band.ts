// A three-way band over a judge's probability: below `lower` the item is filtered, at or
// above `upper` it is accepted, and in between the judge abstains. The abstain band absorbs
// run-to-run drift in the probability, so borderline items do not flip between the ends.
export interface Band {
  lower: number
  upper: number
}

// The band after calibration: the chosen threshold becomes the lower edge. The upper edge,
// which the calibration does not test, keeps its default unless the threshold is above it.
export function calibratedBand(input: { threshold: number; defaults: Band }): Band {
  return { lower: input.threshold, upper: Math.max(input.defaults.upper, input.threshold) }
}
