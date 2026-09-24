import { validationError } from '../errors.js'
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
  finalLabels: string
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
  const maintainer = await readReview(options, toReview)
  const pending = toReview.filter((row) => maintainer.get(row.id) === undefined)
  const corrected = toReview.filter((row) => {
    const label = maintainer.get(row.id)
    return label !== undefined && label !== row.automatic_label
  })
  const summary = `${rows.length} sampled, AI agreement ${formatRate(agreement.agreement)} (kappa ${formatRate(agreement.kappa)})`
  const completedAt = options.model.now().toISOString()
  if (pending.length > 0)
    return {
      status: 'waiting',
      detail: `${summary}, ${pending.length} await review`,
      completed_at: completedAt,
    }
  await writeAtomic(
    options.files.finalLabels,
    toJsonl(finalLabels(options.labels, rows, maintainer)),
  )
  const reviewed = toReview.length
  return {
    detail: `${summary}, ${reviewed} reviewed, ${corrected.length} automatic ${corrected.length === 1 ? 'label' : 'labels'} corrected`,
    completed_at: completedAt,
  }
}

// Final labels (spec 10.6 step 5): the maintainer's label for a reviewed item, the agreed
// label for the rest of the sample, and the automatic label for every unsampled item.
function finalLabels(
  labels: Map<string, Label>,
  rows: CheckRow[],
  maintainer: Map<string, Label>,
): { id: string; label: Label; source: 'maintainer' | 'agreed' | 'automatic' }[] {
  const sampled = new Set(rows.map((row) => row.id))
  return [...labels.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([id, label]) => {
      const reviewed = maintainer.get(id)
      if (reviewed !== undefined) return { id, label: reviewed, source: 'maintainer' as const }
      return { id, label, source: sampled.has(id) ? ('agreed' as const) : ('automatic' as const) }
    })
}

const REVIEW_LABELS = new Set<unknown>(['real', 'noise', 'excluded'])

// Reads the maintainer's labels back from review.jsonl. A missing file is rewritten from
// check.jsonl; a line that names an unknown item or an unknown label is a validation error.
async function readReview(
  options: CheckOptions,
  toReview: CheckRow[],
): Promise<Map<string, Label>> {
  const labels = new Map<string, Label>()
  if (toReview.length === 0) return labels
  const text = await readOptional(options.files.review)
  if (text === null) {
    await writeReview(options, toReview)
    return labels
  }
  const expected = new Set(toReview.map((row) => row.id))
  const seen = new Set<string>()
  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '') return
    const where = `${REVIEW_FILE} line ${index + 1}`
    let line: { id?: unknown; label?: unknown }
    try {
      line = JSON.parse(raw) as { id?: unknown; label?: unknown }
    } catch {
      throw validationError(`${where} is not valid JSON`, REVIEW_HELP)
    }
    if (typeof line.id !== 'string' || !expected.has(line.id))
      throw validationError(`${where} names an item that is not awaiting review`, REVIEW_HELP)
    if (seen.has(line.id)) throw validationError(`${where} repeats ${line.id}`, REVIEW_HELP)
    seen.add(line.id)
    if (line.label === null || line.label === undefined) return
    if (!REVIEW_LABELS.has(line.label))
      throw validationError(
        `${where}: label must be real, noise, excluded or null, not ${JSON.stringify(line.label)}`,
        REVIEW_HELP,
      )
    labels.set(line.id, line.label as Label)
  })
  const missing = [...expected].find((id) => !seen.has(id))
  if (missing !== undefined)
    throw validationError(`${REVIEW_FILE} has no line for ${missing}`, REVIEW_HELP)
  return labels
}

const REVIEW_FILE = 'review.jsonl'
const REVIEW_HELP = [
  'Set `label` to "real", "noise" or "excluded" on each line, and change nothing else',
  'Delete review.jsonl and run the check stage again to rewrite it without your labels',
]

async function writeReview(options: CheckOptions, rows: CheckRow[]): Promise<void> {
  const items = new Map(options.items.map((item) => [item.id, item]))
  const lines = rows.map((row) => {
    const item = items.get(row.id)
    if (!item) throw new Error(`No drawn item ${row.id}`)
    return reviewLine(
      { item, label: row.automatic_label },
      { label: row.ai_label, reason: row.ai_reason },
    )
  })
  await writeAtomic(options.files.review, toReviewJsonl(lines))
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
  }
  await writeAtomic(options.files.check, toJsonl(rows))
  await writeReview(
    options,
    rows.filter((row) => row.ai_label !== row.automatic_label),
  )
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
