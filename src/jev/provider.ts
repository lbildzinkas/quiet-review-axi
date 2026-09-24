import { QuietReviewError } from '../errors.js'
import type { Question } from '../core/questions.js'
import { postJson, type PostOptions } from './post.js'
import { answerSchema, responseSchema, type Answer, type JevResponse } from './schema.js'

export type ProviderName = 'openrouter' | 'typesafe'
export type { FetchLike } from './post.js'

export interface JevQuestions {
  state: unknown
  questions: Record<string, Question>
}

export interface JevResult {
  answers: Record<string, Answer>
  snapshot: string
  responseId?: string
  inputTokens: number
  costUsd: number
  costSource: 'reported' | 'computed'
  retries: number
  response: JevResponse
}

export type DecideOptions = PostOptions

export interface JevProvider {
  name: ProviderName
  model: string
  endpoint: string
  keyEnv: string
  buildBody(request: JevQuestions): Record<string, unknown>
  decide(request: JevQuestions, options: DecideOptions): Promise<JevResult>
}

// Jev list price: USD per input token; output is free (Jev guide 2.11).
export const JEV_PRICE_PER_INPUT_TOKEN = 0.042 / 1_000_000

interface ProviderDefinition {
  name: ProviderName
  model: string
  endpoint: string
  keyEnv: string
  extraBody: Record<string, unknown>
  reportsCost: boolean
}

export function defineProvider(definition: ProviderDefinition): JevProvider {
  function buildBody(request: JevQuestions) {
    return {
      model: definition.model,
      state: request.state,
      questions: request.questions,
      ...definition.extraBody,
    }
  }

  async function decide(request: JevQuestions, options: DecideOptions): Promise<JevResult> {
    const { payload, retries } = await postJson(
      { name: definition.name, endpoint: definition.endpoint, keyEnv: definition.keyEnv },
      JSON.stringify(buildBody(request)),
      options,
    )
    return toResult(payload, request, retries)
  }

  function toResult(payload: unknown, request: JevQuestions, retries: number): JevResult {
    const parsed = validateResponse(payload, request.questions)
    const reported = definition.reportsCost ? parsed.response.usage.cost : undefined
    return {
      ...parsed,
      costUsd: reported ?? parsed.inputTokens * JEV_PRICE_PER_INPUT_TOKEN,
      costSource: reported === undefined ? 'computed' : 'reported',
      retries,
    }
  }

  return { ...definition, buildBody, decide }
}

// Validates a response against the asked questions (spec 5.5); nothing partial is returned.
export function validateResponse(payload: unknown, questions: Record<string, Question>) {
  const parsed = responseSchema.safeParse(payload)
  if (!parsed.success) throw invalidResponse('the response does not match the Jev response shape')
  const answers: Record<string, Answer> = {}
  for (const [id, question] of Object.entries(questions)) {
    const answer = answerSchema.safeParse(parsed.data.answers[id])
    if (!answer.success) throw invalidResponse(`answer ${id} is missing or malformed`)
    if (answer.data.type !== question.type)
      throw invalidResponse(
        `answer ${id} is a ${answer.data.type}, but a ${question.type} was asked`,
      )
    answers[id] = answer.data
  }
  return {
    answers,
    snapshot: parsed.data.model,
    responseId: parsed.data.id,
    inputTokens: parsed.data.usage.input_tokens,
    response: parsed.data,
  }
}

function invalidResponse(detail: string) {
  return new QuietReviewError(
    'INVALID_RESPONSE',
    `The provider returned an invalid response: ${detail}`,
  )
}
