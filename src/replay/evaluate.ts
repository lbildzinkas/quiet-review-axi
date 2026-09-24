import {
  calibratedBand,
  evaluateJudgments,
  type GroupRow,
  type LabelledJudgment,
  type Range,
} from '../calibration/index.js'
import { BUILT_IN_CUTOFFS } from '../core/cutoffs.js'
import { severityWord } from '../output/human.js'
import type { DrawnItem } from './build.js'
import type { ReplayConfig } from './config.js'
import type { FinalLabel } from './final-labels.js'
import type { ScoreRow } from './score.js'

export type Interval = [number, number]

export interface BreakdownRow {
  items: number
  real: number
  noise: number
  real_rate: number
  auroc: number | null
}

// The evaluate stage's result (spec 10.7, 10.8): aggregate numbers only, never comment text
// (spec 10.9), so it can be summarized into replay/<name>.result.md.
export interface ReplayResult {
  replay: string
  evaluated_at: string
  question_pack: string
  provider: string
  snapshots: string[]
  verdict: 'pass' | 'fail' | 'refused'
  refusal: string | null
  pass_rule: ReplayConfig['pass_rule']
  items: number
  real: number
  noise: number
  auroc: number | null
  auroc_ci95: Interval | null
  best_threshold: number | null
  noise_collapsed: number | null
  noise_collapsed_ci95: Interval | null
  real_hidden: number | null
  real_hidden_ci95: Interval | null
  keep_at: number
  keep_precision: number | null
  keep_precision_ci95: Interval | null
  // The cut-offs a pass calibrates: collapse at the best threshold, keep at 0.70 or above it.
  calibrated_cutoffs: { collapse_below: number; keep_at: number } | null
  // Set when a pass wrote the calibrated cut-offs: what was written, and where.
  cutoffs_written?: string
  bootstrap: { resamples: number; seed: number }
  sweep: { threshold: number; noise_collapsed: number; real_hidden: number }[]
  calibration: {
    from: number
    to: number
    items: number
    mean_worth: number | null
    real_rate: number | null
  }[]
  by_bot: (BreakdownRow & { bot: string })[]
  by_repository: (BreakdownRow & { repository: string })[]
  by_category: (BreakdownRow & { category: string })[]
  by_severity: (BreakdownRow & { severity: string })[]
  by_snapshot: (BreakdownRow & { snapshot: string })[]
  duplicate_rate: number
  excluded_by_reason: Record<string, number>
  calls: number
  cost_usd: number
}

export const BOOTSTRAP_RESAMPLES = 2000

// Computes the metrics on the final labels, over items labelled real (positive) or noise,
// and applies the pre-registered pass rule to the measured values.
export function evaluateReplay(input: {
  replay: string
  config: ReplayConfig
  items: DrawnItem[]
  labels: FinalLabel[]
  scores: ScoreRow[]
  scoring: { question_pack: string; provider: string; calls: number; cost_usd: number }
  excludedByReason: Record<string, number>
  evaluatedAt: string
}): ReplayResult {
  const itemOf = new Map(input.items.map((item) => [item.id, item]))
  const labelOf = new Map(input.labels.map((entry) => [entry.id, entry.label]))
  const judgments: LabelledJudgment[] = input.scores.flatMap((row) => {
    const label = labelOf.get(row.id)
    const item = itemOf.get(row.id)
    if (!item || (label !== 'real' && label !== 'noise')) return []
    return [
      {
        id: row.id,
        probability: row.worth,
        positive: label === 'real',
        snapshot: row.snapshot,
        groups: {
          bot: item.bot,
          repository: item.repository,
          category: row.category,
          severity: severityWord(row.severity),
        },
      },
    ]
  })
  const rule = input.config.pass_rule
  const evaluation = evaluateJudgments(judgments, {
    passRule: {
      minAuroc: rule.min_auroc,
      minNegativesBelow: rule.min_noise_collapsed,
      maxPositivesBelow: rule.max_real_hidden,
    },
    acceptAt: BUILT_IN_CUTOFFS.keepAt,
    seed: input.config.seed,
    resamples: BOOTSTRAP_RESAMPLES,
  })
  const { threshold } = evaluation
  const band =
    evaluation.verdict === 'pass' && threshold
      ? calibratedBand({
          threshold: threshold.threshold,
          defaults: { lower: BUILT_IN_CUTOFFS.collapseBelow, upper: BUILT_IN_CUTOFFS.keepAt },
        })
      : null
  const rows = (key: string) => (evaluation.groups[key] ?? []).map(breakdownRow)
  return {
    replay: input.replay,
    evaluated_at: input.evaluatedAt,
    question_pack: input.scoring.question_pack,
    provider: input.scoring.provider,
    snapshots: evaluation.snapshots,
    verdict: evaluation.verdict,
    refusal:
      evaluation.refusal === 'mixed snapshots'
        ? `scored on ${evaluation.snapshots.length} snapshots; re-score on one before the pass rule applies`
        : evaluation.refusal === 'one class'
          ? 'needs both real and noise items'
          : null,
    pass_rule: rule,
    items: evaluation.counts.items,
    real: evaluation.counts.positives,
    noise: evaluation.counts.negatives,
    auroc: evaluation.auroc,
    auroc_ci95: interval(evaluation.ranges.auroc),
    best_threshold: threshold?.threshold ?? null,
    noise_collapsed: threshold?.negativesBelow ?? null,
    noise_collapsed_ci95: interval(evaluation.ranges.negativesBelow),
    real_hidden: threshold?.positivesBelow ?? null,
    real_hidden_ci95: interval(evaluation.ranges.positivesBelow),
    keep_at: BUILT_IN_CUTOFFS.keepAt,
    keep_precision: evaluation.acceptPrecision,
    keep_precision_ci95: interval(evaluation.ranges.acceptPrecision),
    calibrated_cutoffs: band && { collapse_below: band.lower, keep_at: band.upper },
    bootstrap: { resamples: BOOTSTRAP_RESAMPLES, seed: input.config.seed },
    sweep: evaluation.sweep.map((row) => ({
      threshold: row.threshold,
      noise_collapsed: row.negativesBelow,
      real_hidden: row.positivesBelow,
    })),
    calibration: evaluation.calibration.map((bin) => ({
      from: bin.from,
      to: bin.to,
      items: bin.count,
      mean_worth: bin.meanProbability,
      real_rate: bin.positiveRate,
    })),
    by_bot: rows('bot').map(({ value, ...row }) => ({ bot: value, ...row })),
    by_repository: rows('repository').map(({ value, ...row }) => ({ repository: value, ...row })),
    by_category: rows('category').map(({ value, ...row }) => ({ category: value, ...row })),
    by_severity: rows('severity').map(({ value, ...row }) => ({ severity: value, ...row })),
    by_snapshot: rows('snapshot').map(({ value, ...row }) => ({ snapshot: value, ...row })),
    duplicate_rate:
      input.scores.length === 0
        ? 0
        : input.scores.filter((row) => row.dup_of !== null).length / input.scores.length,
    excluded_by_reason: input.excludedByReason,
    calls: input.scoring.calls,
    cost_usd: input.scoring.cost_usd,
  }
}

function breakdownRow(row: GroupRow): BreakdownRow & { value: string } {
  return {
    value: row.value,
    items: row.items,
    real: row.positives,
    noise: row.negatives,
    real_rate: row.positiveRate,
    auroc: row.auroc,
  }
}

function interval(range: Range | null): Interval | null {
  return range === null ? null : [range.low, range.high]
}
