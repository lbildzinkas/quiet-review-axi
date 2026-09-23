import { encode } from '@toon-format/toon'
import type { CutoffDescription } from '../core/cutoffs.js'
import type { Decision, Verdict } from '../core/verdict.js'
import type { OutputMode } from '../commands/score-args.js'
import { JEV_PRICE_PER_INPUT_TOKEN } from '../jev/provider.js'
import type { Answer } from '../jev/schema.js'
import { renderHuman } from './human.js'

export interface ScoreView {
  mode: OutputMode
  showAll: boolean
  showFull: boolean
  source: {
    kind: 'pr' | 'findings'
    label: string
    title: string | null
    command: string
    // Input warnings, such as ignored unknown fields in a findings file.
    warnings: string[]
  }
  cutoffs: CutoffDescription
  provider: string
  snapshots: string[]
  calls: number
  costUsd: number
  isCached: boolean
  decisions: Decision[]
  answers: Record<string, Answer>
  // The private-data notice (spec 8.3), when this run sent or served such data.
  notice: string | null
  // Ids of items left unscored because the run stopped at --max-cost (spec 9.4).
  unscored: string[]
  stop: { maxCost: number } | null
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
  Object.assign(header, {
    verdicts: verdictCounts(view.decisions),
    cutoffs: view.cutoffs.line,
    provider: view.provider,
    model: view.snapshots.length > 0 ? view.snapshots.join(', ') : 'none',
    calls: view.calls,
    cost_usd: roundCost(view.costUsd),
    cached: view.isCached,
  })
  if (view.notice !== null) header.notice = view.notice
  if (view.stop)
    Object.assign(header, { stopped: 'max-cost', code: 'BUDGET_STOP', unscored: view.unscored })
  const warnings = [...view.source.warnings, ...view.cutoffs.warnings]
  if (warnings.length > 0) header.warnings = warnings
  const withoutCode = view.decisions.filter((decision) => decision.item.context === 'none')
  if (withoutCode.length > 0)
    header.no_code_context = withoutCode.map((decision) => decision.item.id)
  return header
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

// Actionable first (spec 4.4, D2): keep and unsure rows with text, collapsed items as ids.
// --all prints one table of every item, each duplicate directly after the row it repeats.
function renderCompact(view: ScoreView): string {
  const body = headerFields(view)
  const keep = section(view.decisions, 'keep')
  const unsure = section(view.decisions, 'unsure')
  const collapse = view.decisions.filter((decision) => decision.verdict === 'collapse')
  if (view.showAll) {
    body.items = groupDuplicates([...keep, ...unsure, ...collapse]).map((decision) =>
      allRow(decision, view.showFull),
    )
  } else {
    body.keep = groupDuplicates(keep).map((decision) => fullRow(decision, view.showFull))
    body.unsure = groupDuplicates(unsure).map((decision) => fullRow(decision, view.showFull))
    body.collapse = collapse.map(idRow)
  }
  return joinBlocks(encode(body), renderHelp(helpLines(view, collapse.length)))
}

// Moves each duplicate directly after the row it duplicates, when that row is in the list.
function groupDuplicates(rows: Decision[]): Decision[] {
  const ids = new Set(rows.map((decision) => decision.item.id))
  const isRoot = (decision: Decision) => decision.dupOf === null || !ids.has(decision.dupOf)
  const ordered: Decision[] = []
  const visit = (decision: Decision) => {
    ordered.push(decision)
    for (const child of rows) if (child.dupOf === decision.item.id && !isRoot(child)) visit(child)
  }
  for (const decision of rows) if (isRoot(decision)) visit(decision)
  return ordered
}

function helpLines(view: ScoreView, collapsed: number): string[] {
  const lines: string[] = []
  if (view.stop)
    lines.push(
      `Run \`${BIN} ${view.source.command} --max-cost ${resumeLimit(view.stop.maxCost)}\` to resume; results already paid for are cached and cost nothing`,
    )
  lines.push(...view.cutoffs.help)
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

function allRow(decision: Decision, showFull: boolean) {
  const row = fullRow(decision, showFull)
  return {
    id: row.id,
    verdict: decision.verdict,
    worth: row.worth,
    category: row.category,
    severity: row.severity,
    dup_of: decision.dupOf ?? 'none',
    author: row.author,
    path: row.path,
    line: row.line,
    text: row.text,
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

function resumeLimit(maxCost: number): string {
  return String(Math.max(0.5, maxCost * 2))
}

export interface DryRunView {
  mode: OutputMode
  source: ScoreView['source']
  provider: { name: string; model: string }
  cutoffs: CutoffDescription
  notice: string | null
  items: number
  requests: {
    body: Record<string, unknown>
    items: number
    estimatedTokens: number
    isCached: boolean
  }[]
}

// --dry-run (spec 4.1): the requests that would be sent, with token and cost estimates.
export function renderDryRun(view: DryRunView): string {
  const estimatedTokens = view.requests.reduce(
    (total, request) => total + request.estimatedTokens,
    0,
  )
  const paidTokens = view.requests
    .filter((request) => !request.isCached)
    .reduce((total, request) => total + request.estimatedTokens, 0)
  const header: Record<string, unknown> = {
    [view.source.kind === 'pr' ? 'pr' : 'source']: view.source.label,
  }
  if (view.source.title !== null) header.title = view.source.title
  Object.assign(header, {
    dry_run: true,
    provider: view.provider.name,
    model: view.provider.model,
    cutoffs: view.cutoffs.line,
    items: view.items,
    calls: view.requests.length,
    estimated_input_tokens: estimatedTokens,
    estimated_cost_usd: roundCost(estimateCost(paidTokens)),
  })
  if (view.notice !== null) header.notice = view.notice
  const help = [`Run \`${BIN} ${view.source.command}\` to send the requests`]
  const rows = view.requests.map((request, index) => ({
    call: index + 1,
    items: request.items,
    estimated_tokens: request.estimatedTokens,
    cached: request.isCached,
  }))
  if (view.mode === 'json')
    return JSON.stringify(
      {
        ...header,
        requests: rows.map((row, index) => ({ ...row, body: view.requests[index]?.body })),
        help,
      },
      null,
      2,
    )
  if (view.mode === 'human')
    return [
      [view.source.label, view.source.title].filter(Boolean).join('  '),
      `Dry run: ${view.items} items in ${view.requests.length} ${view.requests.length === 1 ? 'call' : 'calls'} to ${view.provider.model} on ${view.provider.name}, about ${estimatedTokens} input tokens ($${estimateCost(paidTokens).toFixed(4)}). Nothing was sent.`,
    ].join('\n')
  return joinBlocks(encode({ ...header, requests: rows }), renderHelp(help))
}

function estimateCost(tokens: number): number {
  return tokens * JEV_PRICE_PER_INPUT_TOKEN
}
