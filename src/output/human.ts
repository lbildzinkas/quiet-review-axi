import type { Decision } from '../core/verdict.js'
import { preview, section, type ScoreView } from './render.js'

// Readable summary for people (spec 4.4): words first, never a probability as a percentage.
export function renderHuman(view: ScoreView): string {
  const byId = new Map(view.decisions.map((decision) => [decision.item.id, decision]))
  const isShown = (decision: Decision) => decision.verdict !== 'collapse'
  // A duplicate is folded under the earlier item when that item is shown.
  const isFolded = (decision: Decision) => {
    const target = decision.dupOf === null ? undefined : byId.get(decision.dupOf)
    return target !== undefined && isShown(target)
  }
  const keep = section(view.decisions, 'keep').filter((decision) => !isFolded(decision))
  const unsure = section(view.decisions, 'unsure').filter((decision) => !isFolded(decision))
  const collapsed = view.decisions.filter((decision) => decision.verdict === 'collapse')
  const rows = [...keep, ...unsure]
  const locationWidth = Math.max(0, ...rows.map((decision) => location(decision).length)) + 3
  const labelWidth = Math.max(0, ...rows.map((decision) => label(decision).length)) + 3
  const row = (decision: Decision) =>
    `  ${location(decision).padEnd(locationWidth)}${label(decision).padEnd(labelWidth)}${decision.item.author ?? ''}`.trimEnd()
  const foldedUnder = (decision: Decision) =>
    view.decisions
      .filter((candidate) => candidate.dupOf === decision.item.id && isFolded(candidate))
      .map(
        (duplicate) =>
          `    Also raised by ${duplicate.item.author ?? 'someone'} at ${location(duplicate)} (${duplicate.verdict === 'collapse' ? 'collapsed' : duplicate.verdict})`,
      )

  const lines = [
    [view.source.label, view.source.title].filter(Boolean).join('  '),
    `${view.decisions.length} ${view.source.kind === 'pr' ? 'review comments' : 'findings'}: ${keep.length + folded(view, 'keep', isFolded)} worth acting on, ${unsure.length + folded(view, 'unsure', isFolded)} unsure, ${collapsed.length} collapsed`,
    `Cut-offs: ${view.cutoffs.sentence}. Scored by ${view.snapshots.join(', ')} in ${view.calls} ${view.calls === 1 ? 'call' : 'calls'} (${costText(view)}).`,
    ...view.cutoffs.warnings.map((warning) => `Warning: ${warning}`),
    ...(view.notice === null ? [] : [`Notice: ${view.notice}.`]),
  ]
  if (keep.length > 0) {
    lines.push('', 'KEEP')
    for (const decision of keep)
      lines.push(
        row(decision),
        `    ${view.showFull ? decision.item.body : preview(decision.item.body)}`,
        ...foldedUnder(decision),
      )
  }
  if (unsure.length > 0) {
    lines.push('', 'UNSURE (shown, not collapsed)')
    for (const decision of unsure) lines.push(row(decision), ...foldedUnder(decision))
  }
  if (collapsed.length > 0)
    lines.push('', `COLLAPSED (${collapsed.length}): ${collapsedSummary(collapsed)}`)
  return lines.join('\n')
}

function folded(
  view: ScoreView,
  verdict: string,
  isFolded: (decision: Decision) => boolean,
): number {
  return view.decisions.filter((decision) => decision.verdict === verdict && isFolded(decision))
    .length
}

function location(decision: Decision): string {
  const { path, line } = decision.item
  if (path === null) return decision.item.id
  return line === null ? path : `${path}:${line}`
}

function label(decision: Decision): string {
  const category = decision.isCategoryConfident ? categoryWord(decision.category) : null
  if (decision.verdict !== 'keep') return category ?? ''
  return [category, severityWord(decision.severity)].filter(Boolean).join(', ')
}

// Severity words from the Score expectation (spec 4.4).
export function severityWord(score: number): string {
  if (score < 0.5) return 'none'
  if (score < 1.5) return 'cosmetic'
  if (score < 2.5) return 'minor'
  if (score < 3.5) return 'moderate'
  return 'severe'
}

function categoryWord(category: string): string {
  if (category === 'wrong') return 'wrong claim'
  return category.replaceAll('_', ' ')
}

function collapsedSummary(collapsed: Decision[]): string {
  const counts = new Map<string, number>()
  let duplicates = 0
  for (const decision of collapsed) {
    if (decision.dupOf !== null) duplicates++
    else {
      const word = decision.isCategoryConfident ? categoryWord(decision.category) : 'unclear'
      counts.set(word, (counts.get(word) ?? 0) + 1)
    }
  }
  const parts = [...counts.entries()]
    .sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : a > b ? 1 : 0))
    .map(([word, count]) => `${count} ${word}`)
  if (duplicates > 0) parts.push(`${duplicates} ${duplicates === 1 ? 'duplicate' : 'duplicates'}`)
  return parts.join(', ')
}

function costText(view: ScoreView): string {
  if (view.isCached) return 'cached, $0'
  if (view.costUsd > 0 && view.costUsd < 0.0001) return '<$0.0001'
  return `$${view.costUsd.toFixed(4)}`
}
