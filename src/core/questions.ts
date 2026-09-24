import pack from './question-pack.json' with { type: 'json' }

// The Jev question wording lives only in question-pack.json (spec 5.4). Code fills the
// placeholders with item keys; it never adds comment text to instructions.
export type Question = Record<string, unknown> & { type: 'noul' | 'choice' | 'score' }

export const QUESTION_PACK_VERSION: string = pack.version

export function itemQuestions(
  itemKey: string,
  duplicateCandidates: string[],
): Record<string, Question> {
  const fill = (value: unknown) => fillPlaceholders(value, { '{item}': itemKey })
  const questions: Record<string, Question> = {
    [`${itemKey}_act`]: fill(pack.questions.act) as Question,
    [`${itemKey}_cat`]: fill(pack.questions.cat) as Question,
    [`${itemKey}_sev`]: fill(pack.questions.sev) as Question,
  }
  if (duplicateCandidates.length === 0) return questions
  const { type, instructions, candidate, none } = pack.questions.dup
  const criteria: Record<string, string> = {}
  for (const key of duplicateCandidates) criteria[key] = candidate.replaceAll('{candidate}', key)
  criteria.none = none
  questions[`${itemKey}_dup`] = {
    type: type as 'choice',
    instructions: fill(instructions),
    criteria,
  }
  return questions
}

function fillPlaceholders(value: unknown, replacements: Record<string, string>): unknown {
  if (typeof value === 'string')
    return Object.entries(replacements).reduce(
      (text, [from, to]) => text.replaceAll(from, to),
      value,
    )
  if (Array.isArray(value)) return value.map((entry) => fillPlaceholders(entry, replacements))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, fillPlaceholders(entry, replacements)]),
  )
}
