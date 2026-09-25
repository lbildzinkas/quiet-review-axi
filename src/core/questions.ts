import { z } from 'zod'
import { validationError } from '../errors.js'
import builtInPack from './question-pack.json' with { type: 'json' }
import contextPack from './question-pack-context.json' with { type: 'json' }

// The Jev question wording lives only in question packs (spec 5.4.5): the built-in
// question-pack.json, or a candidate pack file checked by the regression gate. Code fills the
// placeholders with item keys; it never adds comment text to instructions.
export type Question = Record<string, unknown> & { type: 'noul' | 'choice' | 'score' }

const text = z.string().min(1)
const questionPackSchema = z.object({
  // Also names files (the gate's record), so it is a plain token such as v0.2.
  version: z.string().regex(/^[\w.-]+$/, 'must be letters, digits, dots, dashes or underscores'),
  placeholders: z.record(z.string(), z.string()).optional(),
  questions: z
    .object({
      act: z
        .object({
          type: z.literal('noul'),
          instructions: z.union([text, z.record(z.string(), text)]),
          criteria: z.object({ true: text, false: text }).strict(),
        })
        .strict(),
      cat: z
        .object({
          type: z.literal('choice'),
          instructions: text,
          criteria: z.record(
            z.string(),
            z.object({ what: text, not_for: text.optional() }).strict(),
          ),
        })
        .strict(),
      sev: z
        .object({ type: z.literal('score'), instructions: text, criteria: z.array(text).min(2) })
        .strict(),
      dup: z
        .object({ type: z.literal('choice'), instructions: text, candidate: text, none: text })
        .strict(),
    })
    .strict(),
})

export type QuestionPack = z.infer<typeof questionPackSchema>

export const BUILT_IN_PACK: QuestionPack = questionPackSchema.parse(builtInPack)
export const QUESTION_PACK_VERSION: string = BUILT_IN_PACK.version

// The pack the context ablation scores its variants with: the worth-acting-on question also
// points at the context blocks a variant adds to the state. `score` and the replay's own
// stages never use it.
export const CONTEXT_PACK: QuestionPack = questionPackSchema.parse(contextPack)

// Validates a candidate pack file's structure. Its wording is judged by the replay gate.
export function parseQuestionPack(raw: unknown, source: string): QuestionPack {
  const parsed = questionPackSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  throw validationError(
    `Invalid question pack ${source}: ${issue?.path.join('.') || '(root)'} ${issue?.message ?? ''}`.trim(),
  )
}

export function itemQuestions(
  itemKey: string,
  duplicateCandidates: string[],
  pack: QuestionPack = BUILT_IN_PACK,
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
    type,
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

// An instruction entry that is only a backticked state path points Jev at part of the state.
// When that part is absent, for example a context block a pull request does not have, the
// entry is left out, so a question never points at nothing.
const REFERENCE = /^`([^`]+)`$/

export function pruneAbsentReferences(
  question: Question,
  hasPath: (path: string) => boolean,
): Question {
  const { instructions } = question
  if (instructions === null || typeof instructions !== 'object' || Array.isArray(instructions))
    return question
  const kept = Object.entries(instructions as Record<string, unknown>).filter(([, value]) => {
    const match = typeof value === 'string' ? REFERENCE.exec(value) : null
    return match === null || hasPath(match[1] ?? '')
  })
  if (kept.length === Object.keys(instructions).length) return question
  return { ...question, instructions: Object.fromEntries(kept) }
}
