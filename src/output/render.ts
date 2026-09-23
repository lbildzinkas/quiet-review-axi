import { encode } from '@toon-format/toon'
import type { CutoffDescription } from '../core/cutoffs.js'
import type { Decision, Verdict } from '../core/verdict.js'
import type { OutputMode } from '../commands/score-args.js'
import type { Answer } from '../jev/schema.js'
import { renderHuman } from './human.js'

export interface ScoreView {
  mode: OutputMode
  showAll: boolean
  showFull: boolean
  source: { kind: 'pr' | 'findings'; label: string; title: string | null; command: string }
  cutoffs: CutoffDescription
  provider: string
  snapshots: string[]
  calls: number
  costUsd: number
  isCached: boolean
  decisions: Decision[]
  answers: Record<string, Answer>
  run: RunFacts
}

export interface RunFacts {
  provider: string
  model_requested: string
  model_returned: string[]
  request_ids: (string | null)[]
  cache_keys: string[]
  cached: boolean
  question_pack: string
  questions: number
  input_tokens: number
  cost_usd: number
  retries: number
}

const BIN = 'quiet-review-axi'
const TEXT_PREVIEW_CHARACTERS = 120

export function renderHelp(lines: string[]): string {
  if (lines.length === 0) return ''
  return `help[${lines.length}]:\n${lines.map((line) => `  ${line}`).join('\n')}`
}

export function joinBlocks(...blocks: string[]): string {
  return blocks.filter((block) => block.length > 0).join('\n')
}

export function renderScore(view: ScoreView): string {
  if (view.mode === 'json') return renderJson(view)
  if (view.mode === 'human') return renderHuman(view)
  return renderCompact(view)
}

function headerFields(view: ScoreView): Record<string, unknown> {
  const header: Record<string, unknown> = {
    [view.source.kind === 'pr' ? 'pr' : 'source']: view.source.label,
  }
  if (view.source.title !== null) header.title = view.source.title
  return Object.assign(header, {
    verdicts: verdictCounts(view.decisions),
    cutoffs: view.cutoffs.line,
    provider: view.provider,
    model: view.snapshots.join(', '),
    calls: view.calls,
    cost_usd: roundCost(view.costUsd),
    cached: view.isCached,
  })
}

// One JSON document; field names match the TOON output (spec 4.4).
function renderJson(view: ScoreView): string {
  const document = {
    ...headerFields(view),
    run: view.run,
    items: view.decisions.map((decision) => jsonItem(decision, view.answers)),
    help: helpLines(view, 0).filter((line) => !line.includes('--json')),
  }
  return JSON.stringify(document, null, 2)
}

function jsonItem(decision: Decision, answers: Record<string, Answer>) {
  const { item } = decision
  const raw: Record<string, Answer> = {}
  for (const kind of ['act', 'cat', 'sev', 'dup']) {
    const answer = answers[`${item.key}_${kind}`]
    if (answer) raw[kind] = answer
  }
  return {
    id: item.id,
    verdict: decision.verdict,
    worth: decision.worth,
    category: decision.category,
    category_confident: decision.isCategoryConfident,
    severity: decision.severity,
    dup_of: decision.dupOf,
    author: item.author,
    path: item.path,
    line: item.line,
    url: item.url,
    context: item.context,
    text: item.body,
    answers: raw,
  }
}

function renderCompact(view: ScoreView): string {
  const body = headerFields(view)
  const keep = section(view.decisions, 'keep')
  const unsure = section(view.decisions, 'unsure')
  const collapse = view.decisions.filter((decision) => decision.verdict === 'collapse')
  body.keep = keep.map((decision) => fullRow(decision, view.showFull))
  body.unsure = unsure.map((decision) => fullRow(decision, view.showFull))
  body.collapse = collapse.map(idRow)
  return joinBlocks(encode(body), renderHelp(helpLines(view, collapse.length)))
}

function helpLines(view: ScoreView, collapsed: number): string[] {
  const lines: string[] = []
  if (collapsed > 0 && !view.showAll)
    lines.push(`Run \`${BIN} ${view.source.command} --all\` to see the collapsed comments' text`)
  lines.push(`Run \`${BIN} ${view.source.command} --json\` for raw answers and run facts`)
  return lines
}

export function verdictCounts(decisions: Decision[]): string {
  const counts = { keep: 0, unsure: 0, collapse: 0 }
  for (const decision of decisions) counts[decision.verdict]++
  return `keep ${counts.keep}, unsure ${counts.unsure}, collapse ${counts.collapse}`
}

// Keep and unsure rows sort by severity, then worth, descending, then item order (spec 4.4).
export function section(decisions: Decision[], verdict: Verdict): Decision[] {
  const order = new Map(decisions.map((decision, index) => [decision, index]))
  return decisions
    .filter((decision) => decision.verdict === verdict)
    .sort(
      (a, b) =>
        b.severity - a.severity || b.worth - a.worth || (order.get(a) ?? 0) - (order.get(b) ?? 0),
    )
}

function fullRow(decision: Decision, showFull: boolean) {
  return {
    id: decision.item.id,
    worth: round(decision.worth, 2),
    category: categoryLabel(decision),
    severity: round(decision.severity, 1),
    author: decision.item.author,
    path: decision.item.path,
    line: decision.item.line,
    text: showFull ? decision.item.body : preview(decision.item.body),
  }
}

function idRow(decision: Decision) {
  return {
    id: decision.item.id,
    worth: round(decision.worth, 2),
    category: categoryLabel(decision),
    dup_of: decision.dupOf ?? 'none',
  }
}

function categoryLabel(decision: Decision): string {
  return decision.isCategoryConfident ? decision.category : `${decision.category}?`
}

export function preview(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length > TEXT_PREVIEW_CHARACTERS ? `${flat.slice(0, TEXT_PREVIEW_CHARACTERS)}…` : flat
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function roundCost(value: number): number {
  return Number(value.toFixed(6))
}
