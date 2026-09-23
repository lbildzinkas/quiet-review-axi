import { z } from 'zod'

// Answer shapes from the Jev guide 2.3.
const noulAnswer = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) })
const choiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
})
const scoreAnswer = z.object({
  type: z.literal('score'),
  score: z.number(),
  confidence: z.number().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
  legend: z.record(z.string(), z.unknown()).optional(),
})

export const answerSchema = z.discriminatedUnion('type', [noulAnswer, choiceAnswer, scoreAnswer])
export type Answer = z.infer<typeof answerSchema>
export type NoulAnswer = z.infer<typeof noulAnswer>
export type ChoiceAnswer = z.infer<typeof choiceAnswer>
export type ScoreAnswer = z.infer<typeof scoreAnswer>

export const responseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().optional(),
    cost: z.number().optional(),
  }),
})

export type JevResponse = z.infer<typeof responseSchema>
