import {
  calibratedBand,
  evaluateJudgments,
  type Evaluation,
  type EvaluationOptions,
  type GroupRow,
  type LabelledJudgment,
  type Range,
} from '../calibration/index.js'
import { BUILT_IN_CUTOFFS } from '../core/cutoffs.js'
import { severityWord } from '../output/human.js'
import type { DrawnItem } from './build.js'
import type { TrustVerdict } from './check.js'
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

// The accuracy metrics with their 95% ranges, as measured on one set of labelled items.
export interface HeadlineMetrics {
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
  keep_precision: number | null
  keep_precision_ci95: Interval | null
}

// The evaluate stage's result (spec 10.7, 10.8): aggregate numbers only, never comment text
// (spec 10.9), so it can be summarized into replay/<name>.result.md.
export interface ReplayResult extends HeadlineMetrics {
  replay: string
  evaluated_at: string
  question_pack: string
  provider: string
  snapshots: string[]
  verdict: 'pass' | 'fail' | 'refused' | 'inconclusive'
  refusal: string | null
  // The label check's trust verdict and, when inconclusive, why (spec 10.6); null when the
  // replay has no check stage. Absent from results evaluated before evaluate read it.
  trust?: TrustVerdict | null
  trust_reasons?: string[]
  pass_rule: ReplayConfig['pass_rule']
  keep_at: number
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
  // The same metrics on the label-check sample alone, as a robustness check that never changes
  // the verdict; null until the label check's review is complete. Absent from results
  // evaluated before it was computed.
  label_check_sample?: HeadlineMetrics | null
  calls: number
  cost_usd: number
}

// The label check's trust gate (spec 10.6 step 6), as its stage record keeps it.
export interface LabelTrust {
  verdict: TrustVerdict
  reasons: string[]
  // Items of the check's sample still waiting for the maintainer's label.
  awaiting_review: number
}

export const BOOTSTRAP_RESAMPLES = 2000

// Computes the metrics on the final labels, over items labelled real (positive) or noise,
// and applies the pre-registered pass rule to the measured values.
export function evaluateReplay(input: {
  replay: string
  config: ReplayConfig
  items: DrawnItem[]
  labels: FinalLabel[]
  // The label-check sample's ids once its review is complete, else null.
  sampled: string[] | null
  // The check stage's trust gate, or null when the replay has no check stage.
  trust: LabelTrust | null
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
  const options: EvaluationOptions = {
    passRule: {
      minAuroc: rule.min_auroc,
      minNegativesBelow: rule.min_noise_collapsed,
      maxPositivesBelow: rule.max_real_hidden,
    },
    acceptAt: BUILT_IN_CUTOFFS.keepAt,
    seed: input.config.seed,
    resamples: BOOTSTRAP_RESAMPLES,
  }
  const evaluation = evaluateJudgments(judgments, options)
  const sampled = input.sampled === null ? null : new Set(input.sampled)
  const { threshold } = evaluation
  const { verdict, refusal } = trustedVerdict(evaluation, input.trust)
  const band =
    verdict === 'pass' && threshold
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
    verdict,
    refusal,
    trust: input.trust?.verdict ?? null,
    trust_reasons: input.trust?.reasons ?? [],
    pass_rule: rule,
    ...headlineMetrics(evaluation),
    keep_at: BUILT_IN_CUTOFFS.keepAt,
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
    label_check_sample:
      sampled &&
      headlineMetrics(
        evaluateJudgments(
          judgments.filter((judgment) => sampled.has(judgment.id)),
          options,
        ),
      ),
    calls: input.scoring.calls,
    cost_usd: input.scoring.cost_usd,
  }
}

// The trust gate (spec 10.6 step 6) turns a pass or a fail into inconclusive when the label
// check found the automatic labels unreliable, and refuses the pass rule while the review is
// unfinished. A refusal of the pass rule itself stands.
function trustedVerdict(
  evaluation: Evaluation,
  trust: LabelTrust | null,
): { verdict: ReplayResult['verdict']; refusal: string | null } {
  if (evaluation.refusal === 'mixed snapshots')
    return {
      verdict: 'refused',
      refusal: `scored on ${evaluation.snapshots.length} snapshots; re-score on one before the pass rule applies`,
    }
  if (evaluation.refusal === 'one class')
    return { verdict: 'refused', refusal: 'needs both real and noise items' }
  if (trust?.verdict === 'inconclusive') return { verdict: 'inconclusive', refusal: null }
  if (trust?.verdict === 'pending review')
    return {
      verdict: 'refused',
      refusal: `${trust.awaiting_review} label-check ${trust.awaiting_review === 1 ? 'item awaits' : 'items await'} review; label them in review.jsonl before the pass rule applies`,
    }
  return { verdict: evaluation.verdict, refusal: null }
}

function headlineMetrics(evaluation: Evaluation): HeadlineMetrics {
  const { threshold } = evaluation
  return {
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
    keep_precision: evaluation.acceptPrecision,
    keep_precision_ci95: interval(evaluation.ranges.acceptPrecision),
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
