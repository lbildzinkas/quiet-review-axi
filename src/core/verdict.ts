import type { Answer } from '../jev/schema.js'
import type { ResolvedCutoffs } from './cutoffs.js'
import type { Item } from './items.js'

export type Verdict = 'keep' | 'unsure' | 'collapse'

export interface Decision {
  item: Item
  verdict: Verdict
  worth: number
  category: string
  severity: number
}

// Verdict rules (spec 6.1): only the worth-acting-on probability decides.
export function decideItems(input: {
  items: Item[]
  answers: Record<string, Answer>
  cutoffs: ResolvedCutoffs
}): Decision[] {
  return input.items.map((item) => {
    const act = input.answers[`${item.key}_act`]
    const cat = input.answers[`${item.key}_cat`]
    const sev = input.answers[`${item.key}_sev`]
    const worth = act?.type === 'noul' ? act.noul : 0
    return {
      item,
      worth,
      verdict: verdictFor(worth, input.cutoffs),
      category: cat?.type === 'choice' ? cat.choice : 'other',
      severity: sev?.type === 'score' ? sev.score : 0,
    }
  })
}

function verdictFor(worth: number, cutoffs: ResolvedCutoffs): Verdict {
  if (worth >= cutoffs.keepAt) return 'keep'
  if (worth >= cutoffs.collapseBelow) return 'unsure'
  return 'collapse'
}
