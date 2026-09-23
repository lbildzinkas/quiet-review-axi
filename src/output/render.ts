import { encode } from '@toon-format/toon'
import type { Decision } from '../core/verdict.js'

export interface ScoreReport {
  header: Record<string, unknown>
  decisions: Decision[]
  help: string[]
}

export function renderHelp(lines: string[]): string {
  if (lines.length === 0) return ''
  return `help[${lines.length}]:\n${lines.map((line) => `  ${line}`).join('\n')}`
}

export function joinBlocks(...blocks: string[]): string {
  return blocks.filter((block) => block.length > 0).join('\n')
}

export function renderCompact(report: ScoreReport): string {
  const counts = { keep: 0, unsure: 0, collapse: 0 }
  for (const decision of report.decisions) counts[decision.verdict]++
  const body: Record<string, unknown> = {
    ...report.header,
    verdicts: `keep ${counts.keep}, unsure ${counts.unsure}, collapse ${counts.collapse}`,
  }
  const shown = report.decisions.filter((decision) => decision.verdict !== 'collapse')
  body.keep = shown.filter((decision) => decision.verdict === 'keep').map(fullRow)
  return joinBlocks(encode(body), renderHelp(report.help))
}

function fullRow(decision: Decision) {
  return {
    id: decision.item.id,
    worth: round(decision.worth, 2),
    category: decision.category,
    severity: round(decision.severity, 1),
    author: decision.item.author,
    path: decision.item.path,
    line: decision.item.line,
    text: decision.item.body,
  }
}

function round(value: number, digits: number) {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
