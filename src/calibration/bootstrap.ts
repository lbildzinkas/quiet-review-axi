import { seededRandom } from './random.js'

export interface Range {
  low: number
  high: number
}

export interface BootstrapOptions {
  seed: number
  resamples?: number
  // Central coverage of the range; 0.95 gives the 2.5th and 97.5th percentiles.
  level?: number
}

export const DEFAULT_RESAMPLES = 2000
export const DEFAULT_LEVEL = 0.95

// Percentile bootstrap: resamples the items with replacement from one seeded generator and
// reads each statistic's range from its resampled values, so the same data and seed always
// give the same ranges. Resamples where a statistic is undefined (null) are skipped for it;
// a statistic undefined in every resample has no range.
export function bootstrapRanges<T, K extends string>(
  items: readonly T[],
  statistics: Record<K, (sample: readonly T[]) => number | null>,
  options: BootstrapOptions,
): Record<K, Range | null> {
  const names = Object.keys(statistics) as K[]
  const values = new Map<K, number[]>(names.map((name) => [name, []]))
  const random = seededRandom(options.seed)
  const resamples = options.resamples ?? DEFAULT_RESAMPLES
  for (let round = 0; round < resamples && items.length > 0; round++) {
    const sample = Array.from(
      { length: items.length },
      () => items[Math.floor(random() * items.length)] as T,
    )
    for (const name of names) {
      const value = statistics[name](sample)
      if (value !== null && Number.isFinite(value)) values.get(name)?.push(value)
    }
  }
  const tail = (1 - (options.level ?? DEFAULT_LEVEL)) / 2
  return Object.fromEntries(
    names.map((name) => {
      const sorted = (values.get(name) ?? []).sort((a, b) => a - b)
      if (sorted.length === 0) return [name, null]
      return [name, { low: quantile(sorted, tail), high: quantile(sorted, 1 - tail) }]
    }),
  ) as Record<K, Range | null>
}

// Linear interpolation between the closest ranks of a sorted list.
function quantile(sorted: readonly number[], q: number): number {
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const low = sorted[lower] ?? 0
  const high = sorted[upper] ?? low
  return low + (high - low) * (position - lower)
}
