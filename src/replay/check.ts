import type { DrawnItem } from './build.js'
import type { Label } from './label.js'
import {
  agreementOf,
  drawCheckSample,
  reviewLine,
  toReviewJsonl,
  type AiLabel,
  type LabelledItem,
} from './label-check.js'
import { runLabelModel, type LabelModelOptions } from './label-model.js'
import { fromJsonl, readOptional, toJsonl, writeAtomic, type StageRecord } from './store.js'

// The check stage (spec 10.6): AI labels on a sample, then the maintainer's review of the
// disagreements, read back from review.jsonl on every run until it is complete.

export interface CheckFiles {
  check: string
  review: string
}

// One sampled item with its automatic and AI labels, as stored in check.jsonl.
export interface CheckRow {
  id: string
  automatic_label: Label
  ai_label: AiLabel
  ai_reason: string
  model: string
  cost_usd: number
}

export interface CheckOptions {
  files: CheckFiles
  items: DrawnItem[]
  labels: Map<string, Label>
  // Whether the sample must be (re)labelled: false when check.jsonl matches the inputs.
  needsModel: boolean
  model: Omit<LabelModelOptions, 'sample'>
}

export async function runCheck(options: CheckOptions): Promise<Omit<StageRecord, 'input_hash'>> {
  const rows = options.needsModel ? await labelSample(options) : await readRows(options.files)
  const agreement = agreementOf(
    rows.map((row) => ({ automatic: row.automatic_label, ai: row.ai_label })),
  )
  const toReview = rows.filter((row) => row.ai_label !== row.automatic_label)
  const summary = `${rows.length} sampled, AI agreement ${formatRate(agreement.agreement)} (kappa ${formatRate(agreement.kappa)})`
  if (toReview.length > 0)
    return {
      status: 'waiting',
      detail: `${summary}, ${toReview.length} await review`,
      completed_at: options.model.now().toISOString(),
    }
  return {
    detail: `${summary}, 0 reviewed, 0 automatic labels corrected`,
    completed_at: options.model.now().toISOString(),
  }
}

async function labelSample(options: CheckOptions): Promise<CheckRow[]> {
  const labelled: LabelledItem[] = options.items.map((item) => ({
    item,
    label: options.labels.get(item.id) ?? 'excluded',
  }))
  const sample = drawCheckSample(labelled).sort((a, b) => compareText(a.item.id, b.item.id))
  const answers = new Map(
    (await runLabelModel({ ...options.model, sample })).map((answer) => [answer.id, answer]),
  )
  const rows: CheckRow[] = []
  const review = []
  for (const entry of sample) {
    const answer = answers.get(entry.item.id)
    if (!answer) throw new Error(`No label model answer for ${entry.item.id}`)
    rows.push({
      id: entry.item.id,
      automatic_label: entry.label,
      ai_label: answer.label,
      ai_reason: answer.reason,
      model: answer.model,
      cost_usd: answer.cost_usd,
    })
    if (answer.label !== entry.label) review.push(reviewLine(entry, answer))
  }
  await writeAtomic(options.files.check, toJsonl(rows))
  await writeAtomic(options.files.review, toReviewJsonl(review))
  return rows
}

async function readRows(files: CheckFiles): Promise<CheckRow[]> {
  return fromJsonl<CheckRow>((await readOptional(files.check)) ?? '')
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : String(Math.round(value * 100) / 100)
}

function compareText(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}
