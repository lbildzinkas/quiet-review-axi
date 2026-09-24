import { cleanBody } from '../core/items.js'
import type { DrawnItem } from './build.js'
import type { Label } from './label.js'
import prompt from './label-prompt.json' with { type: 'json' }

// The label check (spec 10.6): an independent AI label on a sample of the automatic labels.

export const LABEL_PROMPT_VERSION: string = prompt.version

export type AiLabel = 'real' | 'noise' | 'unsure'

export interface LabelledItem {
  item: DrawnItem
  label: Label
}

export function drawCheckSample(labelled: LabelledItem[]): LabelledItem[] {
  return labelled.filter((entry) => entry.label !== 'excluded')
}

// Lines of context around the commented range when picking the later diff's hunks to show.
const CHANGE_CONTEXT_LINES = 10
const MAX_CHANGE_CHARACTERS = 4000
const MAX_REPLY_CHARACTERS = 1000
const MAX_REPLIES = 10

// What the label model and the maintainer see for one item (spec 10.6): the comment and its
// hunk at comment time, the file's later diff at the anchor, and the thread. It carries no
// label and no author login.
export function evidenceView(item: DrawnItem) {
  const { evidence } = item
  return {
    path: item.comment.path,
    lines: item.comment.lines,
    comment: cleanBody(item.comment.body),
    code: item.comment.diff_hunk,
    changes_after_comment: changesNearAnchor(item),
    resolved: evidence.resolved,
    replies: evidence.replies.slice(0, MAX_REPLIES).map((reply) => ({
      from: reply.is_bot ? 'bot' : 'person',
      text: reply.body.slice(0, MAX_REPLY_CHARACTERS),
    })),
  }
}

// The hunks of the file's diff from `from` to `to` that touch the commented lines, widened
// by a few lines, or a sentence saying why there are none.
function changesNearAnchor(item: DrawnItem): string {
  const { anchor, compare } = item.evidence
  const file = compare?.file ?? null
  if (file === null) return 'The file did not change between the comment and the merge.'
  if (file.patch === undefined) return 'GitHub returned no diff for this file.'
  if (anchor === null) return file.patch.slice(0, MAX_CHANGE_CHARACTERS)
  const low = anchor.start - CHANGE_CONTEXT_LINES
  const high = anchor.end + CHANGE_CONTEXT_LINES
  const near = splitHunks(file.patch).filter(({ start, length }) => {
    const end = start + Math.max(length, 1) - 1
    return start <= high && end >= low
  })
  if (near.length === 0)
    return `The file changed, but not within ${CHANGE_CONTEXT_LINES} lines of the commented lines.`
  return near
    .map((hunk) => hunk.text)
    .join('\n')
    .slice(0, MAX_CHANGE_CHARACTERS)
}

// Splits a unified diff into hunks with their old-side start line and length.
function splitHunks(patch: string): { start: number; length: number; text: string }[] {
  const hunks: { start: number; length: number; text: string }[] = []
  for (const line of patch.split('\n')) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/)
    if (header) {
      hunks.push({ start: Number(header[1]), length: Number(header[2] ?? 1), text: line })
      continue
    }
    const current = hunks[hunks.length - 1]
    if (current) current.text += `\n${line}`
  }
  return hunks
}

// The chat request for one item, built from the fixed template: the same item and model
// always give the same body (R17). The automatic label is never sent.
export function buildLabelRequest(item: DrawnItem, model: string): Record<string, unknown> {
  const evidence = evidenceView(item)
  return {
    model,
    messages: [
      { role: 'system', content: prompt.system.join('\n') },
      { role: 'user', content: `${prompt.user}\n${JSON.stringify(evidence, null, 2)}` },
    ],
    temperature: prompt.temperature,
    max_tokens: prompt.max_tokens,
  }
}

export interface ParsedAnswer {
  label: AiLabel
  reason: string
}

export function parseLabelAnswer(content: string): ParsedAnswer {
  const parsed = JSON.parse(content) as { label: AiLabel; reason: string }
  return { label: parsed.label, reason: parsed.reason }
}

export interface Agreement {
  // Items where the AI gave real or noise.
  compared: number
  agreement: number | null
  kappa: number | null
}

// Raw agreement and Cohen's kappa between the automatic and the AI labels, over items where
// the AI did not answer `unsure`.
export function agreementOf(pairs: { automatic: Label; ai: AiLabel }[]): Agreement {
  const compared = pairs.filter((pair) => pair.ai !== 'unsure')
  const n = compared.length
  if (n === 0) return { compared: 0, agreement: null, kappa: null }
  const agreed = compared.filter((pair) => pair.ai === pair.automatic).length
  const observed = agreed / n
  const share = (side: 'automatic' | 'ai', label: string) =>
    compared.filter((pair) => pair[side] === label).length / n
  const expected =
    share('automatic', 'real') * share('ai', 'real') +
    share('automatic', 'noise') * share('ai', 'noise')
  return {
    compared: n,
    agreement: observed,
    kappa: expected === 1 ? null : (observed - expected) / (1 - expected),
  }
}

// One line of review.jsonl: the maintainer sets `label` to real, noise or excluded.
export interface ReviewLine {
  id: string
  label: Label | null
  automatic_label: Label
  ai_label: AiLabel
  ai_reason: string
  comment_url: string
  pr_url: string
  compare_url: string
  [field: string]: unknown
}

export function reviewLine(entry: LabelledItem, answer: { label: AiLabel; reason: string }) {
  const { item } = entry
  const pullUrl = `https://github.com/${item.repository}/pull/${item.pr}`
  return {
    id: item.id,
    label: null,
    automatic_label: entry.label,
    ai_label: answer.label,
    ai_reason: answer.reason,
    comment_url: item.comment.url,
    pr_url: pullUrl,
    compare_url: `https://github.com/${item.repository}/compare/${item.evidence.from}...${item.evidence.to}`,
    repository: item.repository,
    pr: item.pr,
    bot: item.bot,
    ...evidenceView(item),
  } satisfies ReviewLine
}

// review.jsonl keeps a readable key order (id and label first), one line per item.
export function toReviewJsonl(lines: ReviewLine[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('')
}
