import type { Answer, ChoiceAnswer } from '../jev/schema.js'
import type { ResolvedCutoffs } from './cutoffs.js'
import type { Item } from './items.js'

export type Verdict = 'keep' | 'unsure' | 'collapse'

export interface Decision {
  item: Item
  verdict: Verdict
  worth: number
  category: string
  isCategoryConfident: boolean
  severity: number
  // Display id of the earlier item this one duplicates, or null.
  dupOf: string | null
}

// Choice answers below this top probability are uncertain (spec 6.3, 6.4; Jev guide 2.7).
export const CHOICE_FLOOR = 0.6

// Verdict rules (spec 6.1): only the worth-acting-on probability decides. Category,
// severity and duplicates label, sort and group; they never change a verdict.
export function decideItems(input: {
  items: Item[]
  // Item keys per Jev request, so duplicates across requests can be told apart.
  calls: string[][]
  answers: Record<string, Answer>
  cutoffs: ResolvedCutoffs
}): Decision[] {
  const { items, answers, cutoffs } = input
  const callOf = new Map(input.calls.flatMap((keys, index) => keys.map((key) => [key, index])))
  const idOf = new Map(items.map((item) => [item.key, item.id]))
  return items.map((item, index) => {
    const worth = noulValue(answers[`${item.key}_act`])
    const category = choiceOf(answers[`${item.key}_cat`])
    const sev = answers[`${item.key}_sev`]
    const dupKey =
      duplicateWithinCall(answers[`${item.key}_dup`]) ??
      duplicateAcrossCalls(items.slice(0, index), item, callOf)
    return {
      item,
      worth,
      verdict: verdictFor(worth, cutoffs),
      category: category.choice,
      isCategoryConfident: category.top >= CHOICE_FLOOR,
      severity: sev?.type === 'score' ? sev.score : 0,
      dupOf: dupKey === null ? null : (idOf.get(dupKey) ?? null),
    }
  })
}

export function verdictFor(worth: number, cutoffs: ResolvedCutoffs): Verdict {
  if (worth >= cutoffs.keepAt) return 'keep'
  if (worth >= cutoffs.collapseBelow) return 'unsure'
  return 'collapse'
}

function noulValue(answer: Answer | undefined): number {
  return answer?.type === 'noul' ? answer.noul : 0
}

// A Choice with no probabilities counts as top probability 0 (spec 5.5).
function choiceOf(answer: Answer | undefined): { choice: string; top: number } {
  if (answer?.type !== 'choice') return { choice: 'other', top: 0 }
  return { choice: answer.choice, top: topProbability(answer) }
}

function topProbability(answer: ChoiceAnswer): number {
  return answer.probabilities?.[answer.choice] ?? 0
}

function duplicateWithinCall(answer: Answer | undefined): string | null {
  if (answer?.type !== 'choice' || answer.choice === 'none') return null
  return topProbability(answer) >= CHOICE_FLOOR ? answer.choice : null
}

function duplicateAcrossCalls(
  earlier: Item[],
  item: Item,
  callOf: Map<string, number>,
): string | null {
  const text = normalizeText(item.body)
  const match = earlier.find(
    (candidate) =>
      callOf.get(candidate.key) !== callOf.get(item.key) && normalizeText(candidate.body) === text,
  )
  return match?.key ?? null
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}
